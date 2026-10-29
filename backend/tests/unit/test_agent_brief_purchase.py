"""The in-app purchase of the paid agent brief: pay, confirm, verify, retry.

Three properties are what this file exists for.

The first is the money rule the user must never see broken: an answer may say
"nothing was charged" only when nothing was submitted, and may say "paid" only
when the node confirmed the transfer and the existing judge accepted it. A
signature is in every answer where one exists, including the answers that are
not a success.

The second is that a double tap cannot pay twice. The ``(user, job)`` pair is
claimed before anything is built, and a tap that loses the claim resumes the
attempt it finds instead of sending a second transfer.

The third is that the transfer goes out through the existing write client. The
wiring test builds the gateway from the composition root with
``open_write_client`` replaced by a spy, and the transaction it sends is decoded
here: the right mint, the right amount and the right recipient, signed by the
user's key.

Nothing here touches the network, the database, or a real key. The RPC client is
a fake that answers with solders values, and the ledger seam is replaced at the
module attribute the service reads, as the brief tests already do.
"""

from __future__ import annotations

import json
import struct
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from solders.hash import Hash
from solders.keypair import Keypair
from solders.signature import Signature
from solana.exceptions import SolanaRpcException

import app.core.container as container
import app.core.gateways.solana_usdc_transfer_gateway as transfer_module
import app.services.agent_brief_purchase_service as purchase_module
import app.services.agent_brief_service as brief_module
from app.api.v1.endpoints import agent_brief as router_module
from app.core.config import settings
from app.core.dependencies import get_current_user, get_db
from app.core.gateways.tatum_solana_transaction_gateway import (
    SolanaTransaction,
    TokenBalanceDelta,
)
from app.core.gateways.solana_usdc_transfer_gateway import (
    CONFIRMED,
    FAILED,
    INSUFFICIENT_SOL_FOR_FEES,
    INSUFFICIENT_USDC,
    SUBMISSION_UNCONFIRMED,
    TIMEOUT,
    TRANSFER_DECLINED,
    UNKNOWN,
    WALLET_BALANCE_UNAVAILABLE,
    ConfirmationOutcome,
    SolanaUsdcTransferGateway,
    UsdcTransferDeclined,
    UsdcTransferReadError,
    UsdcTransferUnconfirmed,
    WalletBalances,
)
from app.crud.agent_brief_purchase import (
    claim_purchase_attempt,
    record_purchase_outcome,
)
from app.models.agent_brief_purchase import (
    PURCHASE_DECLINED,
    PURCHASE_PAID,
    PURCHASE_REFUSED,
    PURCHASE_SUBMITTED,
    PURCHASE_SUBMITTING,
    PURCHASE_UNCONFIRMED,
)
from app.models.job import Job
from app.models.user import User
from app.services.agent_brief_purchase_service import (
    BRIEF_NOT_FOUND,
    CONFIRMATION_TIMEOUT,
    FEATURE_DISABLED,
    NO_WALLET,
    PAYMENT_CONFIRMED,
    PAYMENT_NONE,
    PAYMENT_SUBMITTED,
    PAYMENT_UNKNOWN,
    PURCHASE_IN_PROGRESS,
    PURCHASE_UNAVAILABLE,
    WALLET_UNAVAILABLE,
    PurchaseStatus,
    purchase_message,
)
from app.services.agent_brief_service import (
    TRANSACTION_FAILED,
    VERIFICATION_UNAVAILABLE,
    WRONG_MINT,
    AgentBrief,
    BriefPaymentPolicy,
    BriefResult,
    BriefStatus,
    PaymentRequirement,
)

USER_ID = UUID("11111111-2222-4333-8444-555555555555")
JOB_ID = UUID("c4d5e6f7-0a1b-4c2d-8e3f-4a5b6c7d8e9f")
CLIENT_ID = UUID("0b7f9a52-1c4d-4e88-9f31-2a1c5d6e7f80")
PROVIDER_ID = UUID("9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f")
CATEGORY_ID = UUID("7f3a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c")
PURCHASE_ID = UUID("22222222-3333-4444-8555-666666666666")

USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
OTHER_MINT = "So11111111111111111111111111111111111111112"
PAY_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
PAID_ATOMIC = 10000
EXPIRES_SECONDS = 300
FIXED_NOW = datetime(2026, 10, 29, 12, 0, tzinfo=timezone.utc)
RESOURCE = f"http://test/api/v1/agent/brief/purchase?job_id={JOB_ID}"

# A signature-shaped string that is also a valid base58 value: 64 ones.
SENT_SIGNATURE = "1" * 64

# A throwaway keypair generated in-process. It is never funded, never stored, and
# is the only "wallet" these tests have.
KEYPAIR = Keypair()


def make_user(*, wallet_public_key: str | None = None) -> User:
    """A user row with the columns this path reads."""
    return User(
        id=USER_ID,
        email="buyer@example.test",
        display_name="Buyer",
        wallet_public_key=(
            str(KEYPAIR.pubkey()) if wallet_public_key is None else wallet_public_key
        ),
    )


def make_job(**overrides) -> Job:
    job = Job(
        id=JOB_ID,
        client_id=CLIENT_ID,
        provider_id=PROVIDER_ID,
        category_id=CATEGORY_ID,
        title="Fix the leaking kitchen sink",
        description="Water under the cabinet after every use.",
        status="open",
        price=Decimal("120.00"),
    )
    for key, value in overrides.items():
        setattr(job, key, value)
    return job


def make_brief() -> AgentBrief:
    return AgentBrief(
        job_id=JOB_ID,
        title="Fix the leaking kitchen sink",
        job_status="open",
        posted_price=Decimal("120.00"),
        provider_id=PROVIDER_ID,
        ratings_count=2,
        ratings_average=4.5,
        ratings_distribution={4: 1, 5: 1},
        completed_jobs=3,
        comparable_jobs=5,
        comparable_min=Decimal("80.00"),
        comparable_max=Decimal("200.00"),
        comparable_average=Decimal("140.00"),
        disputes_total=2,
        disputes_open=1,
        disputes_resolved=1,
        has_history=True,
        summary="Provider history: 3 completed jobs, an average rating of 4.50.",
    )


def make_requirement() -> PaymentRequirement:
    return PaymentRequirement(
        scheme="exact",
        network=NETWORK,
        mint=USDC_MINT,
        amount_atomic=PAID_ATOMIC,
        pay_to=PAY_TO,
        resource=RESOURCE,
        nonce="nonce-fixed",
        expires_at=FIXED_NOW + timedelta(seconds=EXPIRES_SECONDS),
        expires_seconds=EXPIRES_SECONDS,
    )


