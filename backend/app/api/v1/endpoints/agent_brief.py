"""The paid agent brief over HTTP: the x402 challenge, and the in-app purchase.

``GET /brief`` is the endpoint an external agent buys with x402. It is
unauthenticated on purpose: the caller is an agent that holds a wallet, not a
Gigr user, and the payment is the credential.

``POST /brief/purchase`` is the same purchase for a signed-in Gigr user, whose
custodial wallet the app can sign for. It is authenticated, gated by the same
feature flag, and it ends in the same verification and the same response model
as the GET. The router parses, calls one service, and maps the service's typed
outcome to a status code; the transfer, the confirmation wait, the replay guard
and the brief itself live in the services.

The feature flag is checked first on both routes. With it off neither one reads
a job, builds a gateway, or touches a ledger.
"""

from __future__ import annotations

import logging
from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.config import settings
from ....core.container import (
    build_agent_brief_purchase_service,
    build_agent_brief_service,
)
from ....core.dependencies import get_current_user, get_db
from ....core.errors import RecordNotFoundError
from ....models.user import User
from ....schemas.agent_brief import (
    AgentBriefOut,
    AgentBriefPaidOut,
    AgentBriefPurchaseFailure,
    AgentBriefPurchasedOut,
    ComparableJobs,
    DisputeSummary,
    PaymentReceipt,
    RatingSummary,
    build_payment_required_body,
    decode_payment_header,
)
from ....core.gateways.solana_usdc_transfer_gateway import (
    INSUFFICIENT_SOL_FOR_FEES,
    INSUFFICIENT_USDC,
    SUBMISSION_UNCONFIRMED,
    TRANSFER_DECLINED,
    WALLET_BALANCE_UNAVAILABLE,
)
from ....services.agent_brief_purchase_service import (
    BRIEF_NOT_FOUND,
    CONFIRMATION_TIMEOUT,
    CONFIRMATION_UNAVAILABLE,
    FEATURE_DISABLED,
    NO_WALLET,
    PAYMENT_CONFIRMED,
    PAYMENT_NONE,
    PAYMENT_SUBMITTED,
    PAYMENT_UNKNOWN,
    PURCHASE_IN_PROGRESS,
    PURCHASE_UNAVAILABLE,
    TRANSFER_UNAVAILABLE,
    WALLET_UNAVAILABLE,
    PurchaseResult,
    PurchaseStatus,
    purchase_message,
)
from ....services.agent_brief_service import (
    INVALID_PAYMENT_HEADER,
    MALFORMED_TRANSACTION,
    PAYMENT_ALREADY_USED,
    TRANSACTION_FAILED,
    UNDERPAID,
    VERIFICATION_UNAVAILABLE,
    WRONG_MINT,
    WRONG_RECIPIENT,
    BriefStatus,
    PaymentRequirement,
)

logger = logging.getLogger(__name__)

router = APIRouter()

BRIEF_DESCRIPTION = (
    "A factual brief on one Gigr job and its provider's recorded history."
)

# How the transport answers each typed purchase reason. The split exists so a
# client can tell "you have no USDC" from "we could not reach the network" from
# "the network confirmed it but the brief was refused", which need different next
# steps. The default is a 502 on the settlement path, never a 500.
PURCHASE_REASON_STATUS = {
    BRIEF_NOT_FOUND: status.HTTP_404_NOT_FOUND,
    FEATURE_DISABLED: status.HTTP_404_NOT_FOUND,
    NO_WALLET: status.HTTP_409_CONFLICT,
    WALLET_UNAVAILABLE: status.HTTP_409_CONFLICT,
    PURCHASE_IN_PROGRESS: status.HTTP_409_CONFLICT,
    INSUFFICIENT_USDC: status.HTTP_402_PAYMENT_REQUIRED,
    INSUFFICIENT_SOL_FOR_FEES: status.HTTP_402_PAYMENT_REQUIRED,
    WALLET_BALANCE_UNAVAILABLE: status.HTTP_503_SERVICE_UNAVAILABLE,
    TRANSFER_UNAVAILABLE: status.HTTP_503_SERVICE_UNAVAILABLE,
    CONFIRMATION_UNAVAILABLE: status.HTTP_503_SERVICE_UNAVAILABLE,
    VERIFICATION_UNAVAILABLE: status.HTTP_503_SERVICE_UNAVAILABLE,
    CONFIRMATION_TIMEOUT: status.HTTP_504_GATEWAY_TIMEOUT,
    TRANSFER_DECLINED: status.HTTP_502_BAD_GATEWAY,
    SUBMISSION_UNCONFIRMED: status.HTTP_502_BAD_GATEWAY,
    TRANSACTION_FAILED: status.HTTP_502_BAD_GATEWAY,
    PAYMENT_ALREADY_USED: status.HTTP_409_CONFLICT,
    WRONG_MINT: status.HTTP_502_BAD_GATEWAY,
    UNDERPAID: status.HTTP_502_BAD_GATEWAY,
    WRONG_RECIPIENT: status.HTTP_502_BAD_GATEWAY,
    PURCHASE_UNAVAILABLE: status.HTTP_503_SERVICE_UNAVAILABLE,
}

