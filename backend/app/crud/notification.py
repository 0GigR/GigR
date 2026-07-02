from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID
from typing import List
from ..models.notification import Notification

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
    # Don't flush here, let the caller commit it along with the action
    return notif

async def mark_all_as_read(db: AsyncSession, user_id: UUID) -> None:
    await db.execute(
        update(Notification)
        .where(Notification.user_id == user_id)
        .where(Notification.is_read == False)
        .values(is_read=True)
    )
