from fastapi import APIRouter, Depends, HTTPException, Header, status, Body, Request
from sqlalchemy import select, delete as sa_delete
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID
from ....core.dependencies import get_db
from ....crud.user import get_users_paginated, delete_user
from ....crud.job import get_jobs_filtered, get_job_by_id
from ....core.config import settings
from ....crud.user import get_user_by_id
from ....models.user import User

router = APIRouter()

ADMIN_SECRET = settings.ADMIN_SECRET


async def verify_admin(
    request: Request,
    x_admin_secret: str | None = Header(None),
    db: AsyncSession = Depends(get_db),
) -> User:
    """Allow admin or superadmin (or the legacy admin secret header)."""
    # 1. Header-based access (legacy / programmatic)
    if x_admin_secret and x_admin_secret == ADMIN_SECRET:
        return User(id=UUID(int=0), email="system", display_name="System")

    # 2. Session-based access
    from ....core.dependencies import get_current_user
    try:
        user = await get_current_user(request, db)
        if user and (user.role == "admin" or user.role == "superadmin"):
            return user
    except HTTPException:
        pass

    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")


async def verify_superadmin(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User:
    """Only the superadmin. Managing admins, deleting messages and mass
    announcements are powers regular admins should never have."""
    from ....core.dependencies import get_current_user
    try:
        user = await get_current_user(request, db)
        if user and user.role == "superadmin":
            return user
    except HTTPException:
        pass
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Superadmin access required")


@router.get("/users")
async def list_users(
    offset: int = 0,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(verify_admin),
):
    users = await get_users_paginated(db, offset=offset, limit=limit)
    return users


@router.delete("/users/{user_id}", status_code=204)
async def remove_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(verify_admin),
):
    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.role == "superadmin":
        raise HTTPException(status_code=400, detail="Cannot delete the superadmin")
    await delete_user(db, user)
    return None


@router.get("/jobs")
async def all_jobs(
    status: str = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(verify_admin),
):
    jobs = await get_jobs_filtered(db, status=status, limit=limit)
    return jobs


@router.delete("/jobs/{job_id}", status_code=204)
async def delete_job(
    job_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(verify_admin),
):
    """Hard-delete a job and everything attached to it (messages,
    applications, scope amendments, vouches, disputes)."""
    from ....models.job import Job
    from ....models.message import Message
    from ....models.application import Application
    from ....models.scope_amendment import ScopeAmendment
    from ....models.vouch import Vouch
    from ....models.dispute import Dispute

    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    for model in (Message, Application, ScopeAmendment, Vouch, Dispute):
        await db.execute(sa_delete(model).where(model.job_id == job_id))
    await db.delete(job)
    await db.commit()
    return None


@router.get("/services")
async def all_services(
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(verify_admin),
):
    from ....models.service import ServiceListing
    result = await db.execute(
        select(ServiceListing).order_by(ServiceListing.created_at.desc()).limit(limit)
    )
    return result.scalars().all()


@router.delete("/services/{service_id}", status_code=204)
async def delete_service(
    service_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(verify_admin),
):
    from ....models.service import ServiceListing
    from ....models.job import Job
    service = await db.get(ServiceListing, service_id)
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    # Detach jobs that were created by requesting this service, then delete.
    await db.execute(
        sa_delete(Job).where(Job.service_listing_id == service_id)
    )
    await db.delete(service)
    await db.commit()
    return None


@router.get("/messages")
async def all_messages(
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(verify_superadmin),
):
    from ....models.message import Message
    result = await db.execute(
        select(Message).order_by(Message.created_at.desc()).limit(limit)
    )
    return result.scalars().all()


@router.delete("/messages/{message_id}", status_code=204)
async def delete_message(
    message_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(verify_superadmin),
):
    """Superadmin only — message deletion can be abused to rewrite a
    contract-room record, so regular admins never get this power."""
    from ....models.message import Message
    msg = await db.get(Message, message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    await db.delete(msg)
    await db.commit()
    return None


@router.post("/admins/create")
async def create_admin(
    email: str = Body(..., embed=True),
    _: User = Depends(verify_superadmin),
    db: AsyncSession = Depends(get_db),
):
    from ....crud.user import get_user_by_email
    user = await get_user_by_email(db, email)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.role == "superadmin":
        raise HTTPException(status_code=400, detail="Cannot modify superadmin")
    user.role = "admin"
    await db.commit()
    return {"message": f"{email} is now an admin"}


@router.get("/admins", response_model=list)
async def list_admins(
    _: User = Depends(verify_admin),
    db: AsyncSession = Depends(get_db),
):
    """Returns all users with admin or superadmin role."""
    result = await db.execute(
        select(User).where(User.role.in_(["admin", "superadmin"]))
    )
    admins = result.scalars().all()
    return [
        {
            "id": str(a.id),
            "email": a.email,
            "display_name": a.display_name,
            "role": a.role,
        }
        for a in admins
    ]


@router.delete("/admins/{user_id}")
async def delete_admin(
    user_id: UUID,
    _: User = Depends(verify_superadmin),
    db: AsyncSession = Depends(get_db),
):
    """Superadmin demotes an admin back to a regular user."""
    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.role == "superadmin":
        raise HTTPException(status_code=400, detail="Cannot modify superadmin")
    user.role = "user"
    await db.commit()
    return {"message": "Admin demoted to user"}


@router.post("/announce")
async def announce_to_all(
    payload: dict = Body(...),
    _: User = Depends(verify_superadmin),
    db: AsyncSession = Depends(get_db),
):
    """Send a bell notification (and web push, where enabled) to every user."""
    from ....crud.notification import create_notification
    title = str(payload.get("title") or "Announcement")[:120]
    message = str(payload.get("message") or "")[:1000]
    link = str(payload.get("link") or "/dashboard")[:300]
    if not message:
        raise HTTPException(status_code=400, detail="message is required")

    result = await db.execute(select(User.id))
    user_ids = result.scalars().all()
    for uid in user_ids:
        await create_notification(
            db, user_id=uid, title=title, message=message, link=link, type="system",
        )
    await db.commit()
    return {"message": f"Announcement sent to {len(user_ids)} users"}
