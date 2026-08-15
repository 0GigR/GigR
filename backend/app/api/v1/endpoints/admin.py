from fastapi import APIRouter, Depends, HTTPException, Header, status, Body, Request
from sqlalchemy import select, delete as sa_delete, or_
from sqlalchemy.ext.asyncio import AsyncSession
from uuid import UUID
from datetime import datetime, timedelta, timezone
from ....core.dependencies import get_db
from ....crud.user import get_users_paginated, delete_user, get_user_by_email, get_user_by_id
from ....crud.job import get_jobs_filtered, get_job_by_id
from ....crud.notification import create_notification
from ....core.config import settings
from ....models.user import User

router = APIRouter()

ADMIN_SECRET = settings.ADMIN_SECRET

# ── IAM-style permission catalog ─────────────────────────────────────────────
# The superadmin tags each admin with a subset of these slugs (like AWS
# *FullAccess policies). Superadmin always has every permission; regular
# users have none.
PERMISSION_SLUGS: dict[str, str] = {
    "jobs:manage": "Delete any job",
    "services:manage": "Delete any service listing",
    "users:manage": "Delete users",
    "messages:manage": "Delete contract-room messages (forgery risk — grant carefully)",
    "disputes:manage": "Resolve disputes",
    "announce:manage": "Send announcements to users",
}


async def _admin_or_secret(request: Request, db: AsyncSession) -> User | None:
    """Return the acting admin (or a synthetic 'system' user for the legacy
    admin-secret header), or None when the caller has no admin power."""
    x_admin_secret = request.headers.get("x-admin-secret")
    if x_admin_secret and ADMIN_SECRET and x_admin_secret == ADMIN_SECRET:
        return User(id=UUID(int=0), email="system", display_name="System", role="superadmin")

    from ....core.dependencies import get_current_user
    try:
        user = await get_current_user(request, db)
        if user and user.role in ("admin", "superadmin"):
            return user
    except HTTPException:
        pass
    return None


async def verify_admin(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User:
    """Allow admin or superadmin (or the legacy admin secret header)."""
    user = await _admin_or_secret(request, db)
    if not user:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
    return user


async def verify_superadmin(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User:
    """Only the superadmin. Managing admins, granting powers and mass
    announcements are decisions regular admins must never make for themselves."""
    from ....core.dependencies import get_current_user
    try:
        user = await get_current_user(request, db)
        if user and user.role == "superadmin":
            return user
    except HTTPException:
        pass
    raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Superadmin access required")


def require_perm(perm: str):
    """Dependency factory: the caller must be an admin WITH the given slug
    (superadmin and the admin-secret header bypass the check entirely)."""
    async def dependency(
        request: Request,
        db: AsyncSession = Depends(get_db),
    ) -> User:
        user = await _admin_or_secret(request, db)
        if not user:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
        if user.role == "superadmin":
            return user
        if user.role == "admin" and perm in (user.permissions or []):
            return user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Missing permission: {perm}",
        )
    return dependency


# ── Users ────────────────────────────────────────────────────────────────────

@router.get("/users")
async def list_users(
    offset: int = 0,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_perm("users:manage")),
):
    users = await get_users_paginated(db, offset=offset, limit=limit)
    # Raw ORM rows carry PostGIS WKBElement fields that FastAPI can't
    # serialise — project a safe subset instead of returning the objects.
    return [
        {
            "id": str(u.id),
            "email": u.email,
            "display_name": u.display_name,
            "role": u.role,
            "created_at": u.created_at.isoformat() if u.created_at else None,
            "last_seen_at": u.last_seen_at.isoformat() if u.last_seen_at else None,
        }
        for u in users
    ]


@router.delete("/users/{user_id}", status_code=204)
async def remove_user(
    user_id: str,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_perm("users:manage")),
):
    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.role == "superadmin":
        raise HTTPException(status_code=400, detail="Cannot delete the superadmin")
    await delete_user(db, user)
    return None


# ── Jobs / Services / Messages ───────────────────────────────────────────────

@router.get("/jobs")
async def all_jobs(
    status: str = None,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_perm("jobs:manage")),
):
    jobs = await get_jobs_filtered(db, status=status, limit=limit)
    # Raw ORM rows carry a PostGIS geography column FastAPI can't serialise
    # (WKBElement) — project a safe subset.
    return [
        {
            "id": str(j.id),
            "title": j.title,
            "description": j.description,
            "price": str(j.price) if j.price is not None else None,
            "status": j.status,
            "client_id": str(j.client_id) if j.client_id else None,
            "provider_id": str(j.provider_id) if j.provider_id else None,
            "created_at": j.created_at.isoformat() if j.created_at else None,
        }
        for j in jobs
    ]


@router.delete("/jobs/{job_id}", status_code=204)
async def delete_job(
    job_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_perm("jobs:manage")),
):
    """Hard-delete a job and everything attached to it (messages,
    applications, scope amendments, vouches, disputes)."""
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
    _: User = Depends(require_perm("services:manage")),
):
    from ....models.service import ServiceListing
    result = await db.execute(
        select(ServiceListing).order_by(ServiceListing.created_at.desc()).limit(limit)
    )
    services = result.scalars().all()
    return [
        {
            "id": str(s.id),
            "title": s.title,
            "description": s.description,
            "price": str(s.price) if s.price is not None else None,
            "provider_id": str(s.provider_id) if s.provider_id else None,
            "created_at": s.created_at.isoformat() if s.created_at else None,
        }
        for s in services
    ]


