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
from decimal import ROUND_HALF_UP, Decimal
from typing import Any, Dict, Optional

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.config import settings
from ..crud.notification import create_notification
from ..crud.user import get_user_by_id
from ..models.job import Job
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

    Stored per job so flipping ``PAYMENT_RAIL`` never strands an escrow that was
    funded under the other rail. Jobs funded before the column existed carry a
    Solana ``escrow_address`` and no ``payment_rail``.
    """
    if job.payment_rail:
        return job.payment_rail
    if job.escrow_address and not str(job.escrow_address).startswith("paypal:"):
        return RAIL_SOLANA
    return settings.PAYMENT_RAIL


def uses_paypal(job: Job) -> bool:
    return rail_for_job(job) == RAIL_PAYPAL


# ── Helpers ──────────────────────────────────────────────────────────────────
def _q(value: Decimal) -> Decimal:
    return value.quantize(_CENT, rounding=ROUND_HALF_UP)


async def quote_amount(job: Job) -> Decimal:
    """Job price (NGN) → the USD amount PayPal will charge, to the cent."""
    rate = Decimal(str(await get_ngn_usd_rate()))
    usd = _q(Decimal(str(job.price)) / rate)
    if usd < _CENT:
        raise HTTPException(status_code=400, detail="This job's price is too small to pay through PayPal.")
    return usd


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
    if job.paypal_amount is not None and captured != _q(Decimal(str(job.paypal_amount))):
        logger.error("[paypal] amount mismatch job=%s quoted=%s captured=%s", job.id, job.paypal_amount, captured)
        raise HTTPException(status_code=409, detail="The captured amount didn't match the quote. Support has been notified.")

    await _mark_funded(db, job, capture["id"], captured, actor_id=actor_id)
    return job


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
async def _send_payout(
    db: AsyncSession, job: Job, provider: User, amount: Decimal, *, note: str, tag: str
) -> None:
    """Pay ``amount`` to the provider's PayPal account (idempotent per attempt)."""
    if not provider.paypal_email:
        raise HTTPException(
            status_code=409,
            detail="The provider hasn't linked a PayPal account, so the payout can't be sent.",
        )
    attempts = (await db.execute(
        select(func.count(PaymentEvent.id)).where(
            PaymentEvent.job_id == job.id, PaymentEvent.kind.in_(("payout_sent", "failed")),
            PaymentEvent.detail.like("payout:%"),
        )
    )).scalar() or 0
    batch_id = f"gigr-{tag}-{job.id.hex}-{attempts}"

    try:
        result = await paypal.create_payout(
            receiver_email=provider.paypal_email,
            amount=amount,
            currency=job.paypal_currency or CURRENCY,
            sender_batch_id=batch_id,
            sender_item_id=job.id.hex,
            note=note,
        )
    except paypal.PayPalError as exc:
        await record_event(
            db, kind="failed", job_id=job.id, user_id=job.provider_id,
            amount=amount, currency=job.paypal_currency or CURRENCY,
            status_text="PAYOUT_FAILED", detail=f"payout: {exc.message}"[:500],
        )
        await db.commit()  # keep the audit row even though the request fails
        raise _http_from_paypal(exc, "send the payout") from exc

    header = result.get("batch_header") or {}
    batch_status = header.get("batch_status", "PENDING")
    if batch_status not in _PAYOUT_ACCEPTED:
        await record_event(
            db, kind="failed", job_id=job.id, user_id=job.provider_id, amount=amount,
            currency=job.paypal_currency or CURRENCY, status_text=batch_status,
            detail=f"payout: batch {batch_status}",
        )
        await db.commit()
        raise HTTPException(status_code=502, detail=f"PayPal rejected the payout ({batch_status}).")

    job.paypal_payout_batch_id = header.get("payout_batch_id")
    job.paypal_payout_status = batch_status
    await record_event(
        db, kind="payout_sent", job_id=job.id, user_id=job.provider_id,
        paypal_id=job.paypal_payout_batch_id, amount=amount,
        currency=job.paypal_currency or CURRENCY, status_text=batch_status,
        detail=f"payout: ${amount} to {provider.paypal_email}",
    )


def _require_escrowed(job: Job) -> None:
    if not job.paypal_capture_id:
        raise HTTPException(status_code=400, detail="There is no captured PayPal payment for this job.")
    if job.paypal_payout_batch_id:
        raise HTTPException(status_code=409, detail="This escrow has already been paid out.")


async def release_to_provider(db: AsyncSession, job: Job, *, reason: str = "released") -> Dict[str, Any]:
    """Pay the provider the escrowed amount (minus platform fee); job → completed."""
    if job.paypal_payout_batch_id:  # idempotent: already released
        return payment_summary(job)
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
    db: AsyncSession, job: Job, amount: Optional[Decimal], *, note: str, tag: str
) -> Dict[str, Any]:
    try:
        refund = await paypal.refund_capture(
            job.paypal_capture_id,
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
            db, kind="failed", job_id=job.id, user_id=job.client_id, paypal_id=job.paypal_capture_id,
            status_text="REFUND_FAILED", detail=f"refund: {exc.message}"[:500],
        )
        await db.commit()
        raise _http_from_paypal(exc, "refund the payment") from exc

    shown = amount if amount is not None else _q(Decimal(str(job.paypal_amount)))
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

    elif event_type == "PAYMENT.CAPTURE.COMPLETED":
        job = await _job_by_id_str(db, resource.get("custom_id"))
        if job and job.status in ("assigned", "funded") and job.paypal_capture_id != resource.get("id"):
            if job.paypal_order_id:  # only a capture for the order we issued
                amount = Decimal(str((resource.get("amount") or {}).get("value", "0")))
                await _mark_funded(db, job, resource["id"], amount, actor_id=None)
                outcome = "funded"

    elif event_type in ("PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"):
        job = await _job_by_id_str(db, resource.get("custom_id"))
        if job:
            await create_notification(
                db, user_id=job.client_id, title="Payment Declined",
                message=f'PayPal declined the payment for "{job.title}". Please try again.',
                link="/dashboard/activity", type="payment",
            )
            outcome = "declined"

    elif event_type.startswith("PAYMENT.PAYOUTS-ITEM."):
        job = await _job_by_payout_batch(db, resource.get("payout_batch_id"))
        item_status = event_type.rsplit(".", 1)[-1]  # SUCCEEDED, FAILED, RETURNED, ...
        if job:
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

    await record_event(
        db, kind="webhook", job_id=job.id if job else None, paypal_id=resource.get("id"),
        paypal_event_id=event_id, status_text=event_type, detail=outcome,
        raw={"event_type": event_type, "summary": event.get("summary")},
    )
    return outcome