def make_policy() -> BriefPaymentPolicy:
    return BriefPaymentPolicy(
        mint=USDC_MINT,
        pay_to=PAY_TO,
        amount_atomic=PAID_ATOMIC,
        network=NETWORK,
        expires_seconds=EXPIRES_SECONDS,
    )


class FakeTransferGateway:
    """The chain seam: balances, one send, and one confirmation answer."""

    def __init__(
        self,
        *,
        balances: WalletBalances | BaseException | None = None,
        send: str | BaseException | None = None,
        confirmation: ConfirmationOutcome | BaseException | None = None,
    ) -> None:
        self.balances = (
            WalletBalances(usdc_atomic=PAID_ATOMIC, lamports=10_000_000)
            if balances is None
            else balances
        )
        self.send = SENT_SIGNATURE if send is None else send
        self.confirmation = (
            ConfirmationOutcome(confirmation=CONFIRMED)
            if confirmation is None
            else confirmation
        )
        self.balance_reads: list[object] = []
        self.sent: list[dict] = []
        self.confirmations: list[str] = []

    async def read_wallet_balances(self, *, owner):
        self.balance_reads.append(owner)
        if isinstance(self.balances, BaseException):
            raise self.balances
        return self.balances

    async def send_usdc_transfer(self, *, payer, recipient, amount_atomic):
        self.sent.append(
            {"payer": payer, "recipient": recipient, "amount_atomic": amount_atomic}
        )
        if isinstance(self.send, BaseException):
            raise self.send
        return self.send

    async def wait_for_confirmation(self, signature):
        self.confirmations.append(signature)
        if isinstance(self.confirmation, BaseException):
            raise self.confirmation
        return self.confirmation


class FakeBriefService:
    """The read path: the brief a verified payment returns."""

    def __init__(self, result: BriefResult | BaseException | None = None) -> None:
        self.result = result or BriefResult(
            status=BriefStatus.PAID,
            brief=make_brief(),
            requirement=make_requirement(),
        )
        self.reads: list[tuple] = []
        self.built = 0

    async def read_brief(self, job_id, signature, resource):
        self.reads.append((job_id, signature, resource))
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result

    async def build_brief(self, job):
        self.built += 1
        return make_brief()

    def payment_requirement(self, job_id, resource):
        return make_requirement()


def make_service(
    *,
    transfers: FakeTransferGateway | None = None,
    briefs: FakeBriefService | None = None,
    keypair_error: BaseException | None = None,
):
    """A purchase service over fakes, with a real throwaway key for the payer."""
    transfers = transfers or FakeTransferGateway()
    briefs = briefs or FakeBriefService()

    def keypair_for(user):
        if keypair_error is not None:
            raise keypair_error
        return KEYPAIR

    service = purchase_module.AgentBriefPurchaseService(
        object(),
        briefs=briefs,
        transfers=transfers,
        policy=make_policy(),
        keypair_for=keypair_for,
    )
    return service, transfers, briefs


def install_ledger(
    monkeypatch,
    *,
    claim_ids=(PURCHASE_ID,),
    attempt=None,
    job=make_job(),
):
    """Replace the purchase ledger and the job read at the service's own seam.

    Returns ``(claims, records)``: what was claimed and what state was written,
    so a test asserts on the outcome instead of on a mock's shape.
    """
    claims: list[tuple] = []
    records: list[dict] = []
    ids = list(claim_ids)

    async def fake_get_job(db, job_id):
        return job

    async def fake_claim(db, *, user_id, job_id):
        claims.append((user_id, job_id))
        return ids.pop(0) if ids else None

    async def fake_attempt(db, *, user_id, job_id):
        return attempt

    async def fake_record(db, *, purchase_id, state, signature=None, reason=None):
        records.append(
            {
                "purchase_id": purchase_id,
                "state": state,
                "signature": signature,
                "reason": reason,
            }
        )

    monkeypatch.setattr(purchase_module, "get_job_by_id", fake_get_job)
    monkeypatch.setattr(purchase_module, "claim_purchase_attempt", fake_claim)
    monkeypatch.setattr(purchase_module, "get_purchase_attempt", fake_attempt)
    monkeypatch.setattr(purchase_module, "record_purchase_outcome", fake_record)
    return claims, records


def make_attempt(state: str, *, signature: str | None = None, reason: str | None = None):
    return SimpleNamespace(
        id=PURCHASE_ID, state=state, signature=signature, reason=reason
    )


# -- The money sentence ------------------------------------------------------
# The most important rule in the feature: after a transfer exists, no answer may
# say nothing was charged.


@pytest.mark.parametrize(
    "payment_state, expected, forbidden",
    [
        (PAYMENT_NONE, "Nothing was charged.", "signature is below"),
        (PAYMENT_SUBMITTED, "signature is below", "Nothing was charged"),
        (PAYMENT_CONFIRMED, "confirmed on the Solana network", "Nothing was charged"),
        (PAYMENT_UNKNOWN, "may have been sent", "Nothing was charged"),
    ],
)
def test_the_money_sentence_follows_what_is_known(payment_state, expected, forbidden):
    message = purchase_message(
        INSUFFICIENT_USDC,
        payment_state=payment_state,
        required_atomic=PAID_ATOMIC,
        available_atomic=0,
    )

    assert expected in message
    assert forbidden not in message


def test_the_insufficient_usdc_message_names_both_amounts():
    """A user with no USDC is told that, in USDC, not given a generic failure."""
    message = purchase_message(
        INSUFFICIENT_USDC,
        payment_state=PAYMENT_NONE,
        required_atomic=PAID_ATOMIC,
        available_atomic=0,
    )

    assert "holds 0 USDC" in message
    assert "costs 0.01 USDC" in message
    assert "Add USDC" in message


# -- The transfer on the wire ------------------------------------------------


class FakeRpcResponse:
    def __init__(self, value) -> None:
        self.value = value


