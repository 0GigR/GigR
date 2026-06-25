from uuid import UUID
from typing import List
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from ..models.application import Application
from ..schemas.application import ApplicationCreate

async def get_application_by_id(db: AsyncSession, application_id: UUID) -> Application | None:
    result = await db.execute(select(Application).where(Application.id == application_id))
    return result.scalar_one_or_none()

async def get_applications_for_job(db: AsyncSession, job_id: UUID) -> List[Application]:
    result = await db.execute(
        select(Application).where(Application.job_id == job_id).order_by(Application.created_at.desc())
    )
    return result.scalars().all()

async def get_applications_by_applicant(db: AsyncSession, applicant_id: UUID, limit: int = 20, offset: int = 0) -> List[Application]:
    result = await db.execute(
        select(Application)
        .where(Application.applicant_id == applicant_id)
        .order_by(Application.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    return result.scalars().all()

async def get_application_by_applicant_and_job(db: AsyncSession, applicant_id: UUID, job_id: UUID) -> Application | None:
    result = await db.execute(
        select(Application)
        .where(Application.applicant_id == applicant_id, Application.job_id == job_id)
        .order_by(Application.created_at.asc())
    )
    return result.scalars().first()


async def create_application(db: AsyncSession, applicant_id: UUID, app_in: ApplicationCreate) -> Application:
    application = Application(
        job_id=app_in.job_id,
        applicant_id=applicant_id,
        message=app_in.message,
        proposed_price=app_in.proposed_price,
    )
    db.add(application)
    await db.commit()
    await db.refresh(application)
    return application

async def delete_application(db: AsyncSession, application: Application) -> None:
    await db.delete(application)
    await db.commit()