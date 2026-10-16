from uuid import UUID
import uuid
import math
from datetime import datetime, timezone
from typing import List, Optional
from sqlalchemy import select, update, or_, func
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession
from geoalchemy2 import functions as geo_func
from ..core.text_search import tokenize_query, relevance_score
from ..models.job import Job
from ..schemas.job import JobCreate

# ── Default browse ranking: "hotness" ────────────────────────────────────────
# Pure newest-first is a poor default: a 3-day-old job with five applicants is
# far more interesting than a fresh one nobody has touched. Hotness blends
# freshness (exponential decay) with demand (capped application count).
#   hotness = 0.6 * exp(-age_hours / 72) + 0.4 * min(apps, 5) / 5
# A job is "half as fresh" after ~2 days; demand caps at 5 applications so a
# single early applicant doesn't dominate. Applies to the open browse list
# only — search uses relevance, geo uses distance, "my" lists stay newest-first.
HOTNESS_FRESHNESS_HALFLIFE_HOURS = 72
HOTNESS_DEMAND_CAP = 5
HOTNESS_FRESHNESS_WEIGHT = 0.6
HOTNESS_DEMAND_WEIGHT = 0.4


def hotness_score(job: Job, app_count: int, now: datetime | None = None) -> float:
    now = now or datetime.now(timezone.utc)
    if job.created_at is None:
        return 0.0
    age_hours = max((now - job.created_at).total_seconds() / 3600, 0)
    freshness = math.exp(-age_hours / HOTNESS_FRESHNESS_HALFLIFE_HOURS)
    demand = min(app_count or 0, HOTNESS_DEMAND_CAP) / HOTNESS_DEMAND_CAP
    return HOTNESS_FRESHNESS_WEIGHT * freshness + HOTNESS_DEMAND_WEIGHT * demand

async def get_job_by_id(db: AsyncSession, job_id: UUID) -> Job | None:
    result = await db.execute(
        select(Job)
        .options(selectinload(Job.milestones))
        .where(Job.id == job_id)
    )
    return result.scalar_one_or_none()

