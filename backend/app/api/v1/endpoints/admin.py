from fastapi import APIRouter, Depends, HTTPException, Header, status, Body, Request
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID
from ....core.dependencies import get_db
from ....crud.user import get_users_paginated, delete_user
from ....crud.job import get_jobs_filtered
from ....core.config import settings
from ....crud.user import get_user_by_id
from ....models.user import User

router = APIRouter()

ADMIN_SECRET = settings.ADMIN_SECRET

async def verify_admin(
    request: Request,
    x_admin_secret: str | None = Header(None),
    db: AsyncSession = Depends(get_db),
):
    # 1. Header-based access (legacy / programmatic)
    if x_admin_secret and x_admin_secret == ADMIN_SECRET:
        return True

    # 2. Session-based access for superadmin
    from ....core.dependencies import get_current_user
    try:
        user = await get_current_user(request, db)
        if user and (user.role == "admin" or user.role == "superadmin"):
            return True
    except HTTPException:
        pass

    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")

@router.get("/users")
async def list_users(
    offset: int = 0,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _: bool = Depends(verify_admin),
):
    users = await get_users_paginated(db, offset=offset, limit=limit)
    return users

@router.delete("/users/{user_id}", status_code=204)
async def remove_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _: bool = Depends(verify_admin),
):
    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    await delete_user(db, user)
    return None

@router.get("/jobs")
async def all_jobs(
    status: str = None,
    db: AsyncSession = Depends(get_db),
    _: bool = Depends(verify_admin),
):
    jobs = await get_jobs_filtered(db, status=status, limit=100)
    return jobs

from ....models.user import User
from ....crud.user import get_user_by_email

@router.post("/admins/create")
async def create_admin(
    email: str = Body(..., embed=True),
    _: bool = Depends(verify_admin),
    db: AsyncSession = Depends(get_db),
):
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
    _: bool = Depends(verify_admin),
    db: AsyncSession = Depends(get_db),
):
    """Returns all users with admin or superadmin role."""
    from sqlalchemy import select
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
    _: bool = Depends(verify_admin),
    db: AsyncSession = Depends(get_db),
):
    """Superadmin deletes an admin (demotes to user)."""
    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.role == "superadmin":
        raise HTTPException(status_code=400, detail="Cannot modify superadmin")
    user.role = "user"
    await db.commit()
    return {"message": "Admin demoted to user"}