from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from datetime import datetime, timedelta, timezone
from ....core.dependencies import get_db, get_current_user
from ....models.announcement import Announcement
from ....models.user import User

router = APIRouter()

# Only surface announcements from the last 30 days — a popup for a year-old
# broadcast is noise, not news.
ACTIVE_WINDOW_DAYS = 30


@router.get("/active", response_model=list)
async def active_announcements(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Recent announcements for the in-app popup. The frontend tracks which ids
    it has already dismissed (localStorage) and only pops the unseen ones."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=ACTIVE_WINDOW_DAYS)
    result = await db.execute(
        select(Announcement)
        .where(Announcement.created_at >= cutoff)
        .order_by(Announcement.created_at.desc())
        .limit(10)
    )
    announcements = result.scalars().all()
    return [
        {
            "id": str(a.id),
            "title": a.title,
            "message": a.message,
            "image_url": a.image_url,
            "link": a.link,
            "created_at": a.created_at.isoformat() if a.created_at else None,
        }
        for a in announcements
    ]
