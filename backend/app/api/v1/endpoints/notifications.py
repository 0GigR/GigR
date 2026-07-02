from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from ....core.dependencies import get_db, get_current_user
from ....crud.notification import get_user_notifications, mark_all_as_read
from ....schemas.notification import NotificationOut
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
