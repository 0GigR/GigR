from uuid import UUID
from typing import List, Optional
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..models.dispute import Dispute, DisputeStatus
from ..schemas.dispute import DisputeCreate
from datetime import datetime, timezone

async def get_dispute_by_id(db: AsyncSession, dispute_id: UUID) -> Dispute | None:
    result = await db.execute(select(Dispute).where(Dispute.id == dispute_id))
    return result.scalar_one_or_none()

async def get_dispute_by_job(db: AsyncSession, job_id: UUID) -> Dispute | None:
    result = await db.execute(select(Dispute).where(Dispute.job_id == job_id))
    return result.scalar_one_or_none()

async def get_disputes_by_user(db: AsyncSession, user_id: UUID, limit: int = 20, offset: int = 0) -> List[Dispute]:
    result = await db.execute(
        select(Dispute)
        .where((Dispute.client_id == user_id) | (Dispute.provider_id == user_id))
        .order_by(Dispute.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return result.scalars().all()

async def create_dispute(db: AsyncSession, client_id: UUID, provider_id: UUID, dispute_in: DisputeCreate, raised_by: UUID) -> Dispute:
    dispute = Dispute(
        job_id=dispute_in.job_id,
        client_id=client_id,
        provider_id=provider_id,
        reason=dispute_in.reason,
        status=DisputeStatus.OPEN,
        raised_by=raised_by,
    )
    db.add(dispute)
    await db.commit()
    await db.refresh(dispute)
    return dispute

async def resolve_dispute(db: AsyncSession, dispute: Dispute, resolution: str) -> Dispute:
    dispute.status = DisputeStatus.RESOLVED
    dispute.resolution = resolution
    dispute.resolved_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(dispute)
    return dispute

async def list_disputes_for_user(db: AsyncSession, user_id: UUID) -> List[Dispute]:
    """Every dispute the user is a party to, oldest first, with no page limit."""
    result = await db.execute(
        select(Dispute)
        .where((Dispute.client_id == user_id) | (Dispute.provider_id == user_id))
        .order_by(Dispute.created_at.asc().nulls_last(), Dispute.id.asc())
    )
    return list(result.scalars().all())


async def list_disputes_for_jobs(db: AsyncSession, job_ids: List[UUID]) -> List[Dispute]:
    """Every dispute raised on these jobs, in one query."""
    if not job_ids:
        return []
    result = await db.execute(select(Dispute).where(Dispute.job_id.in_(list(job_ids))))
    return list(result.scalars().all())
