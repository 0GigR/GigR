from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ....core.dependencies import get_db, get_current_user
from ....crud.application import (
    get_application_by_id,
    create_application,
    delete_application,
    get_applications_for_job,
    get_application_by_applicant_and_job,
)
from ....crud.job import get_job_by_id
from ....schemas.application import ApplicationCreate, ApplicationOut
from ....models.user import User
import uuid
from sqlalchemy.orm import joinedload
from ....models.application import Application
from ....models.user import User
router = APIRouter()


@router.post("/", response_model=ApplicationOut, status_code=status.HTTP_201_CREATED)
async def apply(
    app_data: ApplicationCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, app_data.job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    if job.status != "open":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Job is not open for applications")
    # Prevent duplicate applications: one application per applicant per job
    existing = await get_application_by_applicant_and_job(db, current_user.id, app_data.job_id)
    if existing:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You have already applied to this job")
    application = await create_application(db, current_user.id, app_data)

    # Auto-message in the job chat so the owner gets an in-app notification
    from ....crud.message import create_message
    from ....services.ws_manager import manager
    msg = application.message or ""
    auto = await create_message(
        db, app_data.job_id, current_user.id,
        f"📋 {current_user.display_name or 'Someone'} applied for this job."
        + (f"\n“{msg}”" if msg else "")
    )
    await manager.broadcast_new_message(auto)

    return application


@router.get("/mine")
async def my_applications(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Job ids the current user has applied to — used to show an 'Applied' indicator."""
    result = await db.execute(
        select(Application.job_id).where(Application.applicant_id == current_user.id)
    )
    return {"job_ids": [str(jid) for jid in result.scalars().all()]}


@router.get("/job/{job_id}/count")
async def application_count(
    job_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Number of applications on a job (for the count indicator on cards)."""
    from sqlalchemy import func as _func
    result = await db.execute(
        select(_func.count()).select_from(Application).where(Application.job_id == job_id)
    )
    return {"count": result.scalar() or 0}


from sqlalchemy.orm import joinedload
from ....crud.application import get_applications_for_job
from ....crud.user import get_user_by_id

@router.get("/job/{job_id}", response_model=list[ApplicationOut])
async def list_applications_for_job(
    job_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Fetch applications with their applicant and applicant's vouches_received eager-loaded
    stmt = (
        select(Application)
        .options(
            joinedload(Application.applicant).joinedload(User.vouches_received)
        )
        .where(Application.job_id == job_id)
    )
    result = await db.execute(stmt)
    applications = result.unique().scalars().all()

    enriched = []
    for app in applications:
        applicant = app.applicant
        vouch_count = len(applicant.vouches_received) if applicant and applicant.vouches_received else 0

        enriched.append(
            ApplicationOut(
                id=app.id,
                job_id=app.job_id,
                applicant_id=app.applicant_id,
                message=app.message,
                proposed_price=app.proposed_price,
                created_at=app.created_at,
                applicant_name=applicant.display_name if applicant else None,
                applicant_profile_image=applicant.profile_image_url if applicant else None,
                applicant_vouch_count=vouch_count,
                portfolio_url=app.portfolio_url,
            )
        )

    return enriched


@router.delete("/{application_id}", status_code=status.HTTP_204_NO_CONTENT)
async def withdraw_application(
    application_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    app = await get_application_by_id(db, application_id)
    if not app:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Application not found")
    if app.applicant_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Can only withdraw your own application")
    await delete_application(db, app)
    return None