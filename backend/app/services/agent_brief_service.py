"""The paid agent brief: verify the payment, then describe the job honestly.

Two rules shape this module.

The first is that a payment counts only when the settlement transaction succeeded,
credited the configured recipient, and moved the configured USDC mint by at least
the required atomic amount. Those are four separate facts and each gets its own
refusal reason. In particular the mint is compared explicitly: a transaction that
delivers a different token to the right wallet is not a payment, however large
the number, because that token may be worthless.

The second is that the brief is assembled from rows and nothing else. Every count
and average comes from an aggregate query; when a provider has no history the
brief says so instead of inventing a reassuring sentence.

The verification read is an outbound call and crosses the injected Boundary in
the gateway. A gateway that cannot answer refuses the payment: this path fails
closed, never open.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from enum import Enum
from typing import Callable
from uuid import UUID, uuid4

from ..core.errors import DependencyUnavailableError, RecordNotFoundError
from ..crud.agent_brief_payment import claim_signature
from ..crud.dispute import ProviderDisputes, summarize_disputes_for_provider
from ..crud.job import (
    CompletedJobPrices,
    count_completed_jobs_for_provider,
    get_job_by_id,
    summarize_completed_job_prices,
)
from ..crud.rating import ReceivedRatings, summarize_ratings_by_ratee
from ..models.job import Job

logger = logging.getLogger(__name__)

# Solana Devnet, as a CAIP-2 network identifier. x402 supports the Solana
# namespace and its testnet facilitator, which is why this endpoint settles here
# and says so in the challenge instead of pretending to be another chain.
SOLANA_DEVNET_NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"

# USDC has six decimals on Solana; every amount in this module is atomic units.
USDC_DECIMALS = 6

# Refusal reasons. Each is its own value on purpose: an agent that underpaid and
# an agent that paid in the wrong token need different next steps, and folding
# them into "payment refused" would hide the check that matters.
PAYMENT_MISSING = "payment_missing"
INVALID_PAYMENT_HEADER = "invalid_payment_header"
WRONG_MINT = "wrong_mint"
WRONG_RECIPIENT = "wrong_recipient"
UNDERPAID = "underpaid"
TRANSACTION_FAILED = "transaction_failed"
TRANSACTION_NOT_FOUND = "transaction_not_found"
MALFORMED_TRANSACTION = "malformed_transaction"
VERIFICATION_UNAVAILABLE = "verification_unavailable"
PAYMENT_ALREADY_USED = "payment_already_used"


class BriefStatus(str, Enum):
    """Whether the caller has paid for the brief or still has to."""

    PAID = "paid"
    PAYMENT_REQUIRED = "payment_required"


@dataclass(frozen=True)
class BriefPaymentPolicy:
    """What one brief costs and where the payment must land.

    Injected from the composition root so a test can state the numbers it is
    checking without reading the process's environment.
    """

    mint: str
    pay_to: str
    amount_atomic: int
    network: str = SOLANA_DEVNET_NETWORK
    expires_seconds: int = 300


@dataclass(frozen=True)
class PaymentRequirement:
    """The x402 challenge for one request: what to pay, where, and by when."""

    scheme: str
    network: str
    mint: str
    amount_atomic: int
    pay_to: str
    resource: str
    nonce: str
    expires_at: datetime
    decimals: int = USDC_DECIMALS
    # How long the quote is offered for, as the x402 challenge's
    # maxTimeoutSeconds. The expiry itself is the datetime above.
    expires_seconds: int = 300


@dataclass(frozen=True)
class AgentBrief:
    """Everything the brief claims, and nothing it cannot source from rows."""

    job_id: UUID
    title: str
    job_status: str
    posted_price: Decimal | None
    provider_id: UUID | None
    ratings_count: int
    ratings_average: float | None
    ratings_distribution: dict[int, int]
    completed_jobs: int
    comparable_jobs: int
    comparable_min: Decimal | None
    comparable_max: Decimal | None
    comparable_average: Decimal | None
    disputes_total: int
    disputes_open: int
    disputes_resolved: int
    has_history: bool
    summary: str


@dataclass(frozen=True)
class BriefResult:
    """The service's answer: a paid brief, or the reason it is not paid yet."""

    status: BriefStatus
    reason: str | None = None
    brief: AgentBrief | None = None
    requirement: PaymentRequirement | None = None


