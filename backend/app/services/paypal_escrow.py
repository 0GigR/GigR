"""Gigr escrow on PayPal.

How the money moves
-------------------
    fund     client approves a PayPal checkout; we CAPTURE it into Gigr's PayPal
             business account. That captured payment *is* the escrow.
    release  work approved (or the review window lapsed): PAYOUT the provider's
             PayPal account (minus the platform fee, if any).
    refund   job cancelled / dispute won by the client: REFUND the capture.
    split    dispute resolved part-way: refund the client's share, pay the
             provider's share.

Every call is idempotent (PayPal-Request-Id / sender_batch_id) and every step is
written to ``payment_events`` — so a double click, a retried request or a webhook
racing the browser can never move money twice.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, List, Optional, Tuple

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.config import settings
from ..crud.notification import create_notification
from ..crud.user import get_user_by_id
from ..models.job import Job
from ..models.milestone import JobMilestone
from ..models.payment_event import PaymentEvent
from ..models.user import User
from . import paypal_client as paypal
from .exchange_rate import get_ngn_usd_rate

logger = logging.getLogger(__name__)

RAIL_PAYPAL = "paypal"
RAIL_SOLANA = "solana"
CURRENCY = "USD"  # PayPal cannot settle NGN; job prices are converted to USD
_CENT = Decimal("0.01")

# Payout batch statuses that mean "PayPal accepted it" (it may still be settling).
_PAYOUT_ACCEPTED = {"PENDING", "PROCESSING", "SUCCESS"}


# ── Rail resolution ──────────────────────────────────────────────────────────
def rail_for_job(job: Job) -> str:
    """Which rail holds this job's money.

    Stored per job so switching rails never strands an escrow that was
    funded under the other rail. Jobs funded before the column existed carry a
    Solana ``escrow_address`` and no ``payment_rail``.
    """
    if job.payment_rail:
        return job.payment_rail
    if job.escrow_address and not str(job.escrow_address).startswith("paypal:"):
        return RAIL_SOLANA
    from ..core.rail import current_rail
    return current_rail()


def uses_paypal(job: Job) -> bool:
    return rail_for_job(job) == RAIL_PAYPAL


# ── Helpers ──────────────────────────────────────────────────────────────────
def _q(value: Decimal) -> Decimal:
    return value.quantize(_CENT, rounding=ROUND_HALF_UP)


async def quote_ngn(naira: Decimal) -> Decimal:
    """An NGN amount → the USD amount PayPal will charge, to the cent."""
    rate = Decimal(str(await get_ngn_usd_rate()))
    usd = _q(Decimal(str(naira)) / rate)
    if usd < _CENT:
        raise HTTPException(status_code=400, detail="This amount is too small to pay through PayPal.")
    return usd


async def quote_amount(job: Job) -> Decimal:
    """Job price (NGN) → the USD amount PayPal will charge, to the cent."""
    return await quote_ngn(job.price)


def platform_fee(amount: Decimal) -> Decimal:
    pct = Decimal(str(settings.PLATFORM_FEE_PERCENT or 0))
    if pct <= 0:
        return Decimal("0.00")
    return _q(amount * pct / Decimal(100))


def _http_from_paypal(exc: paypal.PayPalError, action: str) -> HTTPException:
    """Translate a PayPal failure into a clear API error (never leak secrets)."""
    if isinstance(exc, paypal.PayPalNotConfigured):
        return HTTPException(status_code=503, detail="Payments are not configured on this server yet.")
    detail = f"PayPal could not {action}: {exc.message}"
    if exc.debug_id:
        detail += f" (PayPal debug id {exc.debug_id})"
    logger.warning("[paypal] %s failed: %s", action, exc)
    return HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=detail)


async def record_event(
    db: AsyncSession,
    *,
    kind: str,
    job_id: Optional[uuid.UUID] = None,
    user_id: Optional[uuid.UUID] = None,
    paypal_id: Optional[str] = None,
    paypal_event_id: Optional[str] = None,
    amount: Optional[Decimal] = None,
    currency: Optional[str] = None,
    status_text: Optional[str] = None,
    detail: Optional[str] = None,
    raw: Optional[Dict[str, Any]] = None,
) -> PaymentEvent:
    ev = PaymentEvent(
        job_id=job_id,
        user_id=user_id,
        kind=kind,
        paypal_id=paypal_id,
        paypal_event_id=paypal_event_id,
        amount=amount,
        currency=currency,
        status=status_text,
        detail=(detail or "")[:500] or None,
        raw=raw,
    )
    db.add(ev)
    await db.flush()
    return ev


def payment_state(job: Job) -> str:
    """One word the UI can show: where this job's money is right now."""
    return job.payment_state


def payment_summary(job: Job) -> Dict[str, Any]:
    return {
        "rail": rail_for_job(job),
        "state": payment_state(job),
        "amount": float(job.paypal_amount) if job.paypal_amount is not None else None,
        "currency": job.paypal_currency or CURRENCY,
        "order_id": job.paypal_order_id,
        "capture_id": job.paypal_capture_id,
        "payout_batch_id": job.paypal_payout_batch_id,
        "payout_status": job.paypal_payout_status,
    }


