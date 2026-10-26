"""Persistence reads for the ratings one user received.

The write path lives in the ratings endpoint; this module exists because the
fact builder needs the whole received-rating set in one query and must not pull
it through a paged list.
"""

from uuid import UUID
from typing import List

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.rating import Rating


async def get_rating_by_id(db: AsyncSession, rating_id: UUID) -> Rating | None:
    """The rating with this id, or None when it does not exist."""
    result = await db.execute(select(Rating).where(Rating.id == rating_id))
    return result.scalar_one_or_none()


async def list_ratings_by_ratee(db: AsyncSession, ratee_id: UUID) -> List[Rating]:
    """Every rating the user received, oldest first, with no page limit."""
    result = await db.execute(
        select(Rating)
        .where(Rating.ratee_id == ratee_id)
        .order_by(Rating.created_at.asc().nulls_last(), Rating.id.asc())
    )
    return list(result.scalars().all())
