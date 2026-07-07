import logging
from datetime import datetime, timezone
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.dependencies import get_db, get_current_user
from ....crud.job import get_job_by_id
from ....models.milestone import Milestone
from ....models.user import User
from ....schemas.milestone import MilestoneCreate, MilestoneOut, MilestoneUpdate

logger = logging.getLogger(__name__)
router = APIRouter()


def _assert_client(job, current_user: User):
    if job.client_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the client can manage milestones")


@router.get("/job/{job_id}", response_model=list[MilestoneOut])
async def list_milestones(
    job_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.client_id != current_user.id and job.provider_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not a participant in this job")

    result = await db.execute(
        select(Milestone).where(Milestone.job_id == job_id).order_by(Milestone.order, Milestone.created_at)
    )
    return result.scalars().all()


@router.post("/job/{job_id}", response_model=MilestoneOut, status_code=status.HTTP_201_CREATED)
async def create_milestone(
    job_id: UUID,
    data: MilestoneCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    _assert_client(job, current_user)
    if job.status in ("completed", "cancelled", "disputed"):
        raise HTTPException(status_code=400, detail="Cannot add milestones to a job in this state")

    m = Milestone(
        job_id=job_id, title=data.title, description=data.description,
        price=data.price, order=data.order,
    )
    db.add(m)
    await db.commit()
    await db.refresh(m)
    return m


@router.patch("/{milestone_id}", response_model=MilestoneOut)
async def update_milestone(
    milestone_id: UUID,
    data: MilestoneUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Milestone).where(Milestone.id == milestone_id))
    m = result.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Milestone not found")
    job = await get_job_by_id(db, m.job_id)
    _assert_client(job, current_user)
    if m.status != "pending":
        raise HTTPException(status_code=400, detail="Can only edit pending milestones")

    if data.title is not None:
        m.title = data.title
    if data.description is not None:
        m.description = data.description
    if data.price is not None:
        m.price = data.price
    await db.commit()
    await db.refresh(m)
    return m


@router.post("/{milestone_id}/release", response_model=MilestoneOut)
async def release_milestone(
    milestone_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Mark a milestone as released (payment acknowledged for this phase).
    Full escrow release still happens via POST /jobs/{id}/release when all milestones are done."""
    result = await db.execute(select(Milestone).where(Milestone.id == milestone_id))
    m = result.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Milestone not found")
    job = await get_job_by_id(db, m.job_id)
    _assert_client(job, current_user)
    if m.status != "pending":
        raise HTTPException(status_code=400, detail="Milestone is not pending")

    m.status = "released"
    m.released_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(m)

    # Notify provider via in-app notification
    from ....crud.notification import create_notification
    if job.provider_id:
        await create_notification(
            db,
            user_id=job.provider_id,
            title="Milestone Released",
            message=f'Client released milestone "{m.title}" for "{job.title}".',
            link="/dashboard/activity",
        )
    await db.commit()
    return m


@router.delete("/{milestone_id}", status_code=204)
async def delete_milestone(
    milestone_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(select(Milestone).where(Milestone.id == milestone_id))
    m = result.scalar_one_or_none()
    if not m:
        raise HTTPException(status_code=404, detail="Milestone not found")
    job = await get_job_by_id(db, m.job_id)
    _assert_client(job, current_user)
    if m.status != "pending":
        raise HTTPException(status_code=400, detail="Can only delete pending milestones")
    await db.delete(m)
    await db.commit()
