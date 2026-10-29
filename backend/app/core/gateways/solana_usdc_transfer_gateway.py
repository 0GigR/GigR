"""The one place the app builds and sends a user's USDC transfer for a brief.

This is the write half of the x402 brief. The read half -- reading a settlement
back from the chain -- lives in ``tatum_solana_transaction_gateway``; nothing
here reads a transaction or verifies a payment, and nothing there can send one.

The client is injected by the composition root and is always
``open_write_client`` from ``app.services.solana_client``: the client bound to
``SOLANA_RPC_URL``. That function has no branch on the Tatum flag, so a transfer
built here cannot reach the Tatum gateway even when every read in the app is
being served by it. This module never constructs a client of its own, which is
what keeps that structural rather than a promise.

Failures are split by what is known about the money, because that is the only
question the caller's user cares about:

* :class:`UsdcTransferDeclined` -- the node refused the transaction, or it could
  not be built at all. Nothing was broadcast and nothing was paid.
* :class:`UsdcTransferUnconfirmed` -- the send raised without a signature. The
  request may or may not have reached the node, so the caller must treat the
  payment as unknown and must never retry it.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Awaitable, Callable

from solana.exceptions import SolanaRpcException
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.rpc.types import TxOpts
from solders.commitment_config import CommitmentConfig
from solders.keypair import Keypair
from solders.message import MessageV0
from solders.pubkey import Pubkey
from solders.signature import Signature
from solders.transaction import VersionedTransaction
from spl.token.constants import TOKEN_PROGRAM_ID
from spl.token.instructions import (
    TransferCheckedParams,
    create_associated_token_account,
    get_associated_token_address,
    transfer_checked,
)

logger = logging.getLogger(__name__)

# Reasons this layer can detect itself. The purchase service turns each into the
# user-facing sentence it owns.
INSUFFICIENT_USDC = "insufficient_usdc"
INSUFFICIENT_SOL_FOR_FEES = "insufficient_sol_for_fees"
TRANSFER_DECLINED = "transfer_declined"
SUBMISSION_UNCONFIRMED = "submission_unconfirmed"
WALLET_BALANCE_UNAVAILABLE = "wallet_balance_unavailable"

# How long a submitted transfer is watched before the answer stops waiting. The
# signature is kept either way, so this is "not confirmed yet", never "failed".
CONFIRMATION_TIMEOUT_SECONDS = 30.0
CONFIRMATION_POLL_SECONDS = 1.5

# USDC has six decimals on Solana; every amount in this module is atomic units.
USDC_DECIMALS = 6

# One signature costs 5000 lamports. A transfer that cannot pay even that is
# refused by the node, so it is refused here first with a reason the user can act
# on. Creating a missing recipient token account costs rent on top of this and is
# left to the node's preflight, which refuses before broadcast.
FEE_RESERVE_LAMPORTS = 5_000

CONFIRMED = "confirmed"
FAILED = "failed"
TIMEOUT = "timeout"
UNKNOWN = "unknown"


@dataclass(frozen=True)
class WalletBalances:
    """What the payer holds right now: USDC atomic units and lamports."""

    usdc_atomic: int
    lamports: int


@dataclass(frozen=True)
class ConfirmationOutcome:
    """What the node said about one submitted signature.

    ``confirmation`` is one of ``confirmed``, ``failed``, ``timeout`` or
    ``unknown``. ``failed`` means the transaction is on chain and errored, so it
    moved no tokens. ``unknown`` means the status could not be read at all, which
    is not the same as "not submitted".
    """

    confirmation: str
    error: str | None = None


class UsdcTransferError(Exception):
    """Base for a transfer failure, carrying the reason the caller reports."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


class UsdcTransferReadError(UsdcTransferError):
    """The wallet's balances could not be read, so nothing was attempted."""


class UsdcTransferDeclined(UsdcTransferError):
    """The node refused the transaction before broadcast. Nothing was paid."""


class UsdcTransferUnconfirmed(UsdcTransferError):
    """The send raised without a signature. The transfer may be on chain."""


