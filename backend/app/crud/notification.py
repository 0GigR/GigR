from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID
from typing import List
import json
import asyncio
from pywebpush import webpush, WebPushException

from ..models.notification import Notification
from ..models.push_subscription import PushSubscription
from ..core.config import settings

async def get_user_notifications(db: AsyncSession, user_id: UUID, limit: int = 50) -> List[Notification]:
    result = await db.execute(
        select(Notification)
        .where(Notification.user_id == user_id)
        .order_by(Notification.created_at.desc())
        .limit(limit)
    )
    return result.scalars().all()

async def create_notification(
    db: AsyncSession,
    user_id: UUID,
    title: str,
    message: str,
    link: str | None = None
) -> Notification:
    notif = Notification(
        user_id=user_id,
        title=title,
        message=message,
        link=link
    )
    db.add(notif)
    
    # Fire off web push in the background
    if settings.VAPID_PRIVATE_KEY and settings.VAPID_CLAIM_EMAIL:
        asyncio.create_task(_send_web_push(db, user_id, title, message, link))
        
    # Don't flush here, let the caller commit it along with the action
    return notif

async def _send_web_push(db: AsyncSession, user_id: UUID, title: str, message: str, link: str | None):
    try:
        # We need a new session context if db is not committed yet, 
        # or we just read subscriptions using the current one.
        result = await db.execute(
            select(PushSubscription).where(PushSubscription.user_id == user_id)
        )
        subs = result.scalars().all()
        if not subs:
            return

        payload = json.dumps({
            "title": title,
            "body": message,
            "url": link or "/"
        })

        for sub in subs:
            sub_info = {
                "endpoint": sub.endpoint,
                "keys": sub.keys
            }
            try:
                # webpush is synchronous and makes HTTP requests, use to_thread to prevent blocking
                await asyncio.to_thread(
                    webpush,
                    subscription_info=sub_info,
                    data=payload,
                    vapid_private_key=settings.VAPID_PRIVATE_KEY,
                    vapid_claims={"sub": settings.VAPID_CLAIM_EMAIL}
                )
            except WebPushException as ex:
                print(f"[WebPush] Failed for endpoint {sub.endpoint}: {ex}")
                # If 410 Gone, the subscription is expired, we should delete it
                if ex.response and ex.response.status_code == 410:
                    await db.delete(sub)
                    await db.commit()
    except Exception as e:
        print(f"[WebPush] Error triggering push: {e}")

async def mark_all_as_read(db: AsyncSession, user_id: UUID) -> None:
    await db.execute(
        update(Notification)
        .where(Notification.user_id == user_id)
        .where(Notification.is_read == False)
        .values(is_read=True)
    )