@router.delete("/services/{service_id}", status_code=204)
async def delete_service(
    service_id: UUID,
    db: AsyncSession = Depends(get_db),
    _: User = Depends(require_perm("services:manage")),
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
    _: User = Depends(require_perm("messages:manage")),
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
    _: User = Depends(require_perm("messages:manage")),
):
    """Message deletion can be abused to rewrite a contract-room record, so
    only admins explicitly granted 'messages:manage' (normally just the
    superadmin) ever get this power."""
    from ....models.message import Message
    msg = await db.get(Message, message_id)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    await db.delete(msg)
    await db.commit()
    return None


# ── Admin management (superadmin only) ───────────────────────────────────────

@router.post("/admins/create")
async def create_admin(
    payload: dict = Body(...),
    _: User = Depends(verify_superadmin),
    db: AsyncSession = Depends(get_db),
):
    email = str(payload.get("email") or "").strip().lower()
    if not email:
        raise HTTPException(status_code=400, detail="email is required")
    user = await get_user_by_email(db, email)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.role == "superadmin":
        raise HTTPException(status_code=400, detail="Cannot modify superadmin")
    user.role = "admin"
    # Optional IAM-style slugs picked at creation time
    perms = payload.get("permissions") or []
    user.permissions = [p for p in perms if p in PERMISSION_SLUGS]
    await db.commit()
    return {"message": f"{email} is now an admin", "permissions": user.permissions or []}


@router.get("/admins", response_model=list)
async def list_admins(
    _: User = Depends(verify_admin),
    db: AsyncSession = Depends(get_db),
):
    """Returns all users with admin or superadmin role, with their permissions."""
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
            "permissions": a.permissions or [],
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
    user.permissions = []
    await db.commit()
    return {"message": "Admin demoted to user"}


@router.post("/admins/{user_id}/permissions")
async def set_admin_permissions(
    user_id: UUID,
    payload: dict = Body(...),
    _: User = Depends(verify_superadmin),
    db: AsyncSession = Depends(get_db),
):
    """Superadmin tags an admin with IAM-style permission slugs."""
    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if user.role == "superadmin":
        raise HTTPException(status_code=400, detail="Cannot modify superadmin")
    if user.role != "admin":
        raise HTTPException(status_code=400, detail="Only admins can hold permissions")
    perms = payload.get("permissions") or []
    user.permissions = list(dict.fromkeys(p for p in perms if p in PERMISSION_SLUGS))
    await db.commit()
    return {"message": "Permissions updated", "permissions": user.permissions}


# ── Announcements ────────────────────────────────────────────────────────────

def _announcement_email_html(title: str, message: str, image_url: str | None, link: str | None) -> str:
    img = f'<p style="margin:0 0 16px"><img src="{image_url}" alt="" style="max-width:100%;border-radius:12px;display:block"/></p>' if image_url else ""
    btn = (
        f'<p style="margin:20px 0 0"><a href="{link}" '
        'style="display:inline-block;background:#000;color:#fff;padding:12px 24px;'
        'border-radius:9999px;text-decoration:none;font-weight:600">Open Gigr</a></p>'
    ) if link else ""
    return f"""<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif">
<div style="max-width:520px;margin:0 auto;padding:24px;background:#ffffff;border-radius:16px">
<h1 style="font-size:20px;margin:0 0 12px;color:#111">{title}</h1>
{img}
<p style="font-size:15px;line-height:1.6;color:#333;margin:0;white-space:pre-wrap">{message}</p>
{btn}
<p style="margin:24px 0 0;font-size:12px;color:#999">You're receiving this because you have a Gigr account.</p>
</div></body></html>"""


@router.post("/announce")
async def announce_to_all(
    payload: dict = Body(...),
    admin: User = Depends(require_perm("announce:manage")),
    db: AsyncSession = Depends(get_db),
):
    """Send a rich announcement to users: bell notification + web push + a
    dismissible in-app popup, and an email to stale users (last seen > N days).

    Body: {title?, message, image_url?, link?, target?: "all"|"inactive",
           inactive_days?: int (default 10)}
    """
    from ....models.announcement import Announcement
    from ....api.v1.endpoints import jobs as _jobs

    title = str(payload.get("title") or "Announcement")[:120]
    message = str(payload.get("message") or "")[:2000]
    image_url = str(payload.get("image_url") or "")[:500] or None
    link = str(payload.get("link") or "")[:500] or None
    target = str(payload.get("target") or "all")
    try:
        inactive_days = int(payload.get("inactive_days") or 10)
    except (TypeError, ValueError):
        inactive_days = 10

    if not message.strip() and not image_url:
        raise HTTPException(status_code=400, detail="message is required")

    announcement = Announcement(
        title=title,
        message=message,
        image_url=image_url,
        link=link,
        created_by=None if admin.id == UUID(int=0) else admin.id,
    )
    db.add(announcement)
    await db.flush()  # assign announcement.id for the notification tag

    # Recipient filter
    query = select(User)
    if target == "inactive":
        cutoff = datetime.now(timezone.utc) - timedelta(days=inactive_days)
        query = query.where(or_(User.last_seen_at.is_(None), User.last_seen_at < cutoff))
    result = await db.execute(query)
    users = result.scalars().all()

    for u in users:
        await create_notification(
            db,
            user_id=u.id,
            title=title,
            message=message,
            link=link or "/dashboard",
            type="system",
            tag=f"announcement:{announcement.id}",
        )
    await db.commit()

    # Emails for stale users — background, non-blocking.
    if target == "inactive" and settings.BREVO_API_KEY and users:
        for u in users:
            if u.email:
                _jobs._send_email_background(
                    u.email,
                    f"{title} — Gigr",
                    _announcement_email_html(title, message, image_url, link),
                )

    return {
        "message": f"Announcement sent to {len(users)} users",
        "recipients": len(users),
        "announcement_id": str(announcement.id),
    }
