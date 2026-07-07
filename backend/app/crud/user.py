import base58 #
from uuid import UUID
from typing import List, Optional
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

async def get_user_by_email(db: AsyncSession, email: str) -> User | None:
    result = await db.execute(select(User).where(User.email == email))
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

async def create_user(db: AsyncSession, user_in: UserCreate) -> User:
    # Generate Solana keypair
    keypair = Keypair()
    f = Fernet(settings.WALLET_ENCRYPTION_KEY.encode())  # Fernet key must be bytes

    # Extract the 32‑byte secret key and encode it in base58
    secret_bytes = bytes(keypair.secret())               # PrivateKey to bytes
    secret_base58 = base58.b58encode(secret_bytes).decode()  # e.g. "5JT..."
    encrypted_secret = f.encrypt(secret_base58.encode()).decode()

    user = User(
        email=user_in.email,
        display_name=user_in.display_name,
        phone_number=user_in.phone_number,
        wallet_public_key=str(keypair.pubkey()),
        _wallet_private_key=encrypted_secret,
    )
    if user_in.password:
        from ..core.security import get_password_hash
        user.hashed_password = get_password_hash(user_in.password)
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user

async def create_user_from_google(db: AsyncSession, email: str, google_id: str, display_name: str, profile_image_url: str | None = None) -> User:
    keypair = Keypair()
    f = Fernet(settings.WALLET_ENCRYPTION_KEY.encode())

    secret_bytes = bytes(keypair.secret())
    secret_base58 = base58.b58encode(secret_bytes).decode()
    encrypted_secret = f.encrypt(secret_base58.encode()).decode()

    user = User(
        email=email,
        google_id=google_id,
        display_name=display_name,
        profile_image_url=profile_image_url,
        is_verified=True,
        wallet_public_key=str(keypair.pubkey()),
        _wallet_private_key=encrypted_secret,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user

async def update_user(db: AsyncSession, user: User, user_in: UserUpdate) -> User:
    data = user_in.model_dump(exclude_unset=True)
    for field, value in data.items():
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
    # This is a hard delete. In production, you might soft delete by setting a is_deleted flag.
    await db.delete(user)
    await db.commit()

async def update_user_location(db: AsyncSession, user: User, latitude: float, longitude: float) -> User:
    from sqlalchemy import text
    user.last_location = text(f"ST_SetSRID(ST_MakePoint({longitude}, {latitude}), 4326)")
    user.last_seen_at = text("NOW()")
    user.location_lat = latitude
    user.location_lng = longitude
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