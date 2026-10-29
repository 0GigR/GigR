"""Buying the paid agent brief with the caller's own custodial wallet.

The x402 endpoint expects an external agent that holds a wallet. A Gigr user
already has a custodial Solana wallet, so the app can act as that agent: it
builds the same USDC transfer the challenge asks for, signs it with the user's
key, sends it on the cluster the rest of the app writes to, waits for the
confirmation, and hands the signature to the existing verification path. The
payment is verified exactly as an external agent's would be -- same judge, same
replay ledger, same response model -- so this module adds a way to pay, not a
second way to decide that a payment is real.

What this module owns is the answer when something goes wrong. The one rule that
shapes every branch: the money and the truth move together.

* Nothing was submitted -> ``failed``, and the message says nothing was charged.
* A signature came back -> ``pending`` (or ``paid``), and the signature is in the
  answer whether the transfer is confirmed, still confirming, or unreadable.
* A send raised without a signature -> ``pending`` with an unknown payment, and
  the pair is never sent again. A transfer that might exist is not a failure.
* Only a transaction the node confirmed AND the judge accepted is ``paid``.

A second tap cannot pay twice: the pair ``(user, job)`` is claimed in
``agent_brief_purchases`` before anything is built, with one conflict-ignoring
upsert, and only a state that provably paid nothing can be taken over. A tap
that loses the claim resumes the attempt it finds: it re-checks the same
signature and never sends a second transfer.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from decimal import Decimal
from enum import Enum
from typing import Callable
from uuid import UUID

from solders.keypair import Keypair

from ..core.errors import RecordNotFoundError
from ..core.gateways.solana_usdc_transfer_gateway import (
    FAILED,
    FEE_RESERVE_LAMPORTS,
    INSUFFICIENT_SOL_FOR_FEES,
    INSUFFICIENT_USDC,
    SUBMISSION_UNCONFIRMED,
    TIMEOUT,
    TRANSFER_DECLINED,
    UNKNOWN,
    WALLET_BALANCE_UNAVAILABLE,
    UsdcTransferDeclined,
    WalletBalances,
)
from ..crud.agent_brief_purchase import (
    claim_purchase_attempt,
    get_purchase_attempt,
    record_purchase_outcome,
)
from ..crud.job import get_job_by_id
from ..models.agent_brief_purchase import (
    PURCHASE_DECLINED,
    PURCHASE_PAID,
    PURCHASE_REFUSED,
    PURCHASE_SUBMITTED,
    PURCHASE_SUBMITTING,
    PURCHASE_UNCONFIRMED,
)
from ..models.job import Job
from ..models.user import User
from .agent_brief_service import (
    MALFORMED_TRANSACTION,
    PAYMENT_ALREADY_USED,
    TRANSACTION_FAILED,
    TRANSACTION_NOT_FOUND,
    UNDERPAID,
    USDC_DECIMALS,
    VERIFICATION_UNAVAILABLE,
    WRONG_MINT,
    WRONG_RECIPIENT,
    AgentBrief,
    AgentBriefService,
    BriefPaymentPolicy,
    BriefStatus,
    PaymentRequirement,
)

logger = logging.getLogger(__name__)

# Reasons this path adds to the ones the read path already names. Every one is a
# different instruction to the reader, which is why none of them is folded into
# a generic failure.
FEATURE_DISABLED = "feature_disabled"
BRIEF_NOT_FOUND = "brief_not_found"
NO_WALLET = "no_wallet"
WALLET_UNAVAILABLE = "wallet_unavailable"
TRANSFER_UNAVAILABLE = "transfer_unavailable"
CONFIRMATION_TIMEOUT = "confirmation_timeout"
CONFIRMATION_UNAVAILABLE = "confirmation_unavailable"
PURCHASE_IN_PROGRESS = "purchase_in_progress"
PURCHASE_UNAVAILABLE = "purchase_unavailable"

# What the answer may claim about the money. "unknown" is its own value because
# a send that raised without a signature is neither a payment nor a refusal.
PAYMENT_NONE = "none"
PAYMENT_UNKNOWN = "unknown"
PAYMENT_SUBMITTED = "submitted"
PAYMENT_CONFIRMED = "confirmed"


class PurchaseStatus(str, Enum):
    """Whether the caller got the brief, may still get it, or did not."""

    PAID = "paid"
    PENDING = "pending"
    FAILED = "failed"


@dataclass(frozen=True)
class PurchaseResult:
    """Everything the transport may say: the brief or exactly why not.

    ``payment_state`` is the honest answer about the money and is separate from
    ``status`` on purpose: a ``failed`` purchase can still have moved money, and
    a ``pending`` one always may have. ``signature`` is present whenever the node
    accepted a transfer, whatever happened after that.
    """

    status: PurchaseStatus
    reason: str | None
    message: str
    payment_state: str
    signature: str | None = None
    brief: AgentBrief | None = None
    requirement: PaymentRequirement | None = None
    already_purchased: bool = False
    required_atomic: int | None = None
    available_atomic: int | None = None


def _usdc(amount_atomic: int | None) -> str:
    """An atomic amount as whole USDC, without a trailing zero tail."""
    if amount_atomic is None:
        return "0"
    text = f"{Decimal(amount_atomic) / Decimal(10 ** USDC_DECIMALS):.6f}"
    trimmed = text.rstrip("0").rstrip(".")
    return trimmed or "0"


def _money_note(payment_state: str) -> str:
    """One sentence about the money, chosen only from what is actually known."""
    if payment_state == PAYMENT_CONFIRMED:
        return "The transfer is confirmed on the Solana network; its signature is below."
    if payment_state == PAYMENT_SUBMITTED:
        return "The transfer was submitted and may still confirm; its signature is below."
    if payment_state == PAYMENT_UNKNOWN:
        return "A transfer may have been sent, so check your wallet activity before trying again."
    return "Nothing was charged."


def purchase_message(
    reason: str | None,
    *,
    payment_state: str,
    required_atomic: int | None,
    available_atomic: int | None,
) -> str:
    """The sentence the user reads: what happened, then what to do next.

    The money sentence is appended from ``payment_state`` rather than written
    into each branch, so no branch can claim "nothing was charged" after a
    transfer exists.
    """
    if reason == FEATURE_DISABLED:
        base = (
            "Agent briefs are not offered by this deployment. The job and rating "
            "endpoints are still available."
        )
    elif reason == BRIEF_NOT_FOUND:
        base = "No job has that id. Check the job you meant and try again."
    elif reason == NO_WALLET:
        base = (
            "Your account has no Solana wallet yet. Open your profile once to "
            "create one, then tap Buy this brief again."
        )
    elif reason == WALLET_UNAVAILABLE:
        base = (
            "Your Gigr wallet could not be opened for signing. Open your profile "
            "to repair it, then tap Buy this brief again."
        )
    elif reason == TRANSFER_UNAVAILABLE:
        base = (
            "Paying from the app is not set up on this deployment. Use the quote "
            "above and pay from an external wallet instead."
        )
    elif reason == INSUFFICIENT_USDC:
        base = (
            f"Your Gigr wallet holds {_usdc(available_atomic)} USDC and this brief "
            f"costs {_usdc(required_atomic)} USDC. Add USDC to your wallet and tap "
            "Buy this brief again."
        )
    elif reason == INSUFFICIENT_SOL_FOR_FEES:
        base = (
            "Your Gigr wallet has too little SOL to pay the network fee. Add a "
            "little SOL and tap Buy this brief again."
        )
    elif reason == WALLET_BALANCE_UNAVAILABLE:
        base = (
            "Your wallet balance could not be read just now, so nothing was sent. "
            "Tap Buy this brief again in a moment."
        )
    elif reason == TRANSFER_DECLINED:
        base = (
            "The Solana network refused this transfer. Check that your wallet has "
            "SOL for the network fee and tap Buy this brief again."
        )
    elif reason == SUBMISSION_UNCONFIRMED:
        base = (
            "We sent the transfer but did not get a signature back, so we cannot "
            "tell whether the network accepted it. Do not pay again: this job is "
            "marked as being paid."
        )
    elif reason == CONFIRMATION_TIMEOUT:
        base = (
            "The transfer has not been confirmed yet. Do not pay again: tap Buy "
            "this brief again to check this same transfer."
        )
    elif reason == CONFIRMATION_UNAVAILABLE:
        base = (
            "The confirmation could not be checked just now. Do not pay again: tap "
            "Buy this brief again to check this same transfer."
        )
    elif reason == VERIFICATION_UNAVAILABLE:
        base = (
            "The settlement could not be checked on chain just now. Do not pay "
            "again: tap Buy this brief again to check this same transfer."
        )
    elif reason == TRANSACTION_FAILED:
        base = (
            "The transfer failed on the Solana network, so no USDC was sent for "
            "this brief. Network fees may still have been spent. Tap Buy this "
            "brief to try again."
        )
    elif reason == PAYMENT_ALREADY_USED:
        base = (
            "That settlement signature has already bought a brief. One payment "
            "buys one brief. Contact support with the signature below."
        )
    elif reason == WRONG_MINT:
        base = (
            "The transfer moved a different token, not the USDC this brief is "
            "priced in. Contact support with the signature below."
        )
    elif reason == UNDERPAID:
        base = (
            "The transfer was for less than the price of this brief. Contact "
            "support with the signature below."
        )
    elif reason == WRONG_RECIPIENT:
        base = (
            "The transfer went to a different address than the one this brief is "
            "priced to. Contact support with the signature below."
        )
    elif reason == MALFORMED_TRANSACTION:
        base = (
            "The settlement could not be read from the network, so the brief was "
            "not released. Contact support with the signature below."
        )
    elif reason == PURCHASE_IN_PROGRESS:
        base = (
            "A purchase for this job is already being confirmed. Do not pay again: "
            "tap Buy this brief again in a moment to check it."
        )
    elif reason == PURCHASE_UNAVAILABLE:
        base = (
            "We could not finish this purchase. Do not pay again: check your "
            "wallet activity, then contact support with the job id."
        )
    else:
        base = (
            "This purchase did not complete. Tap Buy this brief again, and contact "
            "support with the job id if it keeps happening."
        )
    return f"{base} {_money_note(payment_state)}"


class AgentBriefPurchaseService:
    """One tap's worth of a purchase: guard, pay, confirm, verify, describe.

    ``briefs`` is the existing read service, injected rather than imported into
    the verification: this module never decides whether a payment is real.
    ``keypair_for`` is the existing custodial helper, injected so the composition
    root states which key store is used and a test can pass a throwaway key.
    """

    def __init__(
        self,
        db,
        *,
        briefs: AgentBriefService,
        transfers,
        policy: BriefPaymentPolicy,
        keypair_for: Callable[[User], Keypair],
    ) -> None:
        self._db = db
        self._briefs = briefs
        self._transfers = transfers
        self._policy = policy
        self._keypair_for = keypair_for

    async def purchase_brief(
        self,
        *,
        user: User,
        job_id: UUID,
        resource: str,
    ) -> PurchaseResult:
        """Buy one brief for one job with the caller's custodial wallet.

        Returns a :class:`PurchaseResult` for every outcome, including every
        failure: the transport maps it to a status code and never needs to catch
        anything.
        """
        job = await get_job_by_id(self._db, job_id)
        if job is None:
            return self._result(PurchaseStatus.FAILED, BRIEF_NOT_FOUND, PAYMENT_NONE)
        if not getattr(user, "wallet_public_key", None):
            return self._result(PurchaseStatus.FAILED, NO_WALLET, PAYMENT_NONE)
        if self._transfers is None:
            return self._result(
                PurchaseStatus.FAILED, TRANSFER_UNAVAILABLE, PAYMENT_NONE
            )
        try:
            payer = self._keypair_for(user)
        except Exception as exc:  # noqa: BLE001 - the wallet helper raises its own error
            # No transfer has been built, so this is always a no-money answer.
            logger.error(
                "[agent-brief-purchase] could not open the wallet of user_id=%s: %s",
                user.id,
                type(exc).__name__,
            )
            return self._result(
                PurchaseStatus.FAILED, WALLET_UNAVAILABLE, PAYMENT_NONE
            )

        purchase_id = await claim_purchase_attempt(
            self._db, user_id=user.id, job_id=job.id
        )
        if purchase_id is None:
            attempt = await get_purchase_attempt(
                self._db, user_id=user.id, job_id=job.id
            )
            return await self._resume(attempt, job, resource)

        balances = await self._read_balances(payer)
        if balances is None:
            await self._record(
                purchase_id, PURCHASE_DECLINED, reason=WALLET_BALANCE_UNAVAILABLE
            )
            return self._result(
                PurchaseStatus.FAILED, WALLET_BALANCE_UNAVAILABLE, PAYMENT_NONE
            )
        if balances.usdc_atomic < self._policy.amount_atomic:
            await self._record(
                purchase_id, PURCHASE_DECLINED, reason=INSUFFICIENT_USDC
            )
            return self._result(
                PurchaseStatus.FAILED,
                INSUFFICIENT_USDC,
                PAYMENT_NONE,
                required_atomic=self._policy.amount_atomic,
                available_atomic=balances.usdc_atomic,
            )
        if balances.lamports < FEE_RESERVE_LAMPORTS:
            await self._record(
                purchase_id, PURCHASE_DECLINED, reason=INSUFFICIENT_SOL_FOR_FEES
            )
            return self._result(
                PurchaseStatus.FAILED, INSUFFICIENT_SOL_FOR_FEES, PAYMENT_NONE
            )

        try:
            signature = await self._transfers.send_usdc_transfer(
                payer=payer,
                recipient=self._policy.pay_to,
                amount_atomic=self._policy.amount_atomic,
            )
        except UsdcTransferDeclined as exc:
            # The node answered and refused it, so no transfer was broadcast.
            await self._record(purchase_id, PURCHASE_DECLINED, reason=exc.reason)
            return self._result(PurchaseStatus.FAILED, exc.reason, PAYMENT_NONE)
        except Exception as exc:  # noqa: BLE001 - no signature means unknown money
            # This includes UsdcTransferUnconfirmed: the send may have reached the
            # node. Record it as unconfirmed so no later tap can send a second
            # transfer for this job, and never call it a failure.
            logger.warning(
                "[agent-brief-purchase] transfer raised without a signature for "
                "user_id=%s job_id=%s: %s",
                user.id,
                job.id,
                type(exc).__name__,
            )
            await self._record(
                purchase_id, PURCHASE_UNCONFIRMED, reason=SUBMISSION_UNCONFIRMED
            )
            return self._result(
                PurchaseStatus.PENDING, SUBMISSION_UNCONFIRMED, PAYMENT_UNKNOWN
            )

        # The signature is recorded before the wait, so a process that dies while
        # confirming leaves the payment reachable from the next tap.
        await self._record(
            purchase_id, PURCHASE_SUBMITTED, signature=signature
        )
        return await self._settle(
            purchase_id=purchase_id, job=job, signature=signature, resource=resource
        )

    async def _resume(self, attempt, job: Job, resource: str) -> PurchaseResult:
        """The answer for a tap that lost the claim: never a second transfer."""
        if attempt is None or attempt.state == PURCHASE_SUBMITTING:
            # The winner may be mid-send. There is no signature to check yet, and
            # sending our own would be the double payment this exists to stop.
            return self._result(
                PurchaseStatus.PENDING, PURCHASE_IN_PROGRESS, PAYMENT_UNKNOWN
            )
        if attempt.state == PURCHASE_SUBMITTED and attempt.signature:
            # Already submitted: re-check the same signature, never send again.
            return await self._settle(
                purchase_id=attempt.id,
                job=job,
                signature=attempt.signature,
                resource=resource,
            )
        if attempt.state == PURCHASE_PAID:
            brief = await self._briefs.build_brief(job)
            return PurchaseResult(
                status=PurchaseStatus.PAID,
                reason=None,
                message=(
                    "You already bought this brief. It was not charged again: this "
                    "is the brief this job's purchase paid for."
                ),
                payment_state=PAYMENT_CONFIRMED,
                signature=attempt.signature,
                brief=brief,
                requirement=self._briefs.payment_requirement(job.id, resource),
                already_purchased=True,
            )
        if attempt.state == PURCHASE_REFUSED:
            # A confirmed transfer that did not pay for the brief: money moved.
            return self._result(
                PurchaseStatus.FAILED,
                attempt.reason or TRANSFER_DECLINED,
                PAYMENT_CONFIRMED,
                signature=attempt.signature,
            )
        if attempt.state == PURCHASE_UNCONFIRMED:
            return self._result(
                PurchaseStatus.PENDING,
                SUBMISSION_UNCONFIRMED,
                PAYMENT_UNKNOWN,
                signature=attempt.signature,
            )
        # A declined attempt should have been taken over by the claim. Reaching
        # here means it was not, so report it without claiming a payment.
        return self._result(
            PurchaseStatus.FAILED,
            attempt.reason or TRANSFER_DECLINED,
            PAYMENT_NONE,
            signature=attempt.signature,
        )

    async def _settle(
        self,
        *,
        purchase_id: UUID,
        job: Job,
        signature: str,
        resource: str,
    ) -> PurchaseResult:
        """Confirm one submitted signature, then verify it through the read path."""
        try:
            confirmation = await self._transfers.wait_for_confirmation(signature)
        except Exception as exc:  # noqa: BLE001 - the signature is kept either way
            logger.warning(
                "[agent-brief-purchase] confirmation check failed for %s: %s",
                signature,
                type(exc).__name__,
            )
            return self._result(
                PurchaseStatus.PENDING,
                CONFIRMATION_UNAVAILABLE,
                PAYMENT_SUBMITTED,
                signature=signature,
            )

        if confirmation.confirmation in (TIMEOUT, UNKNOWN):
            reason = (
                CONFIRMATION_TIMEOUT
                if confirmation.confirmation == TIMEOUT
                else CONFIRMATION_UNAVAILABLE
            )
            return self._result(
                PurchaseStatus.PENDING, reason, PAYMENT_SUBMITTED, signature=signature
            )
        if confirmation.confirmation == FAILED:
            # On chain and errored: it moved no tokens, so a retry is safe and the
            # state it leaves behind is the retryable one.
            await self._record(
                purchase_id,
                PURCHASE_DECLINED,
                signature=signature,
                reason=TRANSACTION_FAILED,
            )
            return self._result(
                PurchaseStatus.FAILED,
                TRANSACTION_FAILED,
                PAYMENT_CONFIRMED,
                signature=signature,
            )

        try:
            verified = await self._briefs.read_brief(job.id, signature, resource)
        except RecordNotFoundError:
            # The job was deleted after the transfer confirmed. Money moved and no
            # brief can be described, so the signature is the user's evidence.
            await self._record(
                purchase_id, PURCHASE_REFUSED, signature=signature, reason=BRIEF_NOT_FOUND
            )
            return self._result(
                PurchaseStatus.FAILED,
                BRIEF_NOT_FOUND,
                PAYMENT_CONFIRMED,
                signature=signature,
            )
        except Exception as exc:  # noqa: BLE001 - the payment is on chain either way
            logger.warning(
                "[agent-brief-purchase] verification raised for %s: %s",
                signature,
                type(exc).__name__,
            )
            return self._result(
                PurchaseStatus.PENDING,
                VERIFICATION_UNAVAILABLE,
                PAYMENT_SUBMITTED,
                signature=signature,
            )

        if verified.status is BriefStatus.PAID:
            await self._record(purchase_id, PURCHASE_PAID, signature=signature)
            return PurchaseResult(
                status=PurchaseStatus.PAID,
                reason=None,
                message=(
                    "The brief is yours. It was paid from your Gigr wallet and the "
                    "settlement was verified on Solana."
                ),
                payment_state=PAYMENT_CONFIRMED,
                signature=signature,
                brief=verified.brief,
                requirement=verified.requirement,
            )

        if verified.reason in (VERIFICATION_UNAVAILABLE, TRANSACTION_NOT_FOUND):
            # The signature is ours and the transfer confirmed; only the read
            # path could not see it yet. A later tap re-checks this signature.
            return self._result(
                PurchaseStatus.PENDING,
                VERIFICATION_UNAVAILABLE,
                PAYMENT_SUBMITTED,
                signature=signature,
            )

        if verified.reason == PAYMENT_ALREADY_USED:
            # Our own ledger already spent this signature for this pair: an
            # earlier request verified it and died before it could record the
            # brief. The payment is verified and this pair owns it, so the brief
            # is served rather than sold again.
            await self._record(purchase_id, PURCHASE_PAID, signature=signature)
            return PurchaseResult(
                status=PurchaseStatus.PAID,
                reason=None,
                message=(
                    "The brief is yours. This purchase was already verified, so it "
                    "was not charged again."
                ),
                payment_state=PAYMENT_CONFIRMED,
                signature=signature,
                brief=await self._briefs.build_brief(job),
                requirement=self._briefs.payment_requirement(job.id, resource),
                already_purchased=True,
            )

        await self._record(
            purchase_id,
            PURCHASE_REFUSED,
            signature=signature,
            reason=verified.reason or TRANSFER_DECLINED,
        )
        return self._result(
            PurchaseStatus.FAILED,
            verified.reason,
            PAYMENT_CONFIRMED,
            signature=signature,
        )

    async def _read_balances(self, payer: Keypair) -> WalletBalances | None:
        """The payer's balances, or None when they could not be read."""
        try:
            return await self._transfers.read_wallet_balances(owner=payer.pubkey())
        except Exception as exc:  # noqa: BLE001 - a read failure sends nothing
            logger.warning(
                "[agent-brief-purchase] balance read failed for %s: %s",
                payer.pubkey(),
                type(exc).__name__,
            )
            return None

    async def _record(
        self,
        purchase_id: UUID,
        state: str,
        *,
        signature: str | None = None,
        reason: str | None = None,
    ) -> None:
        """Write the attempt's new state before the caller can answer."""
        await record_purchase_outcome(
            self._db,
            purchase_id=purchase_id,
            state=state,
            signature=signature,
            reason=reason,
        )

    def _result(
        self,
        status: PurchaseStatus,
        reason: str | None,
        payment_state: str,
        *,
        signature: str | None = None,
        required_atomic: int | None = None,
        available_atomic: int | None = None,
    ) -> PurchaseResult:
        """A failure or pending answer, with the copy for its reason."""
        return PurchaseResult(
            status=status,
            reason=reason,
            message=purchase_message(
                reason,
                payment_state=payment_state,
                required_atomic=required_atomic,
                available_atomic=available_atomic,
            ),
            payment_state=payment_state,
            signature=signature,
            required_atomic=required_atomic,
            available_atomic=available_atomic,
        )
