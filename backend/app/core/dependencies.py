from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession
from fastapi import Depends, HTTPException, status, Request
from .database import async_session
from .security import get_token_from_request, decode_access_token
from ..crud.user import get_user_by_id


async def get_db() -> AsyncGenerator[AsyncSession, None]:
    async with async_session() as session:
        yield session


async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    token = await get_token_from_request(request)
    payload = decode_access_token(token)
    if payload is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    if payload.get("type") == "refresh":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Refresh token cannot be used for authentication")
    user_id: str | None = payload.get("sub")
    if user_id is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    user = await get_user_by_id(db, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")
    # Someone who signed up before Solana was available (or while it was off)
    # gets a wallet the first time they use the app on the Solana rail.
    from .rail import current_rail
    if not user.wallet_public_key and current_rail() == "solana":
        from ..crud.user import ensure_wallet
        await ensure_wallet(db, user)
    return user


async def require_ai_enabled(current_user=Depends(get_current_user)):
    """Dependency that blocks access to AI features when ai_enabled is False."""
    if not getattr(current_user, "ai_enabled", True):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="AI features are not enabled for your account.",
        )
    return current_user


async def require_premium_agent(current_user=Depends(get_current_user)):
    """Block access to premium agent features when the global premium gate is enabled
    and the user does not have a premium subscription.

    When FEATURE_AGENT_PREMIUM is False (the default), this dependency is a
    pass-through so all agent features remain open. Flip the flag to True once a
    subscription check is wired to activate the paywall.
    """
    from .config import settings

    if not settings.FEATURE_AGENT_PREMIUM:
        return current_user

    subscription_tier = getattr(current_user, "subscription_tier", None)
    if subscription_tier not in ("pro", "enterprise"):
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail=(
                "This agent feature requires a Pro subscription. "
                "Upgrade in your account settings to unlock it."
            ),
        )
    return current_user