class FakeRpcClient:
    """The RPC seam: answers with solders values, records what was sent."""

    def __init__(
        self,
        *,
        send=None,
        statuses=None,
        token_balance=PAID_ATOMIC,
        lamports=10_000_000,
        destination_exists=True,
    ) -> None:
        self.sent: list[dict] = []
        self.closed = 0
        self._send = send
        self._statuses = list(statuses or [None])
        self._token_balance = token_balance
        self._lamports = lamports
        self._destination_exists = destination_exists

    async def get_balance(self, owner):
        return FakeRpcResponse(self._lamports)

    async def get_token_account_balance(self, ata):
        if isinstance(self._token_balance, BaseException):
            raise self._token_balance
        return FakeRpcResponse(SimpleNamespace(amount=str(self._token_balance)))

    async def get_account_info(self, pubkey):
        return FakeRpcResponse(object() if self._destination_exists else None)

    async def get_latest_blockhash(self):
        return FakeRpcResponse(SimpleNamespace(blockhash=Hash.default()))

    async def send_transaction(self, transaction, opts=None):
        self.sent.append({"transaction": transaction, "opts": opts})
        if isinstance(self._send, BaseException):
            raise self._send
        return FakeRpcResponse(Signature.from_string(SENT_SIGNATURE))

    async def get_signature_statuses(self, signatures):
        status = self._statuses.pop(0) if self._statuses else None
        return FakeRpcResponse([status])

    async def close(self):
        self.closed += 1


def transaction_status(*, err=None, confirmation_status="finalized"):
    from solders.transaction_status import TransactionStatus

    payload = {
        "slot": 1,
        "confirmations": None,
        "err": err,
        "confirmationStatus": confirmation_status,
        "status": {"Ok": None} if err is None else {"Err": err},
    }
    return TransactionStatus.from_json(json.dumps(payload))


def make_transfer_gateway(client: FakeRpcClient, **overrides):
    operations: list[str] = []

    def factory(operation):
        operations.append(operation)
        return client

    gateway = SolanaUsdcTransferGateway(
        client_factory=factory,
        mint=USDC_MINT,
        sleep=lambda seconds: _no_sleep(),
        **overrides,
    )
    return gateway, operations


async def _no_sleep():
    return None


def transfer_instructions(transaction):
    """The compiled instructions and account keys of a sent transaction."""
    message = transaction.message
    return message.instructions, list(message.account_keys)


def decode_transfer_checked(transaction, index: int):
    """The (source, mint, destination, amount, decimals) of one instruction."""
    instructions, keys = transfer_instructions(transaction)
    instruction = instructions[index]
    data = bytes(instruction.data)
    amount = struct.unpack("<Q", data[1:9])[0]
    accounts = list(instruction.accounts)
    return (
        keys[accounts[0]],
        keys[accounts[1]],
        keys[accounts[2]],
        amount,
        data[9],
    )


def rpc_exception(detail: str) -> SolanaRpcException:
    """A node refusal shaped the way solana-py raises one.

    solana-py wraps the parsed JSON-RPC error in an ``RPCException`` and chains
    it under ``SolanaRpcException``, whose own message names only the endpoint.
    The node's refusal text lives on the chained object, so the gateway has to
    read the chain -- and this fixture is what proves it does.
    """
    from solana.rpc.core import RPCException

    class ParsedRpcError:
        def __init__(self, message: str) -> None:
            self.message = message

        def __str__(self) -> str:
            return self.message

    cause = RPCException(ParsedRpcError(detail))
    raised = SolanaRpcException(
        cause, lambda: None, object(), SimpleNamespace()
    )
    raised.__cause__ = cause
    return raised


async def test_the_transfer_moves_the_price_in_usdc_to_the_configured_recipient():
    """The instruction the user signs pays this mint, this amount, to this wallet.

    A transaction that compiled and was sent is not enough: the amount, the mint
    and the destination are what make it a payment for the brief. The signature
    is checked too, because the payer must be the user's key and not the
    platform's.
    """
    from spl.token.instructions import get_associated_token_address
    from solders.pubkey import Pubkey

    client = FakeRpcClient()
    gateway, operations = make_transfer_gateway(client)

    signature = await gateway.send_usdc_transfer(
        payer=KEYPAIR, recipient=PAY_TO, amount_atomic=PAID_ATOMIC
    )

    assert signature == SENT_SIGNATURE
    assert operations == ["agent_brief_purchase"]
    assert len(client.sent) == 1
    sent = client.sent[0]
    assert sent["opts"].skip_preflight is False
    assert sent["opts"].preflight_commitment == "confirmed"

    mint = Pubkey.from_string(USDC_MINT)
    source, mint_key, destination, amount, decimals = decode_transfer_checked(
        sent["transaction"], 0
    )
    assert amount == PAID_ATOMIC
    assert decimals == 6
    assert mint_key == mint
    assert source == get_associated_token_address(KEYPAIR.pubkey(), mint)
    assert destination == get_associated_token_address(
        Pubkey.from_string(PAY_TO), mint
    )
    # One signature, and the fee payer is the user: the transfer is signed by the
    # user's key and not by the platform's.
    assert len(sent["transaction"].signatures) == 1
    assert sent["transaction"].message.account_keys[0] == KEYPAIR.pubkey()
    assert client.closed == 1


async def test_a_missing_recipient_token_account_is_created_in_the_same_transaction():
    """Paying a fresh recipient stays one atomic transaction.

    If the create lived in a separate transaction, a failure between the two
    would leave a paid-for empty account and an unpaid brief.
    """
    client = FakeRpcClient(destination_exists=False)
    gateway, _ = make_transfer_gateway(client)

    await gateway.send_usdc_transfer(
        payer=KEYPAIR, recipient=PAY_TO, amount_atomic=PAID_ATOMIC
    )

    transaction = client.sent[0]["transaction"]
    instructions, _ = transfer_instructions(transaction)
    assert len(instructions) == 2
    # The create has no data; the transfer is the checked token instruction.
    assert len(bytes(instructions[0].data)) == 0
    _, _, _, amount, decimals = decode_transfer_checked(transaction, 1)
    assert amount == PAID_ATOMIC
    assert decimals == 6
    assert len(transaction.signatures) == 1
    assert transaction.message.account_keys[0] == KEYPAIR.pubkey()


async def test_a_node_refusal_is_declined_with_its_own_reason():
    """A JSON-RPC error means the node did not accept it: no money moved."""
    refusal = rpc_exception(
        "Transaction simulation failed: Error processing Instruction 0: "
        "custom program error: 0x1"
    )
    client = FakeRpcClient(send=refusal)
    gateway, _ = make_transfer_gateway(client)

    with pytest.raises(UsdcTransferDeclined) as raised:
        await gateway.send_usdc_transfer(
            payer=KEYPAIR, recipient=PAY_TO, amount_atomic=PAID_ATOMIC
        )

    assert raised.value.reason == INSUFFICIENT_USDC


async def test_a_missing_fee_balance_is_named_as_a_fee_problem():
    refusal = rpc_exception(
        "Transaction simulation failed: insufficient lamports 0"
    )
    client = FakeRpcClient(send=refusal)
    gateway, _ = make_transfer_gateway(client)

    with pytest.raises(UsdcTransferDeclined) as raised:
        await gateway.send_usdc_transfer(
            payer=KEYPAIR, recipient=PAY_TO, amount_atomic=PAID_ATOMIC
        )

    assert raised.value.reason == INSUFFICIENT_SOL_FOR_FEES