# The builder is imported as a name so a test can substitute the whole service
# assembly without touching the transport. The router never constructs a gateway
# itself.

def _challenge_response(
    requirement: PaymentRequirement, reason: str | None
) -> JSONResponse:
    """The 402 an x402 client expects: one accepted option and the refusal."""
    body = build_payment_required_body(
        network=requirement.network,
        mint=requirement.mint,
        amount_atomic=requirement.amount_atomic,
        pay_to=requirement.pay_to,
        resource=requirement.resource,
        nonce=requirement.nonce,
        expires_at=requirement.expires_at,
        decimals=requirement.decimals,
        max_timeout_seconds=requirement.expires_seconds,
        reason=reason,
        description=BRIEF_DESCRIPTION,
    )
    return JSONResponse(status_code=status.HTTP_402_PAYMENT_REQUIRED, content=body)


def _payment_receipt(
    signature: str, requirement: PaymentRequirement
) -> PaymentReceipt:
    """What was verified on chain: the signature and the terms it was judged by."""
    return PaymentReceipt(
        signature=signature,
        network=requirement.network,
        mint=requirement.mint,
        amount_atomic=requirement.amount_atomic,
        pay_to=requirement.pay_to,
    )


def _brief_content(brief) -> AgentBriefOut:
    """The brief, in the wire shape both paid responses use."""
    return AgentBriefOut(
        job_id=brief.job_id,
        title=brief.title,
        job_status=brief.job_status,
        posted_price=(
            None if brief.posted_price is None else float(brief.posted_price)
        ),
        provider_id=brief.provider_id,
        ratings=RatingSummary(
            count=brief.ratings_count,
            average=brief.ratings_average,
            distribution=brief.ratings_distribution,
        ),
        completed_jobs=brief.completed_jobs,
        comparable_jobs=ComparableJobs(
            count=brief.comparable_jobs,
            min_price=(
                None if brief.comparable_min is None else float(brief.comparable_min)
            ),
            max_price=(
                None if brief.comparable_max is None else float(brief.comparable_max)
            ),
            average_price=(
                None
                if brief.comparable_average is None
                else float(brief.comparable_average)
            ),
        ),
        disputes=DisputeSummary(
            total=brief.disputes_total,
            open=brief.disputes_open,
            resolved=brief.disputes_resolved,
        ),
        has_history=brief.has_history,
        summary=brief.summary,
    )


def _brief_body(brief, signature: str, requirement: PaymentRequirement):
    """The 200 body: the brief, plus what was verified to buy it."""
    return AgentBriefPaidOut(
        payment=_payment_receipt(signature, requirement),
        brief=_brief_content(brief),
    )


def _purchased_body(result: PurchaseResult) -> AgentBriefPurchasedOut:
    """The purchase 200: the paid-brief body, plus whether it was a new payment.

    Raises ``ValueError`` when a paid result is missing its evidence, which the
    endpoint converts into its typed 503 rather than letting it 500.
    """
    if (
        result.brief is None
        or result.requirement is None
        or result.signature is None
    ):
        raise ValueError("a paid purchase result must carry the brief and its receipt")
    return AgentBriefPurchasedOut(
        payment=_payment_receipt(result.signature, result.requirement),
        brief=_brief_content(result.brief),
        already_purchased=result.already_purchased,
    )