# ── Fund ─────────────────────────────────────────────────────────────────────
async def start_checkout(
    db: AsyncSession,
    job: Job,
    provider: User,
    *,
    client_id: uuid.UUID,
    return_url: str,
    cancel_url: str,
) -> Dict[str, Any]:
    """Create (or reuse) the PayPal order the client must approve to fund escrow."""
    if job.status not in ("assigned", "funded"):
        raise HTTPException(status_code=400, detail="Job must be assigned before funding")
    if job.status == "funded" and job.paypal_capture_id:
        raise HTTPException(status_code=409, detail="This job is already funded.")
    if await has_milestone_escrow(db, job):
        raise HTTPException(
            status_code=409,
            detail="This job is paid in stages — fund its next milestone instead of the whole job.",
        )
    if not provider.paypal_email:
        # Money must never be captured for a provider we cannot pay out.
        raise HTTPException(
            status_code=409,
            detail="The provider hasn't linked a PayPal account yet, so escrow can't be funded. "
                   "They've been asked to add one.",
        )

    amount = await quote_amount(job)

    # Reuse a still-open order for the same amount (double click / page reload).
    if job.paypal_order_id and job.paypal_amount == amount:
        try:
            existing = await paypal.get_order(job.paypal_order_id)
            link = paypal.approval_url(existing)
            if existing.get("status") in ("CREATED", "PAYER_ACTION_REQUIRED", "APPROVED") and link:
                return {
                    "order_id": job.paypal_order_id,
                    "approval_url": link,
                    "amount": float(amount),
                    "currency": CURRENCY,
                    "status": existing.get("status"),
                }
        except paypal.PayPalError:
            pass  # expired / unknown — fall through and create a fresh order

    try:
        order = await paypal.create_order(
            amount=amount,
            currency=CURRENCY,
            reference_id=str(job.id),
            custom_id=str(job.id),
            description=f"Gigr escrow: {job.title}",
            return_url=return_url,
            cancel_url=cancel_url,
            request_id=f"gigr-order-{job.id}-{uuid.uuid4().hex[:12]}",
        )
    except paypal.PayPalError as exc:
        raise _http_from_paypal(exc, "start the checkout") from exc

    link = paypal.approval_url(order)
    if not link:
        raise HTTPException(status_code=502, detail="PayPal did not return an approval link.")

    job.payment_rail = RAIL_PAYPAL
    job.paypal_order_id = order["id"]
    job.paypal_amount = amount
    job.paypal_currency = CURRENCY
    await record_event(
        db, kind="order_created", job_id=job.id, user_id=client_id, paypal_id=order["id"],
        amount=amount, currency=CURRENCY, status_text=order.get("status"),
        detail=f"Checkout started for \"{job.title}\"",
    )
    await db.flush()
    return {
        "order_id": order["id"],
        "approval_url": link,
        "amount": float(amount),
        "currency": CURRENCY,
        "status": order.get("status"),
    }


async def capture_checkout(
    db: AsyncSession,
    job: Job,
    order_id: str,
    *,
    actor_id: Optional[uuid.UUID] = None,
) -> Job:
    """Capture an approved order into escrow and mark the job funded. Idempotent."""
    if job.paypal_capture_id and job.status != "assigned":
        return job  # already escrowed
    if job.status not in ("assigned", "funded"):
        raise HTTPException(status_code=400, detail="Job must be assigned before funding")
    if not job.paypal_order_id or order_id != job.paypal_order_id:
        raise HTTPException(status_code=400, detail="That PayPal order doesn't belong to this job.")

    capture_id, captured = await _capture_order(
        db, job, order_id, quoted=job.paypal_amount, actor_id=actor_id
    )
    await _mark_funded(db, job, capture_id, captured, actor_id=actor_id)
    return job


async def _capture_order(
    db: AsyncSession, job: Job, order_id: str, *, quoted: Optional[Decimal], actor_id: Optional[uuid.UUID]
) -> Tuple[str, Decimal]:
    """Capture an approved order and return ``(capture_id, amount)``.

    Shared by whole-job and milestone funding: it raises unless PayPal really
    holds the money, and checks the captured amount against what was quoted.
    """
    try:
        result = await paypal.capture_order(order_id, request_id=f"gigr-capture-{order_id}")
    except paypal.PayPalError as exc:
        if "ORDER_ALREADY_CAPTURED" in exc.issues:
            result = await paypal.get_order(order_id)
        elif "ORDER_NOT_APPROVED" in exc.issues or "PAYER_ACTION_REQUIRED" in exc.issues:
            raise HTTPException(
                status_code=409,
                detail="The payment hasn't been approved in PayPal yet.",
            ) from exc
        else:
            await record_event(
                db, kind="failed", job_id=job.id, user_id=actor_id, paypal_id=order_id,
                status_text="CAPTURE_FAILED", detail=str(exc)[:500],
            )
            raise _http_from_paypal(exc, "capture the payment") from exc

    capture = paypal.capture_from_order(result)
    if not capture:
        raise HTTPException(status_code=502, detail="PayPal returned no capture for this order.")

    cap_status = capture.get("status")
    if cap_status != "COMPLETED":
        # PENDING (PayPal review) settles later via PAYMENT.CAPTURE.COMPLETED.
        await record_event(
            db, kind="captured", job_id=job.id, user_id=actor_id, paypal_id=capture.get("id"),
            status_text=cap_status, detail="Capture not completed yet",
        )
        if cap_status in ("DECLINED", "FAILED"):
            raise HTTPException(status_code=402, detail="PayPal declined the payment.")
        raise HTTPException(
            status_code=409,
            detail="PayPal is still processing this payment. Escrow will fund automatically once it clears.",
        )

    captured = Decimal(str((capture.get("amount") or {}).get("value", "0")))
    if quoted is not None and captured != _q(Decimal(str(quoted))):
        logger.error("[paypal] amount mismatch job=%s quoted=%s captured=%s", job.id, quoted, captured)
        raise HTTPException(status_code=409, detail="The captured amount didn't match the quote. Support has been notified.")
    return capture["id"], captured