def _rpc_detail(exc: Exception) -> str:
    """Everything the RPC error says, across the chain solana-py builds.

    solana-py raises ``SolanaRpcException`` whose own message only names the
    endpoint and the request; the node's actual refusal (the simulation log with
    the program error) is on the chained ``RPCException``. Reading the chain is
    what lets the two refusals a user can act on be told apart.
    """
    parts: list[str] = [str(exc)]
    cause = exc.__cause__ or exc.__context__
    while cause is not None:
        parts.append(str(cause))
        for argument in getattr(cause, "args", ()):
            parts.append(str(argument))
            message = getattr(argument, "message", None)
            if isinstance(message, str):
                parts.append(message)
        cause = cause.__cause__ or cause.__context__
    return " ".join(parts).lower()


def _decline_reason(exc: SolanaRpcException) -> str:
    """Which refusal the node gave, from the preflight error it returned.

    A JSON-RPC error answer means the node rejected the transaction and did not
    forward it, so this is always a no-money outcome. The two refusals a user can
    act on are named separately: no USDC to move, and no SOL to pay the fee.
    """
    text = _rpc_detail(exc)
    if "insufficient lamports" in text or "insufficient funds for rent" in text:
        return INSUFFICIENT_SOL_FOR_FEES
    if "custom program error: 0x1" in text or "insufficient funds" in text:
        return INSUFFICIENT_USDC
    return TRANSFER_DECLINED


