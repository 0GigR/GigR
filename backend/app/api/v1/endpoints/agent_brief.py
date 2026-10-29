"""GET /api/v1/agent/brief: the paid brief an external agent buys with x402.

No authentication: the caller is an agent that holds a wallet, not a Gigr user,
and the payment is the credential. The router parses, calls one service, and
maps the service's outcome to a status code; the verification, the replay
ledger and the brief itself live in the service.

The feature flag is checked first. With it off this endpoint is inert: it does
not read the job, does not build a gateway, and does not touch the ledger.
"""

from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.config import settings
from ....core.container import build_agent_brief_service
from ....core.dependencies import get_db
from ....core.errors import RecordNotFoundError
from ....schemas.agent_brief import (
    AgentBriefOut,
    AgentBriefPaidOut,
    ComparableJobs,
    DisputeSummary,
    PaymentReceipt,
    RatingSummary,
    build_payment_required_body,
    decode_payment_header,
)
from ....services.agent_brief_service import (
    INVALID_PAYMENT_HEADER,
    BriefStatus,
    PaymentRequirement,
)

router = APIRouter()

BRIEF_DESCRIPTION = (
    "A factual brief on one Gigr job and its provider's recorded history."
)

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


def _brief_body(brief, signature: str, requirement: PaymentRequirement):
    """The 200 body: the brief, plus what was verified to buy it."""
    return AgentBriefPaidOut(
        payment=PaymentReceipt(
            signature=signature,
            network=requirement.network,
            mint=requirement.mint,
            amount_atomic=requirement.amount_atomic,
            pay_to=requirement.pay_to,
        ),
        brief=AgentBriefOut(
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
                    None
                    if brief.comparable_min is None
                    else float(brief.comparable_min)
                ),
                max_price=(
                    None
                    if brief.comparable_max is None
                    else float(brief.comparable_max)
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
        ),
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
