import logging
from fastapi import APIRouter, Depends, HTTPException, status, Header
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import Dict, Any, Optional
from urllib.parse import urlparse

from app.core.dependencies import get_db, get_current_user
from app.models.user import User
from app.models.push_subscription import PushSubscription
from app.core.config import settings
from app.core.database import async_session
from app.core.security import decode_access_token
from app.crud.user import get_user_by_id

logger = logging.getLogger(__name__)

router = APIRouter()

class PushSubscriptionIn(BaseModel):
    endpoint: str
    keys: Dict[str, str]

async def get_optional_user(
    authorization: Optional[str] = Header(default=None),
) -> Optional[User]:
    """Resolve the user from the Bearer token if one is present (telemetry only)."""
    if authorization and authorization.startswith("Bearer "):
        payload = decode_access_token(authorization[7:])
        if payload and payload.get("type") != "refresh" and payload.get("sub"):
            async with async_session() as db:
                return await get_user_by_id(db, payload["sub"])
    return None

class PushDiagnosticIn(BaseModel):
    event: str
    detail: Optional[str] = None

@router.post("/diagnostic")
async def push_diagnostic(
    payload: PushDiagnosticIn,
    current_user: Optional[User] = Depends(get_optional_user),
):
    """Log client-side push flow telemetry.

    The browser can fail to enable push before any push API call is made
    (no PushManager, service worker never ready, subscribe() throwing,
    permission quirks, save failing). Those failures used to vanish
    silently — this lets the frontend report exactly where the flow stopped
    so it shows up in the server logs instead of nowhere.
    """
    logger.info(
        "[PushDiag] user=%s event=%s detail=%s",
        current_user.id if current_user else "anon",
        payload.event,
        payload.detail or "-",
    )
    return {"status": "ok"}

@router.get("/vapid-public-key")
async def get_vapid_public_key():
    """Return the VAPID public key for the frontend to subscribe to push notifications."""
    if not settings.VAPID_PUBLIC_KEY:
        raise HTTPException(status_code=501, detail="Web Push is not configured on this server.")
    return {"publicKey": settings.VAPID_PUBLIC_KEY}

@router.get("/status")
async def push_status(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Whether the current user has a saved push subscription on this server.

    The frontend uses this to show a truthful "enabled" state: browser
    permission being granted says nothing about whether the subscription was
    ever saved here (a failed save or an expired token leaves the user looking
    enabled while nothing ever arrives).
    """
    result = await db.execute(
        select(PushSubscription).where(PushSubscription.user_id == current_user.id)
    )
    subs = result.scalars().all()
    return {
        "subscribed": len(subs) > 0,
        "count": len(subs),
        "endpoints": sorted({urlparse(s.endpoint).netloc for s in subs}),
    }

@router.post("/subscribe")
async def subscribe_push(
    subscription: PushSubscriptionIn,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Save a user's web push subscription."""
    # Check if exists
    result = await db.execute(
        select(PushSubscription).where(PushSubscription.endpoint == subscription.endpoint)
    )
    existing = result.scalar_one_or_none()
    
    if existing:
        if existing.user_id != current_user.id:
            # Transfer ownership if the same browser logs into a different account
            existing.user_id = current_user.id
            existing.keys = subscription.keys
            await db.commit()
        return {"status": "ok", "detail": "Subscription updated"}
        
    new_sub = PushSubscription(
        user_id=current_user.id,
        endpoint=subscription.endpoint,
        keys=subscription.keys
    )
    db.add(new_sub)
    await db.commit()
    return {"status": "ok", "detail": "Subscribed successfully"}

@router.delete("/unsubscribe")
async def unsubscribe_push(
    endpoint: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Remove a web push subscription."""
    result = await db.execute(
        select(PushSubscription).where(
            PushSubscription.endpoint == endpoint,
            PushSubscription.user_id == current_user.id
        )
    )
    sub = result.scalar_one_or_none()
    if sub:
        await db.delete(sub)
        await db.commit()
    return {"status": "ok"}
