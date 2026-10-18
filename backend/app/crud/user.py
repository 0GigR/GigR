import base58 #
from uuid import UUID
from typing import List, Optional
from fastapi import HTTPException
from sqlalchemy import select, update as sql_update, delete as sql_delete, func
from sqlalchemy.ext.asyncio import AsyncSession
from ..models.user import User
from ..schemas.user import UserCreate, UserUpdate
from ..core.security import get_password_hash, verify_password
from solders.keypair import Keypair
from cryptography.fernet import Fernet
from ..core.config import settings

async def get_user_by_id(db: AsyncSession, user_id: UUID) -> User | None:
    result = await db.execute(select(User).where(User.id == user_id))
    return result.scalar_one_or_none()

async def get_user_by_id_or_username(db: AsyncSession, identifier: str) -> User | None:
    if not identifier:
        return None
    cleaned = str(identifier).strip().lower()

    # 1. Try UUID parse
    try:
        user_uuid = UUID(cleaned)
        result = await db.execute(select(User).where(User.id == user_uuid))
        matched = result.scalar_one_or_none()
        if matched:
            return matched
    except (ValueError, AttributeError):
        pass

    # 2. Try explicit username column match
    result = await db.execute(select(User).where(func.lower(User.username) == cleaned))
    matched = result.scalar_one_or_none()
    if matched:
        return matched

    # 3. Match slugified display_name (e.g. "janet" or "janet-okafor")
    result = await db.execute(
        select(User).where(
            func.lower(func.replace(User.display_name, " ", "-")) == cleaned
        )
    )
    matched = result.scalar_one_or_none()
    if matched:
        return matched

    # 4. Direct case-insensitive display_name match
    result = await db.execute(select(User).where(func.lower(User.display_name) == cleaned))
    return result.scalar_one_or_none()

async def get_user_by_email(db: AsyncSession, email: str) -> User | None:
    if not email:
        return None
    cleaned = email.strip().lower()
    result = await db.execute(select(User).where(func.lower(User.email) == cleaned))
    return result.scalar_one_or_none()

async def get_user_by_phone(db: AsyncSession, phone: str) -> User | None:
    from ..core.phone import normalize_phone_number
    normalized = normalize_phone_number(phone)
    if not normalized:
        return None
    result = await db.execute(select(User).where(User.phone_number == normalized))
    return result.scalar_one_or_none()

async def get_user_by_google_id(db: AsyncSession, google_id: str) -> User | None:
    result = await db.execute(select(User).where(User.google_id == google_id))
    return result.scalar_one_or_none()

async def get_users_paginated(
    db: AsyncSession,
    offset: int = 0,
    limit: int = 20,
    search: Optional[str] = None
) -> List[User]:
    query = select(User)
    if search:
        query = query.where(User.display_name.ilike(f"%{search}%"))
    query = query.order_by(User.created_at.desc()).limit(limit).offset(offset)
    result = await db.execute(query)
    return result.scalars().all()

def _new_wallet_fields() -> dict:
    """Solana wallet columns for a new user — only on the Solana rail.

    On the PayPal rail users have no on-chain wallet at all; money moves through
    their PayPal account, so these columns stay NULL.
    """
    if settings.PAYMENT_RAIL != "solana":
        return {}
    keypair = Keypair()
    f = Fernet(settings.WALLET_ENCRYPTION_KEY.encode())  # Fernet key must be bytes
    # Extract the 32‑byte secret key and encode it in base58
    secret_bytes = bytes(keypair.secret())               # PrivateKey to bytes
    secret_base58 = base58.b58encode(secret_bytes).decode()  # e.g. "5JT..."
    encrypted_secret = f.encrypt(secret_base58.encode()).decode()
    return {
        "wallet_public_key": str(keypair.pubkey()),
        "_wallet_private_key": encrypted_secret,
    }


async def create_user(db: AsyncSession, user_in: UserCreate) -> User:
    user = User(
        email=user_in.email,
        display_name=user_in.display_name,
        phone_number=user_in.phone_number,
        **_new_wallet_fields(),
    )
    if user_in.password:
        from ..core.security import get_password_hash
        user.hashed_password = get_password_hash(user_in.password)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user