def judge_transaction(
    transaction,
    *,
    mint: str,
    recipient: str,
    required_atomic: int,
) -> str | None:
    """Decide whether a transaction pays for the brief. None means it does.

    A credit to the recipient in a token that is not ``mint`` can never count
    toward the payment, no matter how large it is: that is the difference
    between accepting USDC and accepting something worthless with a big number
    in the same field. The reason then separates the two failures a caller can
    act on: no USDC at all (``wrong_mint``) or not enough of it (``underpaid``).

    Returns the refusal reason, so each failure stays distinguishable to the
    caller instead of collapsing into "refused".
    """
    if transaction.error_kind == "transaction_not_found":
        return TRANSACTION_NOT_FOUND
    if transaction.error_kind is not None:
        return MALFORMED_TRANSACTION
    if not transaction.succeeded:
        return TRANSACTION_FAILED

    credits = [
        movement
        for movement in transaction.token_deltas
        if movement.owner == recipient and movement.delta_atomic > 0
    ]
    paid_in_mint = sum(
        movement.delta_atomic for movement in credits if movement.mint == mint
    )
    if paid_in_mint >= required_atomic:
        return None
    if paid_in_mint > 0:
        # Some USDC arrived, just not enough. The next step is to send the
        # difference, which is a different instruction from "that token is not
        # USDC", so the reason says so even if other tokens also arrived.
        return UNDERPAID
    if any(movement.mint != mint for movement in credits):
        # The right wallet was credited, but no configured USDC at all: only
        # another token. Large or small, that token is not a payment.
        return WRONG_MINT
    return WRONG_RECIPIENT


def _decimal_or_none(value: object) -> Decimal | None:
    """Numeric aggregate results, normalised for the wire."""
    if value is None:
        return None
    return Decimal(value)


def _money(value: Decimal | None) -> str:
    """A recorded fiat amount, to two decimals, or a plain word when absent."""
    return f"{value:.2f}" if value is not None else "not recorded"


def _count(count: int, singular: str) -> str:
    """A count with the noun it counts, pluralised for everything but one."""
    return f"{count} {singular}" if count == 1 else f"{count} {singular}s"


def describe_brief(
    *,
    job: Job,
    ratings: ReceivedRatings,
    completed_jobs: int,
    comparable: CompletedJobPrices,
    disputes: ProviderDisputes,
) -> tuple[bool, str]:
    """The brief's sentence, built only from the aggregates it is given.

    Returns ``(has_history, summary)``. ``has_history`` is False when there is
    no provider or the provider has no rows at all, and the summary says exactly
    that rather than implying a reputation that does not exist.
    """
    if job.provider_id is None:
        return (
            False,
            "No provider is assigned to this job yet, so there is no provider "
            "history to report.",
        )

    has_history = bool(ratings.count or completed_jobs or disputes.total)
    if not has_history:
        return (
            False,
            "This provider has no completed jobs, no ratings and no disputes on "
            "Gigr yet.",
        )

    parts: list[str] = []
    if completed_jobs:
        parts.append(_count(completed_jobs, "completed job"))
    else:
        parts.append("no completed jobs")
    if ratings.count and ratings.average is not None:
        parts.append(
            f"an average rating of {ratings.average:.2f} from "
            f"{_count(ratings.count, 'rating')}"
        )
    else:
        parts.append("no ratings")
    if disputes.total:
        parts.append(f"{_count(disputes.total, 'dispute')}, {disputes.open} open")
    else:
        parts.append("no disputes")

    summary = "Provider history: " + ", ".join(parts) + "."
    if comparable.count:
        summary += (
            f" Comparable completed jobs in this category: {comparable.count}, "
            f"priced {_money(comparable.minimum)} to {_money(comparable.maximum)} "
            f"(average {_money(comparable.average)})."
        )
    else:
        summary += " No comparable completed jobs in this category yet."
    return True, summary