def _purchase_failure(result: PurchaseResult) -> JSONResponse:
    """A typed answer that is not a paid brief, with its reason's status code."""
    reason = result.reason or PURCHASE_UNAVAILABLE
    body = AgentBriefPurchaseFailure(
        status="pending" if result.status is PurchaseStatus.PENDING else "failed",
        reason=reason,
        message=result.message,
        payment_state=result.payment_state,
        signature=result.signature,
        required_atomic=result.required_atomic,
        available_atomic=result.available_atomic,
    )
    return JSONResponse(
        status_code=PURCHASE_REASON_STATUS.get(
            reason, status.HTTP_502_BAD_GATEWAY
        ),
        content=body.model_dump(),
    )


def _failure_result(
    reason: str, payment_state: str
) -> PurchaseResult:
    """A typed result the router raises itself, with the service's own copy."""
    return PurchaseResult(
        status=(
            PurchaseStatus.PENDING
            if payment_state in (PAYMENT_UNKNOWN, PAYMENT_SUBMITTED)
            else PurchaseStatus.FAILED
        ),
        reason=reason,
        message=purchase_message(
            reason,
            payment_state=payment_state,
            required_atomic=None,
            available_atomic=None,
        ),
        payment_state=payment_state,
    )


@router.get("/brief")
async def get_agent_brief(
    request: Request,
    job_id: UUID = Query(..., description="The job the brief is about."),
    x_payment: str | None = Header(default=None, alias="X-PAYMENT"),
    db: AsyncSession = Depends(get_db),
):
    """Return the brief when paid, or the x402 challenge that asks for payment."""
    if not settings.x402_agent_brief_enabled:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                "Agent briefs are not offered by this deployment. Use the job and "
                "rating endpoints instead."
            ),
        )

    service = build_agent_brief_service(db)
    resource = str(request.url)
    requirement = service.payment_requirement(job_id, resource)

    signature = None
    if x_payment:
        try:
            signature = decode_payment_header(x_payment)
        except ValueError:
            return _challenge_response(requirement, INVALID_PAYMENT_HEADER)

    try:
        result = await service.read_brief(job_id, signature, resource)
    except RecordNotFoundError:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(
                "No job has that id. Check job_id against the job you were given "
                "and try again."
            ),
        )

    if result.status is BriefStatus.PAID:
        return _brief_body(result.brief, signature, result.requirement)

    return _challenge_response(result.requirement, result.reason)


@router.post("/brief/purchase")
async def purchase_agent_brief(
    request: Request,
    job_id: UUID = Query(..., description="The job the brief is about."),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Buy the brief with the caller's custodial wallet, in one tap.

    The answer is typed for every outcome: the brief, or a reason code, a
    sentence to show, the payment state, and the settlement signature whenever a
    transfer was submitted. A second tap while a purchase is in flight does not
    send a second transfer.
    """
    if not settings.x402_agent_brief_enabled:
        return _purchase_failure(_failure_result(FEATURE_DISABLED, PAYMENT_NONE))

    service = build_agent_brief_purchase_service(db)
    try:
        result = await service.purchase_brief(
            user=current_user,
            job_id=job_id,
            resource=str(request.url),
        )
        if result.status is PurchaseStatus.PAID:
            return _purchased_body(result)
        return _purchase_failure(result)
    except Exception:  # noqa: BLE001 - the money question is answered, not raised
        # A failure that reaches here happened after the service's own typed
        # checks, so the honest answer is "we cannot tell whether a transfer was
        # submitted", never a 500 with a stack trace.
        logger.exception(
            "[agent-brief] purchase failed unexpectedly for job_id=%s user_id=%s",
            job_id,
            current_user.id,
        )
        return _purchase_failure(_failure_result(PURCHASE_UNAVAILABLE, PAYMENT_UNKNOWN))