async def test_a_transport_error_is_unconfirmed_not_declined():
    """A send that raised without a signature may have been broadcast.

    Reporting it as declined would tell the user nothing was charged while their
    money may be on its way.
    """
    client = FakeRpcClient(send=RuntimeError("connection reset"))
    gateway, _ = make_transfer_gateway(client)

    with pytest.raises(UsdcTransferUnconfirmed) as raised:
        await gateway.send_usdc_transfer(
            payer=KEYPAIR, recipient=PAY_TO, amount_atomic=PAID_ATOMIC
        )

    assert raised.value.reason == SUBMISSION_UNCONFIRMED


async def test_the_balances_are_read_from_the_usdc_token_account():
    client = FakeRpcClient(token_balance=25000, lamports=7_000_000)
    gateway, _ = make_transfer_gateway(client)

    balances = await gateway.read_wallet_balances(owner=KEYPAIR.pubkey())

    assert balances.usdc_atomic == 25000
    assert balances.lamports == 7_000_000


async def test_a_wallet_with_no_token_account_holds_no_usdc():
    """The common empty-wallet case is zero, not a read failure."""
    client = FakeRpcClient(
        token_balance=rpc_exception("Invalid param: could not find account")
    )
    gateway, _ = make_transfer_gateway(client)

    balances = await gateway.read_wallet_balances(owner=KEYPAIR.pubkey())

    assert balances.usdc_atomic == 0


async def test_another_rpc_error_is_a_read_failure_not_zero_usdc():
    """A broken endpoint must not be reported as an empty wallet."""
    client = FakeRpcClient(token_balance=rpc_exception("internal error"))
    gateway, _ = make_transfer_gateway(client)

    with pytest.raises(UsdcTransferReadError) as raised:
        await gateway.read_wallet_balances(owner=KEYPAIR.pubkey())

    assert raised.value.reason == WALLET_BALANCE_UNAVAILABLE


async def test_confirmation_waits_for_the_signature_to_be_confirmed():
    client = FakeRpcClient(
        statuses=[None, transaction_status(confirmation_status="processed"),
                  transaction_status(confirmation_status="finalized")]
    )
    gateway, _ = make_transfer_gateway(client, confirmation_timeout_seconds=5.0)

    outcome = await gateway.wait_for_confirmation(SENT_SIGNATURE)

    assert outcome.confirmation == CONFIRMED
    assert client.closed == 1


async def test_a_transaction_that_failed_on_chain_is_reported_as_failed():
    client = FakeRpcClient(
        statuses=[
            transaction_status(
                err={"InstructionError": [0, {"Custom": 1}]},
                confirmation_status="finalized",
            )
        ]
    )
    gateway, _ = make_transfer_gateway(client)

    outcome = await gateway.wait_for_confirmation(SENT_SIGNATURE)

    assert outcome.confirmation == FAILED
    assert outcome.error is not None


async def test_a_transfer_that_never_confirms_times_out_without_claiming_failure():
    client = FakeRpcClient(statuses=[None, None, None])
    gateway, _ = make_transfer_gateway(client, confirmation_timeout_seconds=0.0)

    outcome = await gateway.wait_for_confirmation(SENT_SIGNATURE)

    assert outcome.confirmation == TIMEOUT


async def test_an_unreadable_confirmation_is_unknown_not_failed():
    """A read that fails leaves the outcome unknown; the signature is kept."""
    client = FakeRpcClient()

    async def broken(signatures):
        raise RuntimeError("rpc down")

    client.get_signature_statuses = broken
    gateway, _ = make_transfer_gateway(client)

    outcome = await gateway.wait_for_confirmation(SENT_SIGNATURE)

    assert outcome.confirmation == UNKNOWN


# -- The purchase service ----------------------------------------------------


async def test_a_user_with_no_usdc_is_told_they_have_no_usdc(monkeypatch):
    """The required reason, not a generic failure, and no transfer attempted."""
    claims, records = install_ledger(monkeypatch)
    transfers = FakeTransferGateway(
        balances=WalletBalances(usdc_atomic=0, lamports=10_000_000)
    )
    service, transfers, _ = make_service(transfers=transfers)

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.FAILED
    assert result.reason == INSUFFICIENT_USDC
    assert result.payment_state == PAYMENT_NONE
    assert result.signature is None
    assert result.available_atomic == 0
    assert result.required_atomic == PAID_ATOMIC
    assert "holds 0 USDC" in result.message
    assert transfers.sent == []
    assert transfers.confirmations == []
    assert records[-1]["state"] == PURCHASE_DECLINED
    assert claims == [(USER_ID, JOB_ID)]


async def test_one_atomic_unit_short_of_the_price_is_no_usdc_enough(monkeypatch):
    """The comparison is on the atomic amount, not on a rounded float."""
    install_ledger(monkeypatch)
    service, transfers, _ = make_service(
        transfers=FakeTransferGateway(
            balances=WalletBalances(usdc_atomic=PAID_ATOMIC - 1, lamports=10_000_000)
        )
    )

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.reason == INSUFFICIENT_USDC
    assert transfers.sent == []


async def test_exactly_the_price_is_enough(monkeypatch):
    install_ledger(monkeypatch)
    service, transfers, briefs = make_service(
        transfers=FakeTransferGateway(
            balances=WalletBalances(usdc_atomic=PAID_ATOMIC, lamports=10_000_000)
        )
    )

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.PAID
    assert len(transfers.sent) == 1