class SolanaUsdcTransferGateway:
    """Build, sign, send and watch one SPL USDC transfer.

    ``client_factory`` receives an operation label and returns an
    :class:`AsyncClient` on the write cluster. The composition root passes
    ``open_write_client``; a test passes a fake that never leaves the process.
    """

    def __init__(
        self,
        *,
        client_factory: Callable[[str], AsyncClient],
        mint: str,
        operation: str = "agent_brief_purchase",
        confirmation_timeout_seconds: float = CONFIRMATION_TIMEOUT_SECONDS,
        poll_interval_seconds: float = CONFIRMATION_POLL_SECONDS,
        sleep: Callable[[float], Awaitable[None]] | None = None,
    ) -> None:
        self._client_factory = client_factory
        self._mint = mint
        self._operation = operation
        self._confirmation_timeout = confirmation_timeout_seconds
        self._poll_interval = poll_interval_seconds
        self._sleep = sleep or asyncio.sleep

    async def read_wallet_balances(self, *, owner: Pubkey) -> WalletBalances:
        """The payer's USDC and lamport balances, or a typed read failure.

        A missing USDC token account is zero USDC, not a failure: that is exactly
        the state of a wallet that has never been funded. Any other RPC error is
        a read failure, so a broken endpoint is never reported as "no USDC".
        """
        client = self._client_factory(self._operation)
        try:
            lamports = (await client.get_balance(owner)).value
            usdc = 0
            ata = get_associated_token_address(owner, Pubkey.from_string(self._mint))
            try:
                balance = await client.get_token_account_balance(ata)
                usdc = int(balance.value.amount)
            except SolanaRpcException as exc:
                if "could not find" not in _rpc_detail(exc):
                    raise
                usdc = 0
            return WalletBalances(usdc_atomic=usdc, lamports=lamports)
        except Exception as exc:  # noqa: BLE001 - any read failure refuses the purchase
            logger.warning(
                "[agent-brief-purchase] could not read wallet balances for %s: %s",
                owner,
                type(exc).__name__,
            )
            raise UsdcTransferReadError(WALLET_BALANCE_UNAVAILABLE) from None
        finally:
            await client.close()

    async def send_usdc_transfer(
        self,
        *,
        payer: Keypair,
        recipient: str,
        amount_atomic: int,
    ) -> str:
        """Send ``amount_atomic`` USDC from ``payer`` to ``recipient``.

        Returns the settlement signature the node accepted. Raises
        :class:`UsdcTransferDeclined` when nothing was broadcast, and
        :class:`UsdcTransferUnconfirmed` when the send may have been broadcast
        but no signature came back. The caller must not retry the second.
        """
        client = self._client_factory(self._operation)
        try:
            try:
                transaction = await self._build_transfer(
                    client,
                    payer=payer,
                    recipient=recipient,
                    amount_atomic=amount_atomic,
                )
            except UsdcTransferReadError:
                raise
            except Exception as exc:  # noqa: BLE001 - a build failure sends nothing
                logger.error(
                    "[agent-brief-purchase] could not build the transfer for %s: %s",
                    payer.pubkey(),
                    type(exc).__name__,
                )
                raise UsdcTransferDeclined(TRANSFER_DECLINED) from None

            try:
                response = await client.send_transaction(
                    transaction,
                    opts=TxOpts(
                        skip_preflight=False, preflight_commitment=Confirmed
                    ),
                )
            except SolanaRpcException as exc:
                # The node answered with an error, which means it did not accept
                # the transaction: a JSON-RPC error is a refusal, not a receipt.
                raise UsdcTransferDeclined(_decline_reason(exc)) from None
            except Exception as exc:  # noqa: BLE001 - the request may have arrived
                logger.warning(
                    "[agent-brief-purchase] send raised without a signature: %s",
                    type(exc).__name__,
                )
                raise UsdcTransferUnconfirmed(SUBMISSION_UNCONFIRMED) from None
            return str(response.value)
        finally:
            await client.close()

    async def wait_for_confirmation(self, signature: str) -> ConfirmationOutcome:
        """Watch one signature until it is confirmed, fails, or the window ends.

        The status is read at the client's commitment, which is the library's
        finalized default, so a confirmed answer is safe to verify against. A
        read that fails is reported as ``unknown``: the caller keeps the
        signature and asks the user to check again rather than calling the
        payment lost.
        """
        client = self._client_factory(self._operation)
        deadline = time.monotonic() + self._confirmation_timeout
        try:
            while True:
                try:
                    response = await client.get_signature_statuses(
                        [Signature.from_string(signature)]
                    )
                    statuses = response.value
                    status = statuses[0] if statuses else None
                except Exception as exc:  # noqa: BLE001 - unknown, not failed
                    logger.warning(
                        "[agent-brief-purchase] could not read the status of %s: %s",
                        signature,
                        type(exc).__name__,
                    )
                    return ConfirmationOutcome(confirmation=UNKNOWN)
                if status is not None:
                    if status.err is not None:
                        return ConfirmationOutcome(
                            confirmation=FAILED, error=str(status.err)
                        )
                    if status.satisfies_commitment(CommitmentConfig.confirmed()):
                        return ConfirmationOutcome(confirmation=CONFIRMED)
                if time.monotonic() >= deadline:
                    return ConfirmationOutcome(confirmation=TIMEOUT)
                await self._sleep(self._poll_interval)
        finally:
            await client.close()

    async def _build_transfer(
        self,
        client: AsyncClient,
        *,
        payer: Keypair,
        recipient: str,
        amount_atomic: int,
    ) -> VersionedTransaction:
        """The signed transaction: create the destination account if needed, pay.

        Both instructions are in one transaction, so the account creation and the
        payment are atomic: there is no state where the recipient has an empty
        account and the payer has been charged for it.
        """
        mint = Pubkey.from_string(self._mint)
        destination_owner = Pubkey.from_string(recipient)
        source = get_associated_token_address(payer.pubkey(), mint)
        destination = get_associated_token_address(destination_owner, mint)

        instructions = []
        existing = await client.get_account_info(destination)
        if existing.value is None:
            instructions.append(
                create_associated_token_account(
                    payer=payer.pubkey(),
                    owner=destination_owner,
                    mint=mint,
                )
            )
        instructions.append(
            transfer_checked(
                TransferCheckedParams(
                    program_id=TOKEN_PROGRAM_ID,
                    source=source,
                    mint=mint,
                    dest=destination,
                    owner=payer.pubkey(),
                    amount=amount_atomic,
                    decimals=USDC_DECIMALS,
                    # No multisig: the owner is the only signer, and the
                    # instruction builder marks it as one.
                    signers=[],
                )
            )
        )

        blockhash = (await client.get_latest_blockhash()).value.blockhash
        message = MessageV0.try_compile(
            payer=payer.pubkey(),
            instructions=instructions,
            address_lookup_table_accounts=[],
            recent_blockhash=blockhash,
        )
        return VersionedTransaction(message, [payer])
