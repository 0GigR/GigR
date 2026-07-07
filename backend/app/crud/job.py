from uuid import UUID
import uuid
from typing import List, Optional
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from geoalchemy2 import functions as geo_func
from ..models.job import Job
from ..schemas.job import JobCreate

async def get_job_by_id(db: AsyncSession, job_id: UUID) -> Job | None:
    result = await db.execute(select(Job).where(Job.id == job_id))
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

async def get_open_jobs_nearby(
    db: AsyncSession,
    latitude: float,
    longitude: float,
    radius_km: float = 5.0,
    limit: int = 20,
    offset: int = 0
) -> List[Job]:
    point = f"SRID=4326;POINT({longitude} {latitude})"
    distance_col = geo_func.ST_DistanceSphere(Job.location, point).label("distance")

    query = select(Job, distance_col).where(
        Job.status == "open",
        geo_func.ST_DWithin(Job.location, point, radius_km * 1000)
    ).order_by(distance_col).limit(limit).offset(offset)

    result = await db.execute(query)
    return [row[0] for row in result.all()]

async def create_job(db: AsyncSession, client_id: UUID, job_in: JobCreate) -> Job:
    job = Job(
        client_id=client_id,
        title=job_in.title,
        description=job_in.description,
        price=job_in.price,
        min_price=job_in.min_price,
        max_price=job_in.max_price,
        image_url=job_in.image_url,
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
    query = select(Job)
    conditions = []

    if client_id:
        conditions.append(Job.client_id == client_id)
    if provider_id:
        conditions.append(Job.provider_id == provider_id)
    if status:
        statuses = [s.strip() for s in status.split(",")]
        conditions.append(Job.status.in_(statuses))
    if category_id:
        query = query.join(ServiceListing, Job.service_listing_id == ServiceListing.id)
        conditions.append(ServiceListing.category_id == category_id)
    if min_price is not None:
        conditions.append(Job.price >= min_price)
    if max_price is not None:
        conditions.append(Job.price <= max_price)

    # ---- GEOGRAPHY -----
    point = None
    if latitude is not None and longitude is not None:
        point = f"SRID=4326;POINT({longitude} {latitude})"
        conditions.append(
            geo_func.ST_DWithin(
                Job.location,
                point,
                radius_km * 1000
            )
        )

    if search_text:
        conditions.append(Job.title.ilike(f"%{search_text}%"))

    if conditions:
        query = query.where(and_(*conditions))

    # ---- SORTING ----
    if sort_by == 'price_asc':
        query = query.order_by(Job.price.asc())
    elif sort_by == 'price_desc':
        query = query.order_by(Job.price.desc())
    elif sort_by == 'newest':
        query = query.order_by(Job.created_at.desc())
    elif sort_by == 'nearest' and point is not None:
        # Use ST_Distance on geography for correct spherical distance
        query = query.order_by(
            geo_func.ST_Distance(
                Job.location,
                point
            )
        )
    else:
        query = query.order_by(Job.created_at.desc())

    query = query.limit(limit).offset(offset)
    result = await db.execute(query)
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
    from ..core.text_search import tokenize_query, relevance_score

    tokens = tokenize_query(query)
    if tokens:
        conditions = []
        for t in tokens:
            conditions.append(Job.title.ilike(f"%{t}%"))
            conditions.append(Job.description.ilike(f"%{t}%"))
    else:
        conditions = [Job.title.ilike(f"%{query}%"), Job.description.ilike(f"%{query}%")]

    result = await db.execute(
        select(Job).where(or_(*conditions)).limit(max(limit * 3, 30))
    )
    jobs = list(result.scalars().all())

    if tokens:
        jobs.sort(key=lambda j: relevance_score(tokens, j.title, j.description), reverse=True)

    return jobs[offset:offset + limit]
