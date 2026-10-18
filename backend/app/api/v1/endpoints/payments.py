"""Payments surface: public config, PayPal webhooks, and the payments ledger.

  GET  /api/v1/config/public            which rail is live (drives the whole UI)
  POST /api/v1/payments/paypal/webhook  PayPal → Gigr event delivery (signature verified)
  GET  /api/v1/payments/mine            the caller's own payment ledger
  GET  /api/v1/payments/admin/ledger    every payment event (admin) — feeds the AG Grid ledger
"""
import logging
from decimal import Decimal
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.config import settings
from ....core.dependencies import get_current_user, get_db
from ....models.job import Job
from ....models.payment_event import PaymentEvent
from ....models.user import User
from ....services import paypal_client as paypal
from ....services import paypal_escrow
from .admin import require_perm_any

logger = logging.getLogger(__name__)

config_router = APIRouter()
router = APIRouter()


@config_router.get("/public")
async def public_config() -> Dict[str, Any]:
    """Unauthenticated: tells the frontend which rail to render.

    The UI hides everything belonging to the *other* rail (wallets, USDC, cNFT
    vouches), so flipping ``PAYMENT_RAIL`` is the only switch there is.
    """
    rail = settings.PAYMENT_RAIL
    return {
        "payment_rail": rail,
        "paypal": {
            "enabled": settings.paypal_enabled,
            "env": settings.PAYPAL_ENV,
            "currency": paypal_escrow.CURRENCY,
            "fee_percent": settings.PLATFORM_FEE_PERCENT,
        },
        "features": {
            "wallet": rail == "solana",
            "onchain_vouches": rail == "solana",
            "paypal_checkout": rail == "paypal",
        },
    }


@router.post("/paypal/webhook")
async def paypal_webhook(request: Request, db: AsyncSession = Depends(get_db)):
    """Receive PayPal events. Unsigned / forged deliveries are rejected."""
    try:
        event = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    try:
        authentic = await paypal.verify_webhook(dict(request.headers), event)
    except paypal.PayPalError as exc:
        logger.warning("[paypal] webhook verification call failed: %s", exc)
        raise HTTPException(status_code=502, detail="Could not verify webhook signature")
    if not authentic:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid webhook signature")

    try:
        outcome = await paypal_escrow.handle_webhook_event(db, event)
        await db.commit()
    except HTTPException as exc:
        # A business-rule rejection (e.g. capture raced the browser) is not a
        # delivery failure — acknowledge so PayPal stops retrying.
        await db.rollback()
        logger.info("[paypal] webhook %s not applied: %s", event.get("event_type"), exc.detail)
        return {"received": True, "outcome": "not_applied"}
    return {"received": True, "outcome": outcome}


def _event_row(e: PaymentEvent, job_title: str | None = None) -> Dict[str, Any]:
    return {
        "id": str(e.id),
        "created_at": e.created_at.isoformat() if e.created_at else None,
        "kind": e.kind,
        "job_id": str(e.job_id) if e.job_id else None,
        "job_title": job_title,
        "paypal_id": e.paypal_id,
        "amount": float(e.amount) if e.amount is not None else None,
        "currency": e.currency,
        "status": e.status,
        "detail": e.detail,
    }


@router.get("/mine")
async def my_ledger(
    limit: int = 200,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> List[Dict[str, Any]]:
    """Payment events for jobs where the caller is the client or the provider."""
    rows = (await db.execute(
        select(PaymentEvent, Job.title)
        .join(Job, Job.id == PaymentEvent.job_id)
        .where(
            or_(Job.client_id == current_user.id, Job.provider_id == current_user.id),
            PaymentEvent.kind != "webhook",
        )
        .order_by(PaymentEvent.created_at.desc())
        .limit(max(1, min(limit, 500)))
    )).all()
    return [_event_row(e, title) for e, title in rows]


@router.get("/admin/ledger")
async def admin_ledger(
    limit: int = 500,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_perm_any("jobs:view", "jobs:manage", "stats:view")),
) -> Dict[str, Any]:
    """Every payment event plus headline totals — the AG Grid ledger's data source."""
    rows = (await db.execute(
        select(PaymentEvent, Job.title)
        .outerjoin(Job, Job.id == PaymentEvent.job_id)
        .order_by(PaymentEvent.created_at.desc())
        .limit(max(1, min(limit, 2000)))
    )).all()

    totals_rows = (await db.execute(
        select(PaymentEvent.kind, func.coalesce(func.sum(PaymentEvent.amount), 0))
        .where(PaymentEvent.kind.in_(("captured", "payout_sent", "refunded")))
        .group_by(PaymentEvent.kind)
    )).all()
    totals = {k: float(v or Decimal(0)) for k, v in totals_rows}
    held = (await db.execute(
        select(func.coalesce(func.sum(Job.paypal_amount), 0))
        .where(Job.paypal_capture_id.isnot(None), Job.paypal_payout_batch_id.is_(None),
               Job.status.in_(("funded", "in_progress", "disputed")))
    )).scalar() or Decimal(0)

    return {
        "rail": settings.PAYMENT_RAIL,
        "totals": {
            "captured": totals.get("captured", 0.0),
            "paid_out": totals.get("payout_sent", 0.0),
            "refunded": totals.get("refunded", 0.0),
            "held_in_escrow": float(held),
            "currency": paypal_escrow.CURRENCY,
        },
        "events": [_event_row(e, title) for e, title in rows if e.kind != "webhook"],
    }
