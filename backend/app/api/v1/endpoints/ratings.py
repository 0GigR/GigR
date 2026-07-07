import logging
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.dependencies import get_db, get_current_user
from ....crud.job import get_job_by_id
from ....models.rating import Rating
from ....models.user import User
from ....schemas.rating import RatingCreate, RatingOut

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/", response_model=RatingOut, status_code=status.HTTP_201_CREATED)
async def submit_rating(
    data: RatingCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, data.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.status != "completed":
        raise HTTPException(status_code=400, detail="Can only rate completed jobs")
    if job.client_id != current_user.id and job.provider_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not a participant in this job")

    # Determine who is being rated
    ratee_id = job.provider_id if current_user.id == job.client_id else job.client_id
    if not ratee_id:
        raise HTTPException(status_code=400, detail="No counterparty to rate")

    # Check for existing rating
    existing = await db.execute(
        select(Rating).where(Rating.job_id == data.job_id, Rating.rater_id == current_user.id)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="You have already rated this job")

    rating = Rating(
        job_id=data.job_id,
        rater_id=current_user.id,
        ratee_id=ratee_id,
        score=data.score,
        comment=data.comment,
    )
    db.add(rating)
    await db.commit()
    await db.refresh(rating)

    return RatingOut(
        id=rating.id,
        job_id=rating.job_id,
        rater_id=rating.rater_id,
        ratee_id=rating.ratee_id,
        score=rating.score,
        comment=rating.comment,
        created_at=rating.created_at,
        rater_name=current_user.display_name,
    )


@router.get("/user/{user_id}", response_model=list[RatingOut])
async def get_user_ratings(
    user_id: UUID,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(Rating, User.display_name)
        .join(User, User.id == Rating.rater_id)
        .where(Rating.ratee_id == user_id)
        .order_by(Rating.created_at.desc())
    )
    rows = result.all()
    return [
        RatingOut(
            id=r.id, job_id=r.job_id, rater_id=r.rater_id, ratee_id=r.ratee_id,
            score=r.score, comment=r.comment, created_at=r.created_at,
            rater_name=display_name,
        )
        for r, display_name in rows
    ]


@router.get("/user/{user_id}/summary")
async def get_user_rating_summary(user_id: UUID, db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(func.avg(Rating.score), func.count(Rating.id))
        .where(Rating.ratee_id == user_id)
    )
    avg_score, count = result.one()
    return {
        "average": round(float(avg_score), 1) if avg_score else None,
        "count": count,
    }


@router.get("/job/{job_id}/mine")
async def my_job_rating(
    job_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Check if the current user has already rated this job."""
    result = await db.execute(
        select(Rating).where(Rating.job_id == job_id, Rating.rater_id == current_user.id)
    )
    r = result.scalar_one_or_none()
    return {"rated": r is not None, "score": r.score if r else None}
