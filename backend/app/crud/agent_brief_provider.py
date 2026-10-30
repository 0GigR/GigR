"""The providers a brief can be bought about, as one row per provider.

The paid brief is priced by job, but the caller who buys it is an external agent
with no Gigr account and no job of its own. So the thing it picks is a provider,
and the job the brief is asked about is a representative one: that provider's
most recent completed job. This module is the query that pairs the two, plus the
public facts the picker shows beside the name: category, rating and the number
of completed jobs.

Every number here is an aggregate in the statement. The counts, the rating
average and the representative job are three subqueries joined once, so a page of
providers is one round trip and never a query per provider.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.category import Category
from ..models.job import Job
from ..models.rating import Rating
from ..models.service import ServiceListing
from ..models.user import User

# The status that makes a job usable as a brief's subject: it is finished, so
# there is something to report about the provider's record.
COMPLETED_STATUS = "completed"


@dataclass(frozen=True)
class BriefProviderRow:
    """One provider, its public facts, and the job a brief would be about."""

    provider_id: UUID
    display_name: str
    category_name: str | None
    rating_count: int
    rating_average: float | None
    completed_jobs: int
    job_id: UUID
    job_title: str
    job_price: Decimal | None


def _escape_like(value: str) -> str:
    """Escape LIKE wildcards so a pasted ``%`` matches a percent sign, not everything."""
    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _representative_jobs():
    """Each provider's most recent completed job, ranked and reduced to one row.

    ``row_number`` over ``provider_id`` ordered by capture time descending picks
    the newest job per provider inside the database; taking the first row of a
    fetched list would read every completed job to throw all but one away.
    """
    ranked = (
        select(
            Job.provider_id.label("provider_id"),
            Job.id.label("job_id"),
            Job.title.label("job_title"),
            Job.price.label("job_price"),
            Job.category_id.label("job_category_id"),
            Job.service_listing_id.label("job_service_listing_id"),
            func.row_number()
            .over(
                partition_by=Job.provider_id,
                order_by=(Job.created_at.desc().nulls_last(), Job.id.desc()),
            )
            .label("position"),
        )
        .where(Job.status == COMPLETED_STATUS, Job.provider_id.isnot(None))
        .subquery()
    )
    return select(ranked).where(ranked.c.position == 1).subquery()


def _completed_counts():
    """Completed jobs per provider, counted in the query."""
    return (
        select(
            Job.provider_id.label("provider_id"),
            func.count(Job.id).label("completed_jobs"),
        )
        .where(Job.status == COMPLETED_STATUS, Job.provider_id.isnot(None))
        .group_by(Job.provider_id)
        .subquery()
    )


def _rating_totals():
    """Rating count and average per provider, aggregated in the query."""
    return (
        select(
            Rating.ratee_id.label("provider_id"),
            func.count(Rating.id).label("rating_count"),
            func.avg(Rating.score).label("rating_average"),
        )
        .group_by(Rating.ratee_id)
        .subquery()
    )


async def list_brief_provider_rows(
    db: AsyncSession,
    *,
    search: str | None = None,
    limit: int = 20,
) -> list[BriefProviderRow]:
    """Providers with at least one completed job, most history first.

    ``search`` matches the display name case-insensitively; it is expected to be
    already trimmed and bounded by the service. Providers who have never
    completed a job are left out: their brief would be empty, so offering them
    in a picker that promises reliability history would be a false promise.
    """
    jobs = _representative_jobs()
    counts = _completed_counts()
    ratings = _rating_totals()

    statement = (
        select(
            jobs.c.provider_id,
            User.display_name.label("display_name"),
            Category.name.label("category_name"),
            func.coalesce(ratings.c.rating_count, 0).label("rating_count"),
            ratings.c.rating_average.label("rating_average"),
            counts.c.completed_jobs.label("completed_jobs"),
            jobs.c.job_id,
            jobs.c.job_title,
            jobs.c.job_price,
        )
        .select_from(
            jobs.join(User, User.id == jobs.c.provider_id)
            .join(counts, counts.c.provider_id == jobs.c.provider_id)
            .outerjoin(ratings, ratings.c.provider_id == jobs.c.provider_id)
            .outerjoin(
                ServiceListing,
                ServiceListing.id == jobs.c.job_service_listing_id,
            )
        )
        .outerjoin(
            Category,
            Category.id
            == func.coalesce(jobs.c.job_category_id, ServiceListing.category_id),
        )
    )

    if search:
        statement = statement.where(
            User.display_name.ilike(f"%{_escape_like(search)}%", escape="\\")
        )

    statement = statement.order_by(
        counts.c.completed_jobs.desc(),
        User.display_name.asc(),
    ).limit(limit)

    rows = (await db.execute(statement)).all()
    return [
        BriefProviderRow(
            provider_id=row.provider_id,
            display_name=row.display_name,
            category_name=row.category_name,
            rating_count=int(row.rating_count or 0),
            rating_average=(
                float(row.rating_average) if row.rating_average is not None else None
            ),
            completed_jobs=int(row.completed_jobs or 0),
            job_id=row.job_id,
            job_title=row.job_title,
            job_price=row.job_price,
        )
        for row in rows
    ]