class AgentBriefService:
    """One request's worth of the paid brief: price it, verify it, describe it."""

    def __init__(
        self,
        db,
        gateway,
        policy: BriefPaymentPolicy,
        *,
        now: Callable[[], datetime] | None = None,
        nonce_factory: Callable[[], str] | None = None,
    ) -> None:
        self._db = db
        self._gateway = gateway
        self._policy = policy
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._nonce_factory = nonce_factory or (lambda: uuid4().hex)

    def payment_requirement(self, job_id: UUID, resource: str) -> PaymentRequirement:
        """The x402 challenge for this request: fresh nonce, fresh expiry."""
        return PaymentRequirement(
            scheme="exact",
            network=self._policy.network,
            mint=self._policy.mint,
            amount_atomic=self._policy.amount_atomic,
            pay_to=self._policy.pay_to,
            resource=resource,
            nonce=self._nonce_factory(),
            expires_at=self._now() + timedelta(seconds=self._policy.expires_seconds),
            expires_seconds=self._policy.expires_seconds,
        )

    async def read_brief(
        self,
        job_id: UUID,
        signature: str | None,
        resource: str,
    ) -> BriefResult:
        """Return the brief for a paid signature, or the reason it is refused.

        Raises :class:`RecordNotFoundError` when the job does not exist, so the
        transport layer can answer 404 instead of charging for a job that is not
        there.
        """
        job = await get_job_by_id(self._db, job_id)
        if job is None:
            raise RecordNotFoundError("read_brief", "job", job_id)

        requirement = self.payment_requirement(job_id, resource)

        if not signature:
            return BriefResult(
                status=BriefStatus.PAYMENT_REQUIRED,
                reason=PAYMENT_MISSING,
                requirement=requirement,
            )

        if self._gateway is None:
            logger.warning(
                "[agent-brief] verification is not configured; refusing job_id=%s",
                job_id,
            )
            return BriefResult(
                status=BriefStatus.PAYMENT_REQUIRED,
                reason=VERIFICATION_UNAVAILABLE,
                requirement=requirement,
            )

        try:
            transaction = await self._gateway.get_transaction(signature)
        except DependencyUnavailableError as exc:
            logger.warning(
                "[agent-brief] verification unavailable for job_id=%s: %s",
                job_id,
                exc,
            )
            return BriefResult(
                status=BriefStatus.PAYMENT_REQUIRED,
                reason=VERIFICATION_UNAVAILABLE,
                requirement=requirement,
            )

        refusal = judge_transaction(
            transaction,
            mint=self._policy.mint,
            recipient=self._policy.pay_to,
            required_atomic=self._policy.amount_atomic,
        )
        if refusal is not None:
            logger.info(
                "[agent-brief] payment refused for job_id=%s reason=%s",
                job_id,
                refusal,
            )
            return BriefResult(
                status=BriefStatus.PAYMENT_REQUIRED,
                reason=refusal,
                requirement=requirement,
            )

        # Everything read-only happens before the payment is spent, so a failed
        # aggregate does not consume a signature. The claim is then committed
        # before any content is returned: at most one brief per signature, in
        # this process and the next.
        brief = await self._build_brief(job)

        claimed = await claim_signature(
            self._db,
            signature=signature,
            job_id=job.id,
            mint=self._policy.mint,
            amount_atomic=self._policy.amount_atomic,
        )
        if not claimed:
            logger.info(
                "[agent-brief] replay refused for job_id=%s: this signature was "
                "already spent",
                job_id,
            )
            return BriefResult(
                status=BriefStatus.PAYMENT_REQUIRED,
                reason=PAYMENT_ALREADY_USED,
                requirement=requirement,
            )

        return BriefResult(
            status=BriefStatus.PAID,
            brief=brief,
            requirement=requirement,
        )

    async def _build_brief(self, job: Job) -> AgentBrief:
        """Assemble the brief from aggregate queries, never from a loop of rows."""
        ratings = ReceivedRatings(count=0, average=None, distribution={})
        completed_jobs = 0
        disputes = ProviderDisputes(total=0, open=0, resolved=0)

        if job.provider_id is not None:
            ratings = await summarize_ratings_by_ratee(self._db, job.provider_id)
            completed_jobs = await count_completed_jobs_for_provider(
                self._db, job.provider_id
            )
            disputes = await summarize_disputes_for_provider(
                self._db, job.provider_id
            )

        comparable = CompletedJobPrices(
            count=0, minimum=None, maximum=None, average=None
        )
        if job.category_id is not None:
            # Without a category there is nothing to compare against, and saying
            # so is more honest than pricing the job against unrelated work.
            comparable = await summarize_completed_job_prices(
                self._db, job.category_id, job.id
            )

        has_history, summary = describe_brief(
            job=job,
            ratings=ratings,
            completed_jobs=completed_jobs,
            comparable=comparable,
            disputes=disputes,
        )

        return AgentBrief(
            job_id=job.id,
            title=job.title,
            job_status=job.status,
            posted_price=_decimal_or_none(job.price),
            provider_id=job.provider_id,
            ratings_count=ratings.count,
            ratings_average=ratings.average,
            ratings_distribution=dict(ratings.distribution),
            completed_jobs=completed_jobs,
            comparable_jobs=comparable.count,
            comparable_min=_decimal_or_none(comparable.minimum),
            comparable_max=_decimal_or_none(comparable.maximum),
            comparable_average=_decimal_or_none(comparable.average),
            disputes_total=disputes.total,
            disputes_open=disputes.open,
            disputes_resolved=disputes.resolved,
            has_history=has_history,
            summary=summary,
        )