async def create_user_from_google(db: AsyncSession, email: str, google_id: str, display_name: str, profile_image_url: str | None = None) -> User:
    user = User(
        email=email,
        google_id=google_id,
        display_name=display_name,
        profile_image_url=profile_image_url,
        is_verified=True,
        **_new_wallet_fields(),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user

async def update_user(db: AsyncSession, user: User, user_in: UserUpdate) -> User:
    data = user_in.model_dump(exclude_unset=True)
    for field, value in data.items():
        if field in ("ai_settings", "ui_settings") and isinstance(value, dict):
            # MERGE, don't replace. The client PATCHes just the switches it knows
            # about (autonomyLevel, voiceEnabled, voiceLanguage), so a blind
            # setattr wiped the sibling keys the client never sends — namely
            # ai_settings["call"] (phone-call preferences) and
            # ai_settings["memory"] (what the agent remembers about the user).
            merged = dict(getattr(user, field) or {})
            merged.update(value)
            setattr(user, field, merged)
        elif field == "username":
            if value:
                cleaned_username = str(value).strip().lower().replace("@", "")
                if cleaned_username:
                    existing = await db.execute(
                        select(User.id).where(
                            func.lower(User.username) == cleaned_username,
                            User.id != user.id,
                        )
                    )
                    if existing.scalar_one_or_none():
                        raise HTTPException(
                            status_code=400,
                            detail="Username is already taken. Please choose another.",
                        )
                    setattr(user, field, cleaned_username)
                else:
                    setattr(user, field, None)
            else:
                setattr(user, field, None)
        else:
            setattr(user, field, value)
    await db.commit()
    await db.refresh(user)
    return user

async def change_password(db: AsyncSession, user: User, old_password: str, new_password: str) -> bool:
    if not user.hashed_password or not verify_password(old_password, user.hashed_password):
        return False
    user.hashed_password = get_password_hash(new_password)
    await db.commit()
    return True

async def delete_user(db: AsyncSession, user: User) -> None:
    """Hard-delete a user and everything they own, in FK-safe order.

    The schema has almost no ON DELETE CASCADE (only ratings, push
    subscriptions, agent tasks, reset tokens, voice calls), so every other
    row referencing the user must be removed explicitly: their jobs (with
    messages, applications, scope amendments, vouches, disputes + votes and
    juries), services, notifications, and messages they sent on other jobs.
    """
    from sqlalchemy import delete, or_, update, func as _func
    from ..models.job import Job
    from ..models.message import Message
    from ..models.application import Application
    from ..models.scope_amendment import ScopeAmendment
    from ..models.vouch import Vouch
    from ..models.dispute import Dispute
    from ..models.vote import Vote
    from ..models.jury_panel import JuryPanel
    from ..models.service import ServiceListing
    from ..models.notification import Notification
    from ..models.announcement import Announcement

    # Jobs the user owns (as client or provider) — their children must go too.
    user_job_ids = select(Job.id).where(
        or_(Job.client_id == user.id, Job.provider_id == user.id)
    )
    # Disputes involving the user or their jobs, incl. votes + jury panels.
    user_dispute_ids = select(Dispute.id).where(or_(
        Dispute.client_id == user.id,
        Dispute.provider_id == user.id,
        Dispute.raised_by == user.id,
        Dispute.job_id.in_(user_job_ids),
    ))

    await db.execute(delete(Vote).where(or_(
        Vote.juror_id == user.id,
        Vote.dispute_id.in_(user_dispute_ids),
    )))
    await db.execute(delete(JuryPanel).where(or_(
        JuryPanel.juror_id == user.id,
        JuryPanel.dispute_id.in_(user_dispute_ids),
    )))
    await db.execute(delete(Dispute).where(or_(
        Dispute.client_id == user.id,
        Dispute.provider_id == user.id,
        Dispute.raised_by == user.id,
        Dispute.job_id.in_(user_job_ids),
    )))

    await db.execute(delete(Message).where(or_(
        Message.sender_id == user.id,
        Message.applicant_id == user.id,
        Message.job_id.in_(user_job_ids),
    )))
    await db.execute(delete(Application).where(or_(
        Application.applicant_id == user.id,
        Application.job_id.in_(user_job_ids),
    )))
    await db.execute(delete(ScopeAmendment).where(ScopeAmendment.job_id.in_(user_job_ids)))
    await db.execute(delete(Vouch).where(or_(
        Vouch.voucher_id == user.id,
        Vouch.vouchee_id == user.id,
        Vouch.job_id.in_(user_job_ids),
    )))
    await db.execute(delete(Job).where(or_(Job.client_id == user.id, Job.provider_id == user.id)))
    await db.execute(delete(ServiceListing).where(ServiceListing.provider_id == user.id))
    await db.execute(delete(Notification).where(Notification.user_id == user.id))
    # Drop other users' notifications pointing at this user's deleted job chats.
    chat_tags = select(_func.concat("chat:", Job.id)).where(
        or_(Job.client_id == user.id, Job.provider_id == user.id)
    )
    await db.execute(delete(Notification).where(Notification.tag.in_(chat_tags)))
    # Announcements are broadcast — keep them, just detach the creator.
    await db.execute(
        update(Announcement).where(Announcement.created_by == user.id).values(created_by=None)
    )

    await db.delete(user)
    await db.commit()

async def update_user_location(
    db: AsyncSession,
    user: User,
    latitude: float,
    longitude: float,
    sync_services_mode: str = "all",
) -> User:
    from ..core.geo import to_wkt_point
    user.last_location = to_wkt_point(latitude, longitude)
    user.last_seen_at = text("NOW()")
    user.location_lat = latitude
    user.location_lng = longitude

    # Only sync provider's service listing coordinates if requested
    if sync_services_mode == "all":
        from sqlalchemy import update as _update
        from ..core.geo import to_wkt_point
        await db.execute(
            _update(ServiceListing)
            .where(ServiceListing.provider_id == user.id)
            .values(location=to_wkt_point(latitude, longitude))
        )
    await db.commit()
    await db.refresh(user)
    return user

from sqlalchemy import func, text
from geoalchemy2 import Geography
from geoalchemy2 import functions as geo_func
from ..models.vouch import Vouch
from ..models.user import User

async def get_eligible_jurors(db: AsyncSession, job_location: Geography, min_vouches: int = 1) -> List[User]:
    # Find users within 5 km of the job's location who have at least `min_vouches` vouches
    distance_col = geo_func.ST_DistanceSphere(User.last_location, func.ST_GeomFromEWKT(func.ST_AsEWKT(job_location))).label("distance")
    subq = select(Vouch.vouchee_id, func.count(Vouch.id).label("vouch_count")).group_by(Vouch.vouchee_id).having(func.count(Vouch.id) >= min_vouches).subquery()
    query = (
        select(User)
        .join(subq, User.id == subq.c.vouchee_id)
        .where(
            geo_func.ST_DWithin(
                User.last_location,
                job_location,
                5000  # 5 km in meters
            ),
            User.last_location.isnot(None)
        )
    )
    result = await db.execute(query)
    return result.scalars().all()