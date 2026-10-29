"""Persistence reads for the ratings one user received.

The write path lives in the ratings endpoint; this module exists because the
fact builder needs the whole received-rating set in one query and must not pull
it through a paged list.
"""

from uuid import UUID
from dataclasses import dataclass
from typing import List

from sqlalchemy import func, select
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


@dataclass(frozen=True)
class ReceivedRatings:
    """The ratings one user received, aggregated, with per-score counts."""

    count: int
    average: float | None
    distribution: dict[int, int]


async def summarize_ratings_by_ratee(
    db: AsyncSession, ratee_id: UUID
) -> ReceivedRatings:
    """Count, average and distribution of a user's received ratings.

    Aggregated in the queries, not in a loop over rows: the brief needs the
    summary, never the ratings themselves.
    """
    totals = await db.execute(
        select(func.count(Rating.id), func.avg(Rating.score)).where(
            Rating.ratee_id == ratee_id
        )
    )
    count, average = totals.one()
    grouped = await db.execute(
        select(Rating.score, func.count(Rating.id))
        .where(Rating.ratee_id == ratee_id)
        .group_by(Rating.score)
    )
    distribution = {
        int(score): int(score_count) for score, score_count in grouped.all()
    }
    return ReceivedRatings(
        count=int(count or 0),
        average=float(average) if average is not None else None,
        distribution=distribution,
    )