async def get_jobs_by_client(db: AsyncSession, client_id: UUID, limit: int = 20, offset: int = 0) -> List[Job]:
    result = await db.execute(
        select(Job)
        .where(Job.client_id == client_id)
        .order_by(Job.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return result.scalars().all()

async def get_jobs_by_provider(db: AsyncSession, provider_id: UUID, limit: int = 20, offset: int = 0) -> List[Job]:
    result = await db.execute(
        select(Job)
        .where(Job.provider_id == provider_id)
        .order_by(Job.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return result.scalars().all()

def _with_distance(job: Job, distance_m: Optional[float]) -> Job:
    """Attach a rounded ``distance_km`` to a job instance (transient attribute).

    Exposed through JobOut so the client never has to re-derive distance from
    raw coordinates.
    """
    if distance_m is not None:
        try:
            job.distance_km = round(float(distance_m) / 1000, 2)
        except (TypeError, ValueError):
            pass
    return job


async def get_open_jobs_nearby(
    db: AsyncSession,
    latitude: float,
    longitude: float,
    radius_km: float = 5.0,
    exclude_user_id: Optional[UUID] = None,
    category_id: Optional[UUID] = None,
    limit: int = 20,
    offset: int = 0
) -> List[Job]:
    """Open jobs within ``radius_km`` of a point, nearest first.

    This was dead code (no callers) that mixed the Geography column with a raw
    SRID string in ``ST_DistanceSphere``, which expects geometry. It now uses
    ``ST_Distance`` on the geography column, which returns metres.
    """
    point = f"SRID=4326;POINT({longitude} {latitude})"
    distance_col = geo_func.ST_Distance(
        Job.location, func.ST_GeogFromText(point)
    ).label("distance")

    conditions = [Job.status == "open", Job.location.isnot(None)]
    # radius_km <= 0 means "no limit" (see get_services_nearby).
    if radius_km and radius_km > 0:
        conditions.append(
            geo_func.ST_DWithin(
                Job.location, func.ST_GeogFromText(point), radius_km * 1000
            )
        )
    if exclude_user_id:
        conditions.append(Job.client_id != exclude_user_id)
    if category_id:
        conditions.append(or_(
            Job.category_id == category_id,
            Job.service_listing.has(ServiceListing.category_id == category_id),
        ))

    query = (
        select(Job, distance_col)
        .where(and_(*conditions))
        .order_by(distance_col)
        .limit(limit)
        .offset(offset)
    )
    rows = (await db.execute(query)).all()
    return [_with_distance(job, dist_m) for job, dist_m in rows]

async def create_job(db: AsyncSession, client_id: UUID, job_in: JobCreate) -> Job:
    effective_price = job_in.price if job_in.price is not None else (job_in.min_price or 0.0)
    job = Job(
        client_id=client_id,
        title=job_in.title,
        description=job_in.description,
        price=effective_price,
        min_price=job_in.min_price,
        max_price=job_in.max_price,
        image_url=job_in.image_url,
        category_id=job_in.category_id,
        status="open",
        contract_job_id=hex(uuid.uuid4().int & 0xFFFFFFFFFFFFFFFF)
    )
    if job_in.latitude is not None and job_in.longitude is not None:
        job.location = f"SRID=4326;POINT({job_in.longitude} {job_in.latitude})"
    db.add(job)
    await db.flush()
    # await db.refresh(job)
    return job

async def assign_job(db: AsyncSession, job: Job, provider_id: UUID) -> Job:
    job.provider_id = provider_id
    job.status = "assigned"
    await db.flush()
    # await db.refresh(job)
    return job

async def update_job_status(
    db: AsyncSession,
    job: Job,
    new_status: str,
    escrow_address: Optional[str] = None
) -> Job:
    """
    Central status transition with idempotency guard:
    - If job is already in the target status, return immediately (no-op).
    - Prevents double-funding, double-releasing, etc.
    """
    if job.status == new_status:
        return job  # already in target state – idempotent
    job.status = new_status
    if escrow_address:
        job.escrow_address = escrow_address
    await db.flush()
    # await db.refresh(job)
    return job

async def cancel_job_offchain(db: AsyncSession, job: Job) -> Job:
    """
    Pre-funding cancellation by either party. No blockchain interaction.
    """
    return await update_job_status(db, job, "cancelled")

from sqlalchemy import and_, or_
from sqlalchemy.orm import join
from typing import Optional, List
from uuid import UUID as PyUUID
from ..models.job import Job
from ..models.service import ServiceListing
from geoalchemy2 import functions as geo_func

async def get_jobs_filtered(
    db: AsyncSession,
    client_id: Optional[PyUUID] = None,
    provider_id: Optional[PyUUID] = None,
    exclude_user_id: Optional[PyUUID] = None,
    status: Optional[str] = None,
    category_id: Optional[PyUUID] = None,
    min_price: Optional[float] = None,
    max_price: Optional[float] = None,
    latitude: Optional[float] = None,
    longitude: Optional[float] = None,
    radius_km: float = 10.0,
    search_text: Optional[str] = None,
    sort_by: Optional[str] = None,
    limit: int = 20,
    offset: int = 0
) -> List[Job]:
    # Distance is selected up-front when geo params are present, so every return
    # path below can expose `distance_km` without a second query.
    point = None
    distance_col = None
    if latitude is not None and longitude is not None:
        point = f"SRID=4326;POINT({longitude} {latitude})"
        distance_col = geo_func.ST_Distance(
            Job.location, func.ST_GeogFromText(point)
        ).label("distance")

    query = select(Job, distance_col) if distance_col is not None else select(Job)
    conditions = []

    if client_id:
        conditions.append(Job.client_id == client_id)
    if provider_id:
        conditions.append(Job.provider_id == provider_id)
    # Public browse: never show the caller's own jobs (they belong under
    # "My Jobs"). Only the client is excluded — providers are only set on
    # non-public statuses, and NULL != x is false in SQL so provider checks
    # would wrongly drop every open job.
    if exclude_user_id:
        conditions.append(Job.client_id != exclude_user_id)
    if status:
        statuses = [s.strip() for s in status.split(",")]
        conditions.append(Job.status.in_(statuses))
    if category_id:
        # Match both directly-posted jobs (own category_id) and service-request
        # jobs (category inherited via the requested listing) without forcing a
        # join that would drop direct posts.
        conditions.append(or_(
            Job.category_id == category_id,
            Job.service_listing.has(ServiceListing.category_id == category_id),
        ))
    if min_price is not None:
        conditions.append(Job.price >= min_price)
    if max_price is not None:
        conditions.append(Job.price <= max_price)

    # ---- GEOGRAPHY -----
    if point is not None:
        conditions.append(
            geo_func.ST_DWithin(
                Job.location,
                func.ST_GeogFromText(point),
                radius_km * 1000
            )
        )

    if search_text:
        # Fuzzy any-word matching across title AND description (same as services
        # search): 'samsung repair' matches a job titled "Samsung screen repair".
        tokens = tokenize_query(search_text)
        if tokens:
            text_conds = []
            for t in tokens:
                text_conds.append(Job.title.ilike(f"%{t}%"))
                text_conds.append(Job.description.ilike(f"%{t}%"))
            conditions.append(or_(*text_conds))
        else:
            conditions.append(or_(
                Job.title.ilike(f"%{search_text}%"),
                Job.description.ilike(f"%{search_text}%"),
            ))

    # Default browse list (no search / geo / "my" filters): rank by hotness,
    # which needs per-job application counts before pagination.
    #
    # `sort_by is None` matters: hotness re-ranks in Python *after* the SQL
    # ORDER BY, so without this guard an explicit `sort=price_asc|newest`
    # request was silently overridden by hotness.
    use_hotness = (
        search_text is None
        and latitude is None
        and client_id is None
        and provider_id is None
        and sort_by is None
    )

    if use_hotness:
        from ..models.application import Application
        app_counts = (
            select(Application.job_id, func.count(Application.id).label("cnt"))
            .group_by(Application.job_id)
            .subquery()
        )
        # Select the count alongside each job (a plain outerjoin would not add
        # the column to the result rows).
        query = select(Job, app_counts.c.cnt).outerjoin(
            app_counts, app_counts.c.job_id == Job.id
        )

    if conditions:
        query = query.where(and_(*conditions))

    # ---- SORTING ----
    if sort_by == 'price_asc':
        query = query.order_by(Job.price.asc())
    elif sort_by == 'price_desc':
        query = query.order_by(Job.price.desc())
    elif sort_by == 'newest':
        query = query.order_by(Job.created_at.desc())
    elif sort_by == 'nearest' and distance_col is not None:
        # Spherical distance, nearest first — reuses the selected distance_col.
        query = query.order_by(distance_col)
    else:
        query = query.order_by(Job.created_at.desc())

    if search_text:
        # Relevance-ranking must happen before pagination: fetch the whole
        # filtered set, rank by how many query words match, then slice.
        result = await db.execute(query)
        if distance_col is not None:
            jobs = [_with_distance(job, dist_m) for job, dist_m in result.all()]
        else:
            jobs = list(result.scalars().all())
        tokens = tokenize_query(search_text)
        if tokens:
            jobs.sort(
                key=lambda j: relevance_score(tokens, j.title, j.description),
                reverse=True,
            )
        return jobs[offset:offset + limit]

    if use_hotness:
        # Fetch the whole filtered set, rank by hotness, attach the count to
        # each job (so list endpoints can expose it), then slice for pagination.
        rows = (await db.execute(query)).all()
        counts = {job.id: cnt for job, cnt in rows}
        jobs = [job for job, _ in rows]
        now = datetime.now(timezone.utc)
        jobs.sort(
            key=lambda j: hotness_score(j, counts.get(j.id, 0), now),
            reverse=True,
        )
        for j in jobs:
            j.applications_count = counts.get(j.id, 0)
        return jobs[offset:offset + limit]

    query = query.limit(limit).offset(offset)
    result = await db.execute(query)
    if distance_col is not None:
        return [_with_distance(job, dist_m) for job, dist_m in result.all()]
    return result.scalars().all()
async def transition_job_status(
    db: AsyncSession,
    job_id: UUID,
    from_statuses: list[str],
    to_status: str,
    escrow_address: str | None = None,
) -> bool:
    """Atomic conditional status update — prevents TOCTOU on escrow transitions.

    Issues UPDATE ... WHERE status IN (from_statuses) and returns True only if
    a row was actually changed. Callers should treat False as a 409: a concurrent
    request already transitioned the job.
    """
    values: dict = {"status": to_status}
    if escrow_address:
        values["escrow_address"] = escrow_address
    result = await db.execute(
        update(Job)
        .where(Job.id == job_id)
        .where(Job.status.in_(from_statuses))
        .values(**values)
    )
    return result.rowcount > 0


async def search_jobs_by_text(db: AsyncSession, query: str, limit: int = 20, offset: int = 0) -> List[Job]:
    """Word-tokenized search: match jobs containing ANY significant query word
    in title or description, ranked by number of matching words. Fixes the naive
    full-phrase bug (e.g. 'fix my samsung' failing to match 'Samsung screen fix')."""
    from ..core.text_search import compact, tokenize_query, relevance_score

    tokens = tokenize_query(query)
    if tokens:
        # Separator-stripped copies so word-spanning queries match too (see
        # core.text_search.compact).
        compact_title = func.regexp_replace(func.lower(Job.title), r"[^a-z0-9]", "", "g")
        compact_description = func.regexp_replace(
            func.lower(func.coalesce(Job.description, "")), r"[^a-z0-9]", "", "g"
        )
        conditions = []
        for t in tokens:
            conditions.append(Job.title.ilike(f"%{t}%"))
            conditions.append(Job.description.ilike(f"%{t}%"))
            collapsed = compact(t)
            if collapsed:
                conditions.append(compact_title.like(f"%{collapsed}%"))
                conditions.append(compact_description.like(f"%{collapsed}%"))
    else:
        conditions = [Job.title.ilike(f"%{query}%"), Job.description.ilike(f"%{query}%")]

    result = await db.execute(
        select(Job).where(or_(*conditions)).limit(max(limit * 3, 30))
    )
    jobs = list(result.scalars().all())

    if tokens:
        jobs.sort(key=lambda j: relevance_score(tokens, j.title, j.description), reverse=True)

    return jobs[offset:offset + limit]
