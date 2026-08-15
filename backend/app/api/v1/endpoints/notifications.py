from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID
from ....core.dependencies import get_db, get_current_user
from ....crud.notification import get_user_notifications, mark_all_as_read
from ....schemas.notification import NotificationOut
from ....models.notification import Notification
from ....models.user import User

router = APIRouter()

@router.get("/", response_model=list[NotificationOut])
async def list_notifications(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get the 50 most recent notifications for the logged-in user."""
    return await get_user_notifications(db, current_user.id)

@router.post("/read-all", response_model=dict)
async def read_all_notifications(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mark all unread notifications as read for the logged-in user."""
    await mark_all_as_read(db, current_user.id)
    await db.commit()
    return {"status": "ok"}

@router.post("/{notification_id}/read", response_model=dict)
async def read_one_notification(
    notification_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mark a single notification as read (e.g. right when the user taps it)."""
    notif = await db.get(Notification, notification_id)
    if not notif or notif.user_id != current_user.id:
        raise HTTPException(status_code=404, detail="Notification not found")
    notif.is_read = True
    await db.commit()
    return {"status": "ok"}

@router.post("/read-conversation", response_model=dict)
async def read_conversation_notifications(
    payload: dict = Body(...),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mark every unread message notification for a job's chat as read.

    Called when the user actually opens the conversation — message notifications
    are meant to disappear once you've seen the chat, unlike permanent ones
    (escrow, disputes) which only clear via explicit action.
    """
    job_id = str(payload.get("job_id") or "").strip()
    if not job_id:
        raise HTTPException(status_code=400, detail="job_id is required")
    await db.execute(
        update(Notification)
        .where(Notification.user_id == current_user.id)
        .where(Notification.tag == f"chat:{job_id}")
        .values(is_read=True)
    )
    await db.commit()
    return {"status": "ok"}
