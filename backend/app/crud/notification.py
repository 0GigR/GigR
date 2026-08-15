from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID
from typing import List
import json
import asyncio
import logging
import time
from pywebpush import webpush, WebPushException

logger = logging.getLogger(__name__)

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

# Per-type web-push presentation: icon/badge are app PNGs (resolved by the
# service worker), and the rest tweak grouping, priority and actions.
TYPE_PUSH_OPTIONS: dict[str, dict] = {
    "message": {
        "renotify": True,          # replace the previous message toast but still alert
        "actions": [{"action": "open", "title": "Open chat"}],
    },
    "accepted": {"requireInteraction": True},  # "You're hired" — don't auto-dismiss
    "payment": {"requireInteraction": True},   # escrow funded / payment released
    "work": {"requireInteraction": True},      # work submitted, needs review
    "cancelled": {"vibrate": [200, 80, 200]},
}

# Types that should group/coalesce per conversation instead of stacking.
TAGGED_TYPES = {"message"}

async def create_notification(
    db: AsyncSession,
    user_id: UUID,
    title: str,
    message: str,
    link: str | None = None,
    type: str = "system",
    tag: str | None = None
) -> Notification:
    notif = Notification(
        user_id=user_id,
        title=title,
        message=message,
        link=link,
        type=type
    )
    db.add(notif)
    
    # Fire off web push in the background (uses its own DB session — the request
    # session is closed by the time the background task runs)
    if settings.VAPID_PRIVATE_KEY and settings.VAPID_CLAIM_EMAIL:
        asyncio.create_task(_send_web_push(user_id, title, message, link, type, tag))
        
    # Don't flush here, let the caller commit it along with the action
    return notif

async def _send_web_push(user_id: UUID, title: str, message: str, link: str | None, type: str = "system", tag: str | None = None):
    """Send web pushes using a fresh DB session.

    This runs as a background task, after the request that created the
    notification has finished and closed its session — so we must not reuse
    that request's session here.
    """
    from ..core.database import async_session

    try:
        async with async_session() as db:
            result = await db.execute(
                select(PushSubscription).where(PushSubscription.user_id == user_id)
            )
            subs = result.scalars().all()
            if not subs:
                return

            opts = TYPE_PUSH_OPTIONS.get(type, {})
            push_tag = tag
            if push_tag is None and type in TAGGED_TYPES:
                push_tag = "chat"  # safety net — message pushes should always group

            payload = {
                "title": title,
                "body": message,
                "url": link or "/",
                "type": type,
                "icon": "/icon.png",
                "badge": "/icon.png",
                "vibrate": [100, 50, 100],
                "timestamp": int(time.time() * 1000),
            }
            payload.update(opts)
            if push_tag:
                payload["tag"] = push_tag

            payload_json = json.dumps(payload)

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
                        data=payload_json,
                        vapid_private_key=settings.VAPID_PRIVATE_KEY,
                        vapid_claims={"sub": settings.VAPID_CLAIM_EMAIL}
                    )
                except WebPushException as ex:
                    logger.warning("[WebPush] Failed for endpoint %s: %s", sub.endpoint, ex)
                    # If 410 Gone, the subscription is expired, we should delete it
                    if ex.response and ex.response.status_code == 410:
                        await db.delete(sub)
                        await db.commit()
    except Exception as e:
        # This used to be a silent warning — a broken VAPID key made every push
        # fail invisibly for weeks. Keep it loud.
        logger.error(
            "[WebPush] Error triggering push: %s. If this mentions deserializing "
            "the key, VAPID_PRIVATE_KEY is truncated or in the old SEC1 format — "
            "regenerate it and update the env var.",
            e,
        )

async def mark_all_as_read(db: AsyncSession, user_id: UUID) -> None:
    await db.execute(
        update(Notification)
        .where(Notification.user_id == user_id)
        .where(Notification.is_read == False)
        .values(is_read=True)
    )