async def _mark_funded(
    db: AsyncSession, job: Job, capture_id: str, amount: Decimal, *, actor_id: Optional[uuid.UUID]
) -> None:
    already = job.paypal_capture_id == capture_id and job.status == "funded"
    job.payment_rail = RAIL_PAYPAL
    job.paypal_capture_id = capture_id
    job.paypal_amount = amount
    job.paypal_currency = CURRENCY
    job.escrow_address = f"paypal:{capture_id}"
    job.status = "funded"
    if already:
        return
    await record_event(
        db, kind="captured", job_id=job.id, user_id=actor_id, paypal_id=capture_id,
        amount=amount, currency=CURRENCY, status_text="COMPLETED",
        detail=f"${amount} captured into escrow",
    )
    if job.provider_id:
        await create_notification(
            db,
            user_id=job.provider_id,
            title="Escrow Funded",
            message=f'The client has funded the escrow for "{job.title}". You can begin working!',
            link="/dashboard/activity",
            type="payment",
        )


# ── Release ──────────────────────────────────────────────────────────────────
async def _pay_provider(
    db: AsyncSession,
    job: Job,
    provider: User,
    amount: Decimal,
    *,
    note: str,
    batch_key: str,
    item_id: str,
    marker: str,
    currency: str,
) -> Tuple[str, str]:
    """Pay ``amount`` to the provider's PayPal account and return ``(batch_id, status)``.

    Idempotent per attempt: ``batch_key`` names the thing being paid (the job, or
    one milestone), and failed attempts bump a counter so a retry gets a fresh
    ``sender_batch_id`` while a double click reuses the same one. ``marker``
    prefixes the ledger ``detail`` so attempts can be counted per thing.
    """
    if not provider.paypal_email:
        raise HTTPException(
            status_code=409,
            detail="The provider hasn't linked a PayPal account, so the payout can't be sent.",
        )
    counted = PaymentEvent.detail.like(f"{marker}%")
    if marker == "payout:":
        counted = counted & ~PaymentEvent.detail.like("payout:ms:%")  # job-level attempts only
    attempts = (await db.execute(
        select(func.count(PaymentEvent.id)).where(
            PaymentEvent.job_id == job.id, PaymentEvent.kind.in_(("payout_sent", "failed")), counted,
        )
    )).scalar() or 0
    batch_id = f"gigr-{batch_key}-{attempts}"

    try:
        result = await paypal.create_payout(
            receiver_email=provider.paypal_email,
            amount=amount,
            currency=currency,
            sender_batch_id=batch_id,
            sender_item_id=item_id,
            note=note,
        )
    except paypal.PayPalError as exc:
        await record_event(
            db, kind="failed", job_id=job.id, user_id=job.provider_id,
            amount=amount, currency=currency,
            status_text="PAYOUT_FAILED", detail=f"{marker} {exc.message}"[:500],
        )
        await db.commit()  # keep the audit row even though the request fails
        raise _http_from_paypal(exc, "send the payout") from exc

    header = result.get("batch_header") or {}
    batch_status = header.get("batch_status", "PENDING")
    if batch_status not in _PAYOUT_ACCEPTED:
        await record_event(
            db, kind="failed", job_id=job.id, user_id=job.provider_id, amount=amount,
            currency=currency, status_text=batch_status,
            detail=f"{marker} batch {batch_status}",
        )
        await db.commit()
        raise HTTPException(status_code=502, detail=f"PayPal rejected the payout ({batch_status}).")

    paypal_batch_id = header.get("payout_batch_id")
    await record_event(
        db, kind="payout_sent", job_id=job.id, user_id=job.provider_id,
        paypal_id=paypal_batch_id, amount=amount,
        currency=currency, status_text=batch_status,
        detail=f"{marker} ${amount} to {provider.paypal_email}",
    )
    return paypal_batch_id, batch_status


