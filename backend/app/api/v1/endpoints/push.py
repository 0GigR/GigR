from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from typing import Dict, Any

from app.core.dependencies import get_db, get_current_user
from app.models.user import User
from app.models.push_subscription import PushSubscription
from app.core.config import settings

router = APIRouter()

class PushSubscriptionIn(BaseModel):
    endpoint: str
    keys: Dict[str, str]

@router.get("/vapid-public-key")
async def get_vapid_public_key():
    """Return the VAPID public key for the frontend to subscribe to push notifications."""
    if not settings.VAPID_PUBLIC_KEY:
        raise HTTPException(status_code=501, detail="Web Push is not configured on this server.")
    return {"publicKey": settings.VAPID_PUBLIC_KEY}

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