async def test_a_user_without_a_wallet_is_named_before_anything_is_built(monkeypatch):
    claims, _ = install_ledger(monkeypatch)
    service, transfers, _ = make_service()

    result = await service.purchase_brief(
        user=make_user(wallet_public_key=""), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.FAILED
    assert result.reason == NO_WALLET
    assert result.payment_state == PAYMENT_NONE
    assert claims == []
    assert transfers.balance_reads == []
    assert transfers.sent == []


async def test_a_wallet_that_cannot_be_opened_charges_nothing(monkeypatch):
    claims, _ = install_ledger(monkeypatch)
    service, transfers, _ = make_service(keypair_error=RuntimeError("fernet key wrong"))

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.reason == WALLET_UNAVAILABLE
    assert result.payment_state == PAYMENT_NONE
    assert claims == []
    assert transfers.sent == []


async def test_a_missing_job_is_named_and_charges_nothing(monkeypatch):
    install_ledger(monkeypatch, job=None)
    service, transfers, _ = make_service()

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.FAILED
    assert result.reason == BRIEF_NOT_FOUND
    assert transfers.balance_reads == []
    assert transfers.sent == []


async def test_a_purchase_with_enough_usdc_sends_and_verifies(monkeypatch):
    """The happy path: the price is paid from the user's key, then verified.

    The signature that was sent is the one handed to the existing read path, and
    the ledger recorded the submitted state before the paid one.
    """
    claims, records = install_ledger(monkeypatch)
    service, transfers, briefs = make_service()
    user = make_user()

    result = await service.purchase_brief(
        user=user, job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.PAID
    assert result.reason is None
    assert result.payment_state == PAYMENT_CONFIRMED
    assert result.signature == SENT_SIGNATURE
    assert result.brief is not None
    assert result.brief.job_id == JOB_ID
    assert result.requirement is not None
    assert transfers.sent == [
        {
            "payer": KEYPAIR,
            "recipient": PAY_TO,
            "amount_atomic": PAID_ATOMIC,
        }
    ]
    assert transfers.confirmations == [SENT_SIGNATURE]
    assert briefs.reads == [(JOB_ID, SENT_SIGNATURE, RESOURCE)]
    assert [record["state"] for record in records] == [
        PURCHASE_SUBMITTED,
        PURCHASE_PAID,
    ]
    assert records[0]["signature"] == SENT_SIGNATURE
    assert claims == [(USER_ID, JOB_ID)]


async def test_a_confirmation_timeout_keeps_the_signature_and_is_pending(monkeypatch):
    """Submitted but unconfirmed is never reported as a failure, and never paid.

    The signature is in the answer and the ledger keeps the submitted state, so a
    later tap checks the same transfer instead of sending another.
    """
    _, records = install_ledger(monkeypatch)
    service, transfers, briefs = make_service(
        transfers=FakeTransferGateway(
            confirmation=ConfirmationOutcome(confirmation=TIMEOUT)
        )
    )

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.PENDING
    assert result.reason == CONFIRMATION_TIMEOUT
    assert result.payment_state == PAYMENT_SUBMITTED
    assert result.signature == SENT_SIGNATURE
    assert result.brief is None
    assert "Do not pay again" in result.message
    assert "Nothing was charged" not in result.message
    assert briefs.reads == []
    assert records[-1]["state"] == PURCHASE_SUBMITTED


async def test_a_confirmation_that_cannot_be_read_keeps_the_signature(monkeypatch):
    install_ledger(monkeypatch)
    service, _, _ = make_service(
        transfers=FakeTransferGateway(
            confirmation=ConfirmationOutcome(confirmation=UNKNOWN)
        )
    )

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.PENDING
    assert result.payment_state == PAYMENT_SUBMITTED
    assert result.signature == SENT_SIGNATURE


async def test_a_transaction_that_failed_on_chain_keeps_the_signature(monkeypatch):
    """A failed transfer moved no USDC, so it is a retryable, typed failure."""
    _, records = install_ledger(monkeypatch)
    service, _, briefs = make_service(
        transfers=FakeTransferGateway(
            confirmation=ConfirmationOutcome(confirmation=FAILED, error="custom 1")
        )
    )

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.FAILED
    assert result.reason == TRANSACTION_FAILED
    assert result.payment_state == PAYMENT_CONFIRMED
    assert result.signature == SENT_SIGNATURE
    assert result.brief is None
    assert briefs.reads == []
    assert records[-1]["state"] == PURCHASE_DECLINED


async def test_a_send_that_raised_without_a_signature_is_pending_not_failed(monkeypatch):
    """The most dangerous case: the transfer may be on chain.

    The answer must not say the purchase failed, and the pair must be recorded as
    unconfirmed so nothing sends a second transfer for it.
    """
    _, records = install_ledger(monkeypatch)
    service, transfers, _ = make_service(
        transfers=FakeTransferGateway(send=UsdcTransferUnconfirmed(SUBMISSION_UNCONFIRMED))
    )

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.PENDING
    assert result.reason == SUBMISSION_UNCONFIRMED
    assert result.payment_state == PAYMENT_UNKNOWN
    assert len(transfers.sent) == 1
    assert records[-1]["state"] == PURCHASE_UNCONFIRMED


async def test_a_node_refusal_is_a_typed_failure_with_no_money(monkeypatch):
    _, records = install_ledger(monkeypatch)
    service, transfers, _ = make_service(
        transfers=FakeTransferGateway(
            send=UsdcTransferDeclined(TRANSFER_DECLINED)
        )
    )

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.FAILED
    assert result.reason == TRANSFER_DECLINED
    assert result.payment_state == PAYMENT_NONE
    assert result.signature is None
    assert records[-1]["state"] == PURCHASE_DECLINED


async def test_verification_refusal_keeps_the_signature_and_blocks_a_retry(monkeypatch):
    """The transfer confirmed but did not pay for the brief: money moved.

    The signature is the user's evidence and the pair is refused, so no further
    transfer is sent.
    """
    _, records = install_ledger(monkeypatch)
    briefs = FakeBriefService(
        BriefResult(status=BriefStatus.PAYMENT_REQUIRED, reason=WRONG_MINT)
    )
    service, _, _ = make_service(briefs=briefs)

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.FAILED
    assert result.reason == WRONG_MINT
    assert result.payment_state == PAYMENT_CONFIRMED
    assert result.signature == SENT_SIGNATURE
    assert "confirmed on the Solana network" in result.message
    assert records[-1]["state"] == PURCHASE_REFUSED
    assert records[-1]["signature"] == SENT_SIGNATURE


async def test_a_settlement_that_cannot_be_verified_yet_stays_pending(monkeypatch):
    """Confirmed on chain but the read path cannot see it: do not call it paid."""
    _, records = install_ledger(monkeypatch)
    briefs = FakeBriefService(
        BriefResult(status=BriefStatus.PAYMENT_REQUIRED, reason=VERIFICATION_UNAVAILABLE)
    )
    service, _, _ = make_service(briefs=briefs)

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.PENDING
    assert result.reason == VERIFICATION_UNAVAILABLE
    assert result.payment_state == PAYMENT_SUBMITTED
    assert result.signature == SENT_SIGNATURE
    assert records[-1]["state"] == PURCHASE_SUBMITTED


# -- The double tap ----------------------------------------------------------


async def test_a_purchase_in_flight_does_not_send_a_second_transfer(monkeypatch):
    claims, _ = install_ledger(
        monkeypatch, claim_ids=(None,), attempt=make_attempt(PURCHASE_SUBMITTING)
    )
    service, transfers, _ = make_service()

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.PENDING
    assert result.reason == PURCHASE_IN_PROGRESS
    assert result.payment_state == PAYMENT_UNKNOWN
    assert transfers.sent == []
    assert len(claims) == 1


async def test_a_second_tap_after_submission_checks_the_same_signature(monkeypatch):
    """The tap that loses the claim never sends; it re-checks the first transfer."""
    install_ledger(
        monkeypatch,
        claim_ids=(None,),
        attempt=make_attempt(PURCHASE_SUBMITTED, signature=SENT_SIGNATURE),
    )
    service, transfers, briefs = make_service()

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.PAID
    assert result.signature == SENT_SIGNATURE
    assert transfers.sent == []
    assert transfers.confirmations == [SENT_SIGNATURE]
    assert briefs.reads == [(JOB_ID, SENT_SIGNATURE, RESOURCE)]


async def test_a_second_tap_after_a_paid_purchase_serves_the_brief_free(monkeypatch):
    """A paid pair gets its brief again, without a payment or a new ledger claim."""
    claims, _ = install_ledger(
        monkeypatch,
        claim_ids=(None,),
        attempt=make_attempt(
            PURCHASE_PAID, signature=SENT_SIGNATURE, reason=None
        ),
    )
    briefs = FakeBriefService()
    service, transfers, _ = make_service(briefs=briefs)

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.PAID
    assert result.already_purchased is True
    assert result.signature == SENT_SIGNATURE
    assert result.brief is not None
    assert briefs.built == 1
    assert briefs.reads == []
    assert transfers.sent == []
    assert len(claims) == 1


async def test_a_second_tap_after_an_unconfirmed_send_does_not_send(monkeypatch):
    """An unconfirmed send blocks every later tap; only a human can resolve it."""
    install_ledger(
        monkeypatch,
        claim_ids=(None,),
        attempt=make_attempt(PURCHASE_UNCONFIRMED, reason=SUBMISSION_UNCONFIRMED),
    )
    service, transfers, _ = make_service()

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.PENDING
    assert result.payment_state == PAYMENT_UNKNOWN
    assert result.signature is None
    assert transfers.sent == []


async def test_a_second_tap_after_a_refusal_does_not_send(monkeypatch):
    install_ledger(
        monkeypatch,
        claim_ids=(None,),
        attempt=make_attempt(
            PURCHASE_REFUSED, signature=SENT_SIGNATURE, reason=WRONG_MINT
        ),
    )
    service, transfers, _ = make_service()

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.FAILED
    assert result.reason == WRONG_MINT
    assert result.signature == SENT_SIGNATURE
    assert transfers.sent == []


# -- The ledger claim --------------------------------------------------------


class FakeLedgerResult:
    def __init__(self, value) -> None:
        self._value = value

    def scalar_one_or_none(self):
        return self._value


class FakeLedgerSession:
    """Records each statement and how many commits happened before returning."""

    def __init__(self, returned=PURCHASE_ID) -> None:
        self.statements: list = []
        self.commits = 0
        self._returned = returned

    async def execute(self, statement):
        self.statements.append(statement)
        return FakeLedgerResult(self._returned)

    async def commit(self) -> None:
        self.commits += 1


async def test_the_purchase_claim_is_one_conflict_ignoring_upsert():
    """The database, not Python, decides which tap owns the pair."""
    session = FakeLedgerSession()

    claimed = await claim_purchase_attempt(session, user_id=USER_ID, job_id=JOB_ID)

    assert claimed == PURCHASE_ID
    statement = str(session.statements[0])
    assert "INSERT INTO agent_brief_purchases" in statement
    assert "ON CONFLICT (user_id, job_id) DO UPDATE" in statement
    # Only an attempt that provably paid nothing may be taken over.
    assert "agent_brief_purchases.state IN" in statement
    assert session.commits == 1


async def test_a_lost_claim_reports_no_purchase():
    session = FakeLedgerSession(returned=None)

    claimed = await claim_purchase_attempt(session, user_id=USER_ID, job_id=JOB_ID)

    assert claimed is None


async def test_recording_an_outcome_writes_the_state_and_the_signature():
    session = FakeLedgerSession()

    await record_purchase_outcome(
        session,
        purchase_id=PURCHASE_ID,
        state=PURCHASE_SUBMITTED,
        signature=SENT_SIGNATURE,
    )

    statement = str(session.statements[0])
    assert "UPDATE agent_brief_purchases" in statement
    params = session.statements[0].compile().params
    assert PURCHASE_SUBMITTED in params.values()
    assert SENT_SIGNATURE in params.values()
    assert session.commits == 1


async def test_recording_a_later_outcome_keeps_the_recorded_signature():
    """A state that adds no signature must not erase the one already recorded."""
    session = FakeLedgerSession()

    await record_purchase_outcome(
        session, purchase_id=PURCHASE_ID, state=PURCHASE_DECLINED, reason="transient"
    )

    statement = str(session.statements[0])
    assert "signature" not in statement


# -- The router --------------------------------------------------------------


def enable_flag(monkeypatch) -> None:
    monkeypatch.setattr(settings, "FEATURE_X402_AGENT_BRIEF", True)
    monkeypatch.setattr(settings, "USDC_MINT_DEVNET", USDC_MINT)
    monkeypatch.setattr(settings, "X402_AGENT_BRIEF_PAY_TO", PAY_TO)
    monkeypatch.setattr(settings, "X402_AGENT_BRIEF_PRICE_ATOMIC", PAID_ATOMIC)
    monkeypatch.setattr(settings, "X402_AGENT_BRIEF_EXPIRES_SECONDS", EXPIRES_SECONDS)


class FakePurchaseService:
    def __init__(self, result) -> None:
        self.result = result
        self.calls: list[dict] = []

    async def purchase_brief(self, *, user, job_id, resource):
        self.calls.append({"user": user, "job_id": job_id, "resource": resource})
        if isinstance(self.result, BaseException):
            raise self.result
        return self.result


def install_purchase_service(monkeypatch, result):
    service = FakePurchaseService(result)
    monkeypatch.setattr(
        router_module, "build_agent_brief_purchase_service", lambda db: service
    )
    return service


def build_app(*, authenticated: bool = True) -> FastAPI:
    app = FastAPI()
    app.include_router(router_module.router, prefix="/api/v1/agent")
    app.dependency_overrides[get_db] = lambda: object()
    if authenticated:
        app.dependency_overrides[get_current_user] = lambda: make_user()
    return app


@pytest.fixture
async def api():
    async with AsyncClient(
        transport=ASGITransport(app=build_app()), base_url="http://test"
    ) as client:
        yield client


PURCHASE_URL = f"/api/v1/agent/brief/purchase?job_id={JOB_ID}"


def paid_result(**overrides) -> purchase_module.PurchaseResult:
    fields = {
        "status": PurchaseStatus.PAID,
        "reason": None,
        "message": "The brief is yours.",
        "payment_state": PAYMENT_CONFIRMED,
        "signature": SENT_SIGNATURE,
        "brief": make_brief(),
        "requirement": make_requirement(),
    }
    fields.update(overrides)
    return purchase_module.PurchaseResult(**fields)


async def test_the_purchase_route_requires_authentication(monkeypatch):
    """A stranger cannot make the app sign a payment for a wallet."""
    enable_flag(monkeypatch)
    install_purchase_service(monkeypatch, paid_result())

    async with AsyncClient(
        transport=ASGITransport(app=build_app(authenticated=False)),
        base_url="http://test",
    ) as anonymous:
        response = await anonymous.post(PURCHASE_URL)

    assert response.status_code == 401


async def test_a_purchase_returns_the_existing_paid_brief_body(monkeypatch, api):
    """The 200 is the paid-brief shape, plus whether this tap charged again."""
    enable_flag(monkeypatch)
    service = install_purchase_service(monkeypatch, paid_result())

    response = await api.post(PURCHASE_URL)

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "paid"
    assert body["payment"]["signature"] == SENT_SIGNATURE
    assert body["payment"]["amount_atomic"] == PAID_ATOMIC
    assert body["payment"]["pay_to"] == PAY_TO
    assert body["brief"]["job_id"] == str(JOB_ID)
    assert body["brief"]["summary"] == make_brief().summary
    assert body["already_purchased"] is False
    assert service.calls[0]["job_id"] == JOB_ID
    assert service.calls[0]["user"].id == USER_ID


async def test_a_replayed_purchase_says_it_was_not_charged_again(monkeypatch, api):
    enable_flag(monkeypatch)
    install_purchase_service(monkeypatch, paid_result(already_purchased=True))

    response = await api.post(PURCHASE_URL)

    assert response.status_code == 200
    assert response.json()["already_purchased"] is True


async def test_no_usdc_is_402_with_its_own_reason(monkeypatch, api):
    """The client can tell "you have no USDC" from every other failure."""
    enable_flag(monkeypatch)
    install_purchase_service(
        monkeypatch,
        purchase_module.PurchaseResult(
            status=PurchaseStatus.FAILED,
            reason=INSUFFICIENT_USDC,
            message=purchase_message(
                INSUFFICIENT_USDC,
                payment_state=PAYMENT_NONE,
                required_atomic=PAID_ATOMIC,
                available_atomic=0,
            ),
            payment_state=PAYMENT_NONE,
            required_atomic=PAID_ATOMIC,
            available_atomic=0,
        ),
    )

    response = await api.post(PURCHASE_URL)

    assert response.status_code == 402
    body = response.json()
    assert body["status"] == "failed"
    assert body["reason"] == "insufficient_usdc"
    assert body["payment_state"] == "none"
    assert body["signature"] is None
    assert body["available_atomic"] == 0
    assert body["required_atomic"] == PAID_ATOMIC
    assert "holds 0 USDC" in body["message"]


async def test_submitted_but_unconfirmed_is_504_with_the_signature(monkeypatch, api):
    """The transport must carry the signature through a timeout, not drop it."""
    enable_flag(monkeypatch)
    install_purchase_service(
        monkeypatch,
        purchase_module.PurchaseResult(
            status=PurchaseStatus.PENDING,
            reason=CONFIRMATION_TIMEOUT,
            message=purchase_message(
                CONFIRMATION_TIMEOUT,
                payment_state=PAYMENT_SUBMITTED,
                required_atomic=None,
                available_atomic=None,
            ),
            payment_state=PAYMENT_SUBMITTED,
            signature=SENT_SIGNATURE,
        ),
    )

    response = await api.post(PURCHASE_URL)

    assert response.status_code == 504
    body = response.json()
    assert body["status"] == "pending"
    assert body["reason"] == "confirmation_timeout"
    assert body["payment_state"] == "submitted"
    assert body["signature"] == SENT_SIGNATURE
    assert "Do not pay again" in body["message"]


async def test_an_unexpected_failure_is_a_typed_503_not_a_500(monkeypatch, api):
    enable_flag(monkeypatch)
    install_purchase_service(monkeypatch, RuntimeError("boom"))

    response = await api.post(PURCHASE_URL)

    assert response.status_code == 503
    body = response.json()
    assert body["reason"] == PURCHASE_UNAVAILABLE
    assert body["payment_state"] == "unknown"
    assert "Do not pay again" in body["message"]
    assert "Traceback" not in response.text
    assert "RuntimeError" not in response.text


async def test_a_paid_result_without_its_evidence_is_not_reported_paid(monkeypatch, api):
    """A paid answer without a signature would be a lie about the money."""
    enable_flag(monkeypatch)
    install_purchase_service(monkeypatch, paid_result(signature=None))

    response = await api.post(PURCHASE_URL)

    assert response.status_code == 503
    body = response.json()
    assert body["payment_state"] == "unknown"
    assert body["status"] == "pending"


async def test_the_flag_off_makes_the_purchase_inert(monkeypatch, api):
    monkeypatch.setattr(settings, "FEATURE_X402_AGENT_BRIEF", False)

    def fail_if_called(db):
        raise AssertionError("the purchase service was built with the flag off")

    monkeypatch.setattr(
        router_module, "build_agent_brief_purchase_service", fail_if_called
    )

    response = await api.post(PURCHASE_URL)

    assert response.status_code == 404
    assert response.json()["reason"] == FEATURE_DISABLED


async def test_a_missing_job_is_404_on_the_purchase_route(monkeypatch, api):
    enable_flag(monkeypatch)
    install_purchase_service(
        monkeypatch,
        purchase_module.PurchaseResult(
            status=PurchaseStatus.FAILED,
            reason=BRIEF_NOT_FOUND,
            message=purchase_message(
                BRIEF_NOT_FOUND,
                payment_state=PAYMENT_NONE,
                required_atomic=None,
                available_atomic=None,
            ),
            payment_state=PAYMENT_NONE,
        ),
    )

    response = await api.post(PURCHASE_URL)

    assert response.status_code == 404
    assert response.json()["reason"] == "brief_not_found"


# -- The composition root ----------------------------------------------------


async def test_the_purchase_sends_through_the_existing_solana_write_client(monkeypatch):
    """The composition root hands the gateway ``open_write_client``.

    That function is the only one that can send, and it has no Tatum branch, so
    this assertion is what makes "the send does not go through Tatum" structural
    rather than a claim.
    """
    enable_flag(monkeypatch)
    client = FakeRpcClient()
    operations: list[str] = []

    def factory(operation):
        operations.append(operation)
        return client

    monkeypatch.setattr(container, "open_write_client", factory)

    gateway = container.build_agent_brief_transfer_gateway()
    assert gateway is not None
    signature = await gateway.send_usdc_transfer(
        payer=KEYPAIR, recipient=PAY_TO, amount_atomic=PAID_ATOMIC
    )

    assert operations == ["agent_brief_purchase"]
    assert signature == SENT_SIGNATURE
    assert len(client.sent) == 1


def test_the_transfer_gateway_is_not_built_while_the_flag_is_off(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_X402_AGENT_BRIEF", False)

    assert container.build_agent_brief_transfer_gateway() is None


async def test_the_purchase_is_wired_to_the_custodial_key_helper(monkeypatch):
    """The app signs with the key already on the user's row, not a new store."""
    enable_flag(monkeypatch)
    ledger_claims, _ = install_ledger(monkeypatch)
    transfers = FakeTransferGateway()
    briefs = FakeBriefService()
    opened: list[User] = []

    def keypair_for(user):
        opened.append(user)
        return KEYPAIR

    def build_brief_service(db):
        return briefs

    monkeypatch.setattr(container, "agent_brief_transfer_gateway", transfers)
    monkeypatch.setattr(container, "get_user_keypair", keypair_for)
    monkeypatch.setattr(container, "build_agent_brief_service", build_brief_service)

    service = container.build_agent_brief_purchase_service(object())
    user = make_user()
    result = await service.purchase_brief(
        user=user, job_id=JOB_ID, resource=RESOURCE
    )

    assert opened == [user]
    assert transfers.sent[0]["payer"] is KEYPAIR
    assert result.status is PurchaseStatus.PAID
    assert ledger_claims == [(USER_ID, JOB_ID)]


def test_the_transfer_gateway_builds_no_client_of_its_own():
    """The cluster is chosen by the composition root, not by this module.

    If this module could build an AsyncClient, a future edit could point the
    write at any endpoint. It cannot: the client is always the injected factory,
    which the composition root binds to ``open_write_client``.
    """
    with open(transfer_module.__file__, "r", encoding="utf-8") as handle:
        text = handle.read().lower()

    assert "asyncclient(" not in text
    # The Tatum gateway's request header never appears on a write path.
    assert "x-api-key" not in text


# -- Verified by the existing path, not by a second one -----------------------


class FakeReadGateway:
    """The Tatum read seam the existing brief service verifies a payment with."""

    def __init__(self, transaction: SolanaTransaction) -> None:
        self.transaction = transaction
        self.calls: list[str] = []

    async def get_transaction(self, signature: str) -> SolanaTransaction:
        self.calls.append(signature)
        return self.transaction


def make_settlement(*, mint: str = USDC_MINT, amount: int = PAID_ATOMIC):
    return SolanaTransaction(
        signature=SENT_SIGNATURE,
        slot=42,
        succeeded=True,
        error=None,
        token_deltas=(
            TokenBalanceDelta(
                mint=mint, owner=PAY_TO, delta_atomic=amount
            ),
        ),
    )


def install_brief_rows(monkeypatch, *, claim_results=(True,)):
    """The brief service's own crud seams, so its real read path runs."""
    ledger_claims: list[str] = []
    results = list(claim_results)

    async def fake_job(db, job_id):
        return make_job()

    async def fake_ratings(db, ratee_id):
        return brief_module.ReceivedRatings(
            count=2, average=4.5, distribution={4: 1, 5: 1}
        )

    async def fake_completed(db, provider_id):
        return 3

    async def fake_prices(db, category_id, exclude_job_id):
        return brief_module.CompletedJobPrices(
            count=0, minimum=None, maximum=None, average=None
        )

    async def fake_disputes(db, provider_id):
        return brief_module.ProviderDisputes(total=0, open=0, resolved=0)

    async def fake_claim(db, *, signature, job_id, mint, amount_atomic):
        ledger_claims.append(signature)
        return results.pop(0) if results else False

    monkeypatch.setattr(brief_module, "get_job_by_id", fake_job)
    monkeypatch.setattr(brief_module, "summarize_ratings_by_ratee", fake_ratings)
    monkeypatch.setattr(
        brief_module, "count_completed_jobs_for_provider", fake_completed
    )
    monkeypatch.setattr(brief_module, "summarize_completed_job_prices", fake_prices)
    monkeypatch.setattr(brief_module, "summarize_disputes_for_provider", fake_disputes)
    monkeypatch.setattr(brief_module, "claim_signature", fake_claim)
    return ledger_claims


async def test_a_purchase_is_judged_by_the_existing_brief_service(monkeypatch):
    """The purchase hands its signature to read_brief; it never judges a payment.

    The settlement here is a successful transfer in the wrong mint. The existing
    judge refuses it, so the purchase must not report a paid brief even though the
    transfer it sent was confirmed.
    """
    install_ledger(monkeypatch)
    ledger_claims = install_brief_rows(monkeypatch)
    read_gateway = FakeReadGateway(make_settlement(mint=OTHER_MINT))
    briefs = brief_module.AgentBriefService(
        db=object(), gateway=read_gateway, policy=make_policy()
    )
    service, transfers, _ = make_service(briefs=briefs)

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.FAILED
    assert result.reason == WRONG_MINT
    assert result.payment_state == PAYMENT_CONFIRMED
    assert result.signature == SENT_SIGNATURE
    assert read_gateway.calls == [SENT_SIGNATURE]
    assert ledger_claims == []


async def test_a_purchase_spends_the_signature_in_the_existing_ledger(monkeypatch):
    """A paid purchase claims its signature in agent_brief_payments exactly once."""
    install_ledger(monkeypatch)
    ledger_claims = install_brief_rows(monkeypatch)
    read_gateway = FakeReadGateway(make_settlement())
    briefs = brief_module.AgentBriefService(
        db=object(), gateway=read_gateway, policy=make_policy()
    )
    service, _, _ = make_service(briefs=briefs)

    result = await service.purchase_brief(
        user=make_user(), job_id=JOB_ID, resource=RESOURCE
    )

    assert result.status is PurchaseStatus.PAID
    assert result.brief is not None
    assert result.brief.summary.startswith("Provider history: 3 completed jobs")
    assert read_gateway.calls == [SENT_SIGNATURE]
    assert ledger_claims == [SENT_SIGNATURE]