async def _send_payout(
    db: AsyncSession, job: Job, provider: User, amount: Decimal, *, note: str, tag: str
) -> None:
    """Pay ``amount`` of the job's whole-job escrow to the provider."""
    batch_id, batch_status = await _pay_provider(
        db, job, provider, amount, note=note,
        batch_key=f"{tag}-{job.id.hex}", item_id=job.id.hex,
        marker="payout:", currency=job.paypal_currency or CURRENCY,
    )
    job.paypal_payout_batch_id = batch_id
    job.paypal_payout_status = batch_status


def _require_escrowed(job: Job) -> None:
    if not job.paypal_capture_id:
        raise HTTPException(status_code=400, detail="There is no captured PayPal payment for this job.")
    if job.paypal_payout_batch_id:
        raise HTTPException(status_code=409, detail="This escrow has already been paid out.")


async def release_to_provider(db: AsyncSession, job: Job, *, reason: str = "released") -> Dict[str, Any]:
    """Pay the provider the escrowed amount (minus platform fee); job → completed."""
    if job.paypal_payout_batch_id:  # idempotent: already released
        return payment_summary(job)
    if await has_milestone_escrow(db, job):
        return await _settle_milestones(db, job, "release", reason=reason)
    _require_escrowed(job)
    provider = await get_user_by_id(db, job.provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    gross = _q(Decimal(str(job.paypal_amount)))
    fee = platform_fee(gross)
    net = gross - fee
    await _send_payout(
        db, job, provider, net,
        note=f'Payment for "{job.title}" released from Gigr escrow',
        tag="rel",
    )
    job.status = "completed"
    await create_notification(
        db,
        user_id=provider.id,
        title="Payment Released",
        message=f'${net} for "{job.title}" is on its way to your PayPal account.',
        link="/dashboard/activity",
        type="payment",
    )
    return payment_summary(job)


# ── Refund / split ───────────────────────────────────────────────────────────
async def _refund(
    db: AsyncSession,
    job: Job,
    amount: Optional[Decimal],
    *,
    note: str,
    tag: str,
    capture_id: Optional[str] = None,
    total: Optional[Decimal] = None,
) -> Dict[str, Any]:
    """Refund ``amount`` (default: all) of a capture — the job's, or a milestone's."""
    capture_id = capture_id or job.paypal_capture_id
    total = total if total is not None else job.paypal_amount
    try:
        refund = await paypal.refund_capture(
            capture_id,
            request_id=f"gigr-refund-{job.id}-{tag}",
            amount=amount,
            currency=job.paypal_currency or CURRENCY,
            note=note,
            invoice_id=None,
        )
    except paypal.PayPalError as exc:
        if "CAPTURE_FULLY_REFUNDED" in exc.issues:
            return {"id": None, "status": "COMPLETED"}
        await record_event(
            db, kind="failed", job_id=job.id, user_id=job.client_id, paypal_id=capture_id,
            status_text="REFUND_FAILED", detail=f"refund: {exc.message}"[:500],
        )
        await db.commit()
        raise _http_from_paypal(exc, "refund the payment") from exc

    shown = amount if amount is not None else _q(Decimal(str(total)))
    await record_event(
        db, kind="refunded", job_id=job.id, user_id=job.client_id, paypal_id=refund.get("id"),
        amount=shown, currency=job.paypal_currency or CURRENCY, status_text=refund.get("status"),
        detail=note,
    )
    return refund


async def refund_to_client(db: AsyncSession, job: Job, *, reason: str = "refund") -> Dict[str, Any]:
    """Return the full escrow to the client; job → cancelled."""
    if job.status == "cancelled" and job.paypal_capture_id:
        return payment_summary(job)  # idempotent
    if await has_milestone_escrow(db, job):
        return await _settle_milestones(db, job, "refund", reason=reason)
    _require_escrowed(job)
    await _refund(db, job, None, note=f'Refund for "{job.title}" ({reason})', tag="full")
    job.status = "cancelled"
    await create_notification(
        db,
        user_id=job.client_id,
        title="Escrow Refunded",
        message=f'Your payment for "{job.title}" was refunded to your PayPal account.',
        link="/dashboard/activity",
        type="payment",
    )
    return payment_summary(job)


async def split_escrow(
    db: AsyncSession, job: Job, provider_percent: int
) -> Dict[str, Any]:
    """Resolve a dispute part-way: provider gets ``provider_percent`` %, client the rest."""
    if not 0 < provider_percent < 100:
        raise HTTPException(status_code=400, detail="provider_percent must be between 1 and 99")
    if await has_milestone_escrow(db, job):
        return await _settle_milestones(db, job, "split", provider_percent=provider_percent)
    _require_escrowed(job)
    provider = await get_user_by_id(db, job.provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    gross = _q(Decimal(str(job.paypal_amount)))
    provider_share = _q(gross * Decimal(provider_percent) / Decimal(100))
    client_share = gross - provider_share
    fee = platform_fee(provider_share)
    net = provider_share - fee

    if client_share > 0:
        await _refund(
            db, job, client_share,
            note=f'Partial refund for "{job.title}" (dispute split {100 - provider_percent}% to you)',
            tag=f"split-{provider_percent}",
        )
    if net > 0:
        await _send_payout(
            db, job, provider, net,
            note=f'Dispute settlement for "{job.title}" ({provider_percent}% of escrow)',
            tag=f"split{provider_percent}",
        )
    job.status = "completed"
    for uid, text in (
        (job.client_id, f"${client_share} of your escrow was refunded."),
        (provider.id, f"${net} was paid out to your PayPal account."),
    ):
        await create_notification(
            db, user_id=uid, title="Dispute Settled",
            message=f'The dispute for "{job.title}" was settled. {text}',
            link="/dashboard/activity", type="payment",
        )
    return payment_summary(job)


async def refund_for_amendment(db: AsyncSession, job: Job) -> None:
    """A scope change re-prices the job: return the old escrow so the client re-funds.

    Leaves status handling to the caller (it resets the job to ``assigned``).
    """
    _require_escrowed(job)
    await _refund(db, job, None, note=f'Scope change on "{job.title}" — re-fund at the new price', tag="amend")
    # The old capture is spent; the next checkout starts clean.
    job.paypal_order_id = None
    job.paypal_capture_id = None
    job.paypal_amount = None
    job.escrow_address = None


# ── Milestones (staged escrow) ───────────────────────────────────────────────
# A staged job is paid milestone by milestone. Each milestone is its own PayPal
# order → capture → payout, so releasing stage 1 never touches the money held for
# stage 2, and a refund only ever returns what is still held.
MS_CUSTOM_PREFIX = "ms:"


async def milestones_of(db: AsyncSession, job: Job) -> List[JobMilestone]:
    rows = await db.execute(
        select(JobMilestone).where(JobMilestone.job_id == job.id).order_by(JobMilestone.milestone_index.asc())
    )
    return list(rows.scalars().all())


async def has_milestone_escrow(db: AsyncSession, job: Job) -> bool:
    """True once any of the job's milestones has been paid into PayPal escrow."""
    row = await db.execute(
        select(JobMilestone.id).where(
            JobMilestone.job_id == job.id, JobMilestone.paypal_capture_id.isnot(None)
        ).limit(1)
    )
    return row.first() is not None


def milestone_held(ms: JobMilestone) -> bool:
    """Money for this stage is captured and has neither been paid out nor refunded."""
    return bool(ms.paypal_capture_id) and ms.status == "funded" and not ms.paypal_payout_batch_id


async def milestone_for_order(db: AsyncSession, job_id: uuid.UUID, order_id: str) -> Optional[JobMilestone]:
    row = await db.execute(
        select(JobMilestone).where(JobMilestone.job_id == job_id, JobMilestone.paypal_order_id == order_id)
    )
    return row.scalar_one_or_none()


async def start_milestone_checkout(
    db: AsyncSession,
    job: Job,
    milestone: JobMilestone,
    provider: User,
    *,
    client_id: uuid.UUID,
    return_url: str,
    cancel_url: str,
) -> Dict[str, Any]:
    """Create (or reuse) the PayPal order that funds one milestone."""
    if job.status not in ("assigned", "funded", "in_progress"):
        raise HTTPException(status_code=400, detail="Job must be assigned before funding a milestone")
    if job.paypal_capture_id:
        raise HTTPException(status_code=409, detail="This job is already funded in full.")
    if milestone.status == "funded":
        raise HTTPException(status_code=409, detail="This milestone is already funded.")
    if milestone.status != "pending":
        raise HTTPException(status_code=400, detail=f"Cannot fund a milestone that is '{milestone.status}'")
    if not provider.paypal_email:
        raise HTTPException(
            status_code=409,
            detail="The provider hasn't linked a PayPal account yet, so this milestone can't be funded. "
                   "They've been asked to add one.",
        )

    amount = await quote_ngn(milestone.amount)

    if milestone.paypal_order_id and milestone.paypal_amount == amount:
        try:
            existing = await paypal.get_order(milestone.paypal_order_id)
            link = paypal.approval_url(existing)
            if existing.get("status") in ("CREATED", "PAYER_ACTION_REQUIRED", "APPROVED") and link:
                return {
                    "order_id": milestone.paypal_order_id, "approval_url": link,
                    "amount": float(amount), "currency": CURRENCY, "status": existing.get("status"),
                    "milestone_id": str(milestone.id),
                }
        except paypal.PayPalError:
            pass  # expired / unknown — create a fresh order

    try:
        order = await paypal.create_order(
            amount=amount,
            currency=CURRENCY,
            reference_id=str(milestone.id),
            custom_id=f"{MS_CUSTOM_PREFIX}{milestone.id}",
            description=f"Gigr milestone: {milestone.title} ({job.title})",
            return_url=return_url,
            cancel_url=cancel_url,
            request_id=f"gigr-msorder-{milestone.id}-{uuid.uuid4().hex[:12]}",
        )
    except paypal.PayPalError as exc:
        raise _http_from_paypal(exc, "start the checkout") from exc

    link = paypal.approval_url(order)
    if not link:
        raise HTTPException(status_code=502, detail="PayPal did not return an approval link.")

    job.payment_rail = RAIL_PAYPAL
    milestone.paypal_order_id = order["id"]
    milestone.paypal_amount = amount
    await record_event(
        db, kind="order_created", job_id=job.id, user_id=client_id, paypal_id=order["id"],
        amount=amount, currency=CURRENCY, status_text=order.get("status"),
        detail=f'Milestone checkout started: "{milestone.title}"',
    )
    await db.flush()
    return {
        "order_id": order["id"], "approval_url": link, "amount": float(amount),
        "currency": CURRENCY, "status": order.get("status"), "milestone_id": str(milestone.id),
    }


async def capture_milestone_checkout(
    db: AsyncSession,
    job: Job,
    milestone: JobMilestone,
    order_id: str,
    *,
    actor_id: Optional[uuid.UUID] = None,
) -> JobMilestone:
    """Capture an approved milestone order into escrow. Idempotent."""
    if milestone.paypal_capture_id and milestone.status != "pending":
        return milestone
    if job.status not in ("assigned", "funded", "in_progress"):
        raise HTTPException(status_code=400, detail="This job can no longer take funding.")
    if not milestone.paypal_order_id or order_id != milestone.paypal_order_id:
        raise HTTPException(status_code=400, detail="That PayPal order doesn't belong to this milestone.")

    capture_id, captured = await _capture_order(
        db, job, order_id, quoted=milestone.paypal_amount, actor_id=actor_id
    )
    await _mark_milestone_funded(db, job, milestone, capture_id, captured, actor_id=actor_id)
    return milestone


async def _mark_milestone_funded(
    db: AsyncSession,
    job: Job,
    ms: JobMilestone,
    capture_id: str,
    amount: Decimal,
    *,
    actor_id: Optional[uuid.UUID],
) -> None:
    already = ms.paypal_capture_id == capture_id and ms.status == "funded"
    ms.paypal_capture_id = capture_id
    ms.paypal_amount = amount
    ms.escrow_address = f"paypal:{capture_id}"
    ms.status = "funded"
    ms.funded_at = datetime.now(timezone.utc)
    job.payment_rail = RAIL_PAYPAL
    if job.status in ("assigned", "in_progress"):
        # A newly funded stage means new work to do: reopen the job so the
        # provider can submit it, and stop an earlier stage's auto-release
        # timer from sweeping this stage's money up with it.
        job.status = "funded"
        job.work_submitted_at = None
        job.auto_release_at = None
    if already:
        return
    await record_event(
        db, kind="captured", job_id=job.id, user_id=actor_id, paypal_id=capture_id,
        amount=amount, currency=CURRENCY, status_text="COMPLETED",
        detail=f'${amount} captured into escrow for milestone "{ms.title}"',
    )
    if job.provider_id:
        await create_notification(
            db,
            user_id=job.provider_id,
            title="Milestone Funded",
            message=f'Milestone "{ms.title}" for "{job.title}" is funded in escrow. You can start on it!',
            link="/dashboard/activity",
            type="payment",
        )


async def _maybe_complete_job(db: AsyncSession, job: Job) -> None:
    """The job is done once every milestone is settled, at least one was paid,
    and total released milestones cover the job price."""
    stages = await milestones_of(db, job)
    total_released = sum(
        Decimal(str(m.amount or 0))
        for m in stages
        if m.status == "released"
    )
    job_price = Decimal(str(job.price or 0))
    if stages and all(m.status in ("released", "refunded") for m in stages) \
            and any(m.status == "released" for m in stages) \
            and (job_price <= Decimal("0") or total_released >= job_price):
        job.status = "completed"


async def _pay_milestone(
    db: AsyncSession, job: Job, ms: JobMilestone, provider: User, amount: Decimal, *, note: str, tag: str
) -> None:
    batch_id, batch_status = await _pay_provider(
        db, job, provider, amount, note=note,
        batch_key=f"{tag}-{ms.id.hex}", item_id=ms.id.hex,
        marker=f"payout:ms:{ms.id.hex}:", currency=CURRENCY,
    )
    ms.paypal_payout_batch_id = batch_id
    ms.paypal_payout_status = batch_status
    ms.status = "released"
    ms.released_at = datetime.now(timezone.utc)


async def release_milestone(
    db: AsyncSession, job: Job, ms: JobMilestone, *, reason: str = "released"
) -> JobMilestone:
    """Pay one funded milestone to the provider (minus platform fee). Idempotent."""
    if ms.paypal_payout_batch_id:
        return ms
    if not milestone_held(ms):
        raise HTTPException(status_code=400, detail=f"Milestone is not in funded state (status={ms.status})")
    provider = await get_user_by_id(db, job.provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    gross = _q(Decimal(str(ms.paypal_amount)))
    net = gross - platform_fee(gross)
    await _pay_milestone(
        db, job, ms, provider, net,
        note=f'Milestone "{ms.title}" for "{job.title}" released from Gigr escrow', tag="msrel",
    )
    await _maybe_complete_job(db, job)
    await create_notification(
        db,
        user_id=provider.id,
        title="Milestone Released",
        message=f'${net} for milestone "{ms.title}" is on its way to your PayPal account.',
        link="/dashboard/activity",
        type="payment",
    )
    return ms


async def _settle_milestones(
    db: AsyncSession,
    job: Job,
    action: str,
    *,
    reason: str = "",
    provider_percent: Optional[int] = None,
) -> Dict[str, Any]:
    """Job-level release / refund / dispute split across the milestones still held.

    Stages already paid stay paid; unfunded stages are untouched. Each stage has
    its own idempotency keys, so a retry after a partial failure only does what
    is left.
    """
    held = [m for m in await milestones_of(db, job) if milestone_held(m)]
    if not held and action == "split":
        raise HTTPException(status_code=400, detail="There is no escrowed milestone payment for this job.")

    provider = await get_user_by_id(db, job.provider_id)
    if action != "refund" and held and not provider:
        raise HTTPException(status_code=404, detail="Provider not found")

    paid = Decimal("0.00")
    returned = Decimal("0.00")
    for ms in held:
        gross = _q(Decimal(str(ms.paypal_amount)))
        if action == "release":
            net = gross - platform_fee(gross)
            await _pay_milestone(
                db, job, ms, provider, net,
                note=f'Milestone "{ms.title}" for "{job.title}" released from Gigr escrow', tag="msrel",
            )
            paid += net
        elif action == "refund":
            await _refund(
                db, job, None, note=f'Refund for milestone "{ms.title}" ({reason})',
                tag=f"ms{ms.id.hex}-full", capture_id=ms.paypal_capture_id, total=gross,
            )
            ms.status = "refunded"
            returned += gross
        else:  # split
            provider_share = _q(gross * Decimal(provider_percent) / Decimal(100))
            client_share = gross - provider_share
            net = provider_share - platform_fee(provider_share)
            if client_share > 0:
                await _refund(
                    db, job, client_share,
                    note=f'Partial refund for milestone "{ms.title}" (dispute split)',
                    tag=f"ms{ms.id.hex}-split-{provider_percent}",
                    capture_id=ms.paypal_capture_id, total=gross,
                )
                returned += client_share
            if net > 0:
                await _pay_milestone(
                    db, job, ms, provider, net,
                    note=f'Dispute settlement for milestone "{ms.title}" ({provider_percent}%)',
                    tag=f"mssplit{provider_percent}",
                )
                paid += net
            else:
                ms.status = "refunded"

    if action == "refund":
        job.status = "cancelled"
        if returned > 0:
            await create_notification(
                db, user_id=job.client_id, title="Escrow Refunded",
                message=f'The unreleased milestone payments for "{job.title}" (${returned}) were refunded to your PayPal account.',
                link="/dashboard/activity", type="payment",
            )
        return payment_summary(job)

    if action == "split":
        job.status = "completed"
    else:
        await _maybe_complete_job(db, job)
    if provider and action == "release" and paid > 0:
        await create_notification(
            db, user_id=provider.id, title="Payment Released",
            message=f'${paid} for "{job.title}" is on its way to your PayPal account.',
            link="/dashboard/activity", type="payment",
        )
    if provider and action == "split":
        for uid, text in (
            (job.client_id, f"${returned} of your escrow was refunded."),
            (provider.id, f"${paid} was paid out to your PayPal account."),
        ):
            await create_notification(
                db, user_id=uid, title="Dispute Settled",
                message=f'The dispute for "{job.title}" was settled. {text}',
                link="/dashboard/activity", type="payment",
            )
    return payment_summary(job)


# ── Webhooks ─────────────────────────────────────────────────────────────────
async def _job_by_order(db: AsyncSession, order_id: str) -> Optional[Job]:
    return (await db.execute(select(Job).where(Job.paypal_order_id == order_id))).scalar_one_or_none()


async def _job_by_id_str(db: AsyncSession, raw: Optional[str]) -> Optional[Job]:
    try:
        job_id = uuid.UUID(str(raw))
    except (ValueError, TypeError):
        return None
    return (await db.execute(select(Job).where(Job.id == job_id))).scalar_one_or_none()


async def _job_by_payout_batch(db: AsyncSession, batch_id: Optional[str]) -> Optional[Job]:
    if not batch_id:
        return None
    return (await db.execute(select(Job).where(Job.paypal_payout_batch_id == batch_id))).scalar_one_or_none()


async def _milestone_by_order(db: AsyncSession, order_id: Optional[str]) -> Optional[JobMilestone]:
    if not order_id:
        return None
    return (await db.execute(
        select(JobMilestone).where(JobMilestone.paypal_order_id == order_id)
    )).scalar_one_or_none()


async def _milestone_by_custom_id(db: AsyncSession, raw: Optional[str]) -> Optional[JobMilestone]:
    """Milestone orders carry ``custom_id = "ms:<milestone uuid>"``."""
    if not raw or not str(raw).startswith(MS_CUSTOM_PREFIX):
        return None
    try:
        ms_id = uuid.UUID(str(raw)[len(MS_CUSTOM_PREFIX):])
    except ValueError:
        return None
    return (await db.execute(select(JobMilestone).where(JobMilestone.id == ms_id))).scalar_one_or_none()


async def _milestone_by_payout_batch(db: AsyncSession, batch_id: Optional[str]) -> Optional[JobMilestone]:
    if not batch_id:
        return None
    return (await db.execute(
        select(JobMilestone).where(JobMilestone.paypal_payout_batch_id == batch_id)
    )).scalar_one_or_none()


async def _job_of(db: AsyncSession, ms: Optional[JobMilestone]) -> Optional[Job]:
    if not ms:
        return None
    return (await db.execute(select(Job).where(Job.id == ms.job_id))).scalar_one_or_none()


async def handle_webhook_event(db: AsyncSession, event: Dict[str, Any]) -> str:
    """Apply a verified PayPal webhook. Returns a short outcome string.

    Webhooks are the safety net: they settle things the browser never reported
    (the payer approved on their phone and closed the tab; a payout cleared a day
    later). Each event id is processed once.
    """
    event_id = event.get("id")
    event_type = event.get("event_type", "")
    resource = event.get("resource") or {}

    if event_id:
        seen = (await db.execute(
            select(PaymentEvent.id).where(PaymentEvent.paypal_event_id == event_id)
        )).first()
        if seen:
            return "duplicate"

    job: Optional[Job] = None
    outcome = "ignored"

    if event_type == "CHECKOUT.ORDER.APPROVED":
        job = await _job_by_order(db, resource.get("id", ""))
        if job and job.status == "assigned":
            await capture_checkout(db, job, resource["id"])
            outcome = "captured"
        elif not job:
            ms = await _milestone_by_order(db, resource.get("id"))
            job = await _job_of(db, ms)
            if ms and job and ms.status == "pending":
                await capture_milestone_checkout(db, job, ms, resource["id"])
                outcome = "milestone_captured"

    elif event_type == "PAYMENT.CAPTURE.COMPLETED":
        ms = await _milestone_by_custom_id(db, resource.get("custom_id"))
        if ms:
            job = await _job_of(db, ms)
            if job and ms.status == "pending" and ms.paypal_order_id \
                    and job.status in ("assigned", "funded", "in_progress"):
                amount = Decimal(str((resource.get("amount") or {}).get("value", "0")))
                await _mark_milestone_funded(db, job, ms, resource["id"], amount, actor_id=None)
                outcome = "milestone_funded"
        else:
            job = await _job_by_id_str(db, resource.get("custom_id"))
            if job and job.status in ("assigned", "funded") and job.paypal_capture_id != resource.get("id"):
                if job.paypal_order_id:  # only a capture for the order we issued
                    amount = Decimal(str((resource.get("amount") or {}).get("value", "0")))
                    await _mark_funded(db, job, resource["id"], amount, actor_id=None)
                    outcome = "funded"

    elif event_type in ("PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"):
        ms = await _milestone_by_custom_id(db, resource.get("custom_id"))
        job = await _job_of(db, ms) if ms else await _job_by_id_str(db, resource.get("custom_id"))
        if job:
            await create_notification(
                db, user_id=job.client_id, title="Payment Declined",
                message=f'PayPal declined the payment for "{job.title}". Please try again.',
                link="/dashboard/activity", type="payment",
            )
            outcome = "declined"

    elif event_type.startswith("PAYMENT.PAYOUTS-ITEM."):
        job = await _job_by_payout_batch(db, resource.get("payout_batch_id"))
        ms = None
        if not job:
            ms = await _milestone_by_payout_batch(db, resource.get("payout_batch_id"))
            job = await _job_of(db, ms)
        item_status = event_type.rsplit(".", 1)[-1]  # SUCCEEDED, FAILED, RETURNED, ...
        if job:
            if ms:
                ms.paypal_payout_status = item_status
            else:
                job.paypal_payout_status = item_status
            outcome = f"payout_{item_status.lower()}"
            if item_status in ("FAILED", "RETURNED", "BLOCKED", "DENIED", "REFUNDED"):
                await create_notification(
                    db, user_id=job.provider_id, title="Payout needs attention",
                    message=f'Your payout for "{job.title}" was {item_status.lower()}. '
                            f"Check the PayPal email on your profile.",
                    link="/dashboard/profile", type="payment",
                )

    elif event_type.startswith("PAYMENT.PAYOUTSBATCH."):
        batch = (resource.get("batch_header") or resource)
        job = await _job_by_payout_batch(db, batch.get("payout_batch_id"))
        if job:
            job.paypal_payout_status = event_type.rsplit(".", 1)[-1]
            outcome = "batch_updated"
        else:
            ms = await _milestone_by_payout_batch(db, batch.get("payout_batch_id"))
            job = await _job_of(db, ms)
            if ms:
                ms.paypal_payout_status = event_type.rsplit(".", 1)[-1]
                outcome = "batch_updated"

    await record_event(
        db, kind="webhook", job_id=job.id if job else None, paypal_id=resource.get("id"),
        paypal_event_id=event_id, status_text=event_type, detail=outcome,
        raw={"event_type": event_type, "summary": event.get("summary")},
    )
    return outcome
