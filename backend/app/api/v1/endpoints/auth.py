import logging
from datetime import datetime, timedelta, timezone
from fastapi import APIRouter, Body, Depends, HTTPException, status, Response, Request

logger = logging.getLogger(__name__)
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError
from ....core.dependencies import get_db, get_current_user
from ....core.security import (
    create_access_token,
    verify_password,
    decode_access_token,
    create_refresh_token,
    get_password_hash,
    REFRESH_TOKEN_EXPIRE_DAYS,
)
from ....core.config import settings
from ....crud.user import (
    get_user_by_email,
    get_user_by_google_id,
    get_user_by_id,
    create_user,
    create_user_from_google,
)
from ....schemas.user import UserCreate, UserLogin, UserGoogleAuth, UserOut
from ....models.user import User

router = APIRouter()


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def register(user_in: UserCreate, db: AsyncSession = Depends(get_db)):
    existing = await get_user_by_email(db, user_in.email)
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Email already registered")
    if user_in.phone_number:
        from ....crud.user import get_user_by_phone
        existing_phone = await get_user_by_phone(db, user_in.phone_number)
        if existing_phone:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Phone number already registered")
    user = await create_user(db, user_in)
    return user


@router.post("/login")
async def login(login_in: UserLogin, response: Response, db: AsyncSession = Depends(get_db)):
    identifier = login_in.email.strip()
    user = None
    if "@" in identifier:
        user = await get_user_by_email(db, identifier.lower())
    else:
        from ....crud.user import get_user_by_phone
        user = await get_user_by_phone(db, identifier)
        if not user:
            user = await get_user_by_email(db, identifier.lower())

    if not user or not user.hashed_password:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    if not verify_password(login_in.password, user.hashed_password):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid credentials")
    token = create_access_token(data={"sub": str(user.id)})

    # Set httpOnly secure cookie for the frontend
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        secure=settings.SECURE_COOKIES,   # I will set to True in production with HTTPS
        samesite="None",
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )

    refresh_token = create_refresh_token(data={"sub": str(user.id)})
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        secure=settings.SECURE_COOKIES,           # same as access token
        samesite="None",
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 86400,
    )

    return {"access_token": token, "refresh_token": refresh_token, "token_type": "bearer"}


@router.post("/google")
async def google_auth(auth_data: UserGoogleAuth, response: Response, db: AsyncSession = Depends(get_db)):
    import httpx as _httpx
    from google.oauth2 import id_token
    from google.auth.transport import requests

    google_id = email = name = picture = None
    email_verified = False

    if auth_data.access_token:
        # Custom button path: exchange the OAuth access token for the user's
        # profile via Google's userinfo endpoint.
        try:
            async with _httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    "https://www.googleapis.com/oauth2/v3/userinfo",
                    headers={"Authorization": f"Bearer {auth_data.access_token}"},
                )
                resp.raise_for_status()
                info = resp.json()
        except Exception as e:
            logger.warning("Google userinfo fetch failed: %s", e)
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid Google access token")
        google_id = info.get("sub")
        email = info.get("email")
        name = info.get("name", email)
        picture = info.get("picture")
        # userinfo returns email_verified as bool or string
        email_verified = str(info.get("email_verified", "false")).lower() == "true"
    elif auth_data.token:
        # ID-token path (classic GoogleLogin button).
        # verify_oauth2_token makes a BLOCKING network call (fetches Google's
        # signing certs). Running it directly on the event loop stalls every
        # other request and can make the dev proxy return 502. Offload it.
        import asyncio
        try:
            idinfo = await asyncio.to_thread(
                id_token.verify_oauth2_token,
                auth_data.token, requests.Request(), settings.GOOGLE_CLIENT_ID
            )
        except ValueError as e:
            logger.warning("Google token verification failed: %s", e)
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid Google token: {str(e)}")
        google_id = idinfo["sub"]
        email = idinfo.get("email")
        name = idinfo.get("name", email)
        picture = idinfo.get("picture")
        email_verified = bool(idinfo.get("email_verified"))
    else:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No Google credential provided")

    if not email or not google_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Google profile incomplete")
    if not email_verified:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Google account email is not verified")

    user = await get_user_by_google_id(db, google_id)
    if not user:
        user = await get_user_by_email(db, email)
        if user:
            user.google_id = google_id
            if picture and not user.profile_image_url:
                user.profile_image_url = picture
            await db.commit()
        else:
            try:
                user = await create_user_from_google(db, email, google_id, name, picture)
            except IntegrityError:
                # Two google-auth requests raced to create the same user
                # (e.g. a double-click). Roll back and fetch the winner.
                await db.rollback()
                user = await get_user_by_google_id(db, google_id) or await get_user_by_email(db, email)
                if not user:
                    raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                                        detail="Could not create account, please retry.")

    token = create_access_token(data={"sub": str(user.id)})

    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        secure=settings.SECURE_COOKIES,   # True in production with HTTPS
        samesite="None",
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )

    refresh_token = create_refresh_token(data={"sub": str(user.id)})
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        secure=settings.SECURE_COOKIES,           # same as access token
        samesite="None",
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 86400,
    )

    return {"access_token": token, "refresh_token": refresh_token, "token_type": "bearer"}


# @router.get("/me", response_model=UserOut)
# async def me(current_user: User = Depends(get_current_user)):
#     return current_user
from fastapi import Security
from ....core.security import bearer_scheme

@router.get("/me", response_model=UserOut)
async def me(
    current_user: User = Depends(get_current_user),
    _bearer: str = Security(bearer_scheme),   # Only to trigger OpenAPI security
):
    return current_user

@router.post("/link-google")
async def link_google(
    auth_data: UserGoogleAuth,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from google.oauth2 import id_token as google_id_token
    from google.auth.transport import requests as google_requests

    try:
        idinfo = google_id_token.verify_oauth2_token(
            auth_data.token,
            google_requests.Request(),
            settings.GOOGLE_CLIENT_ID
        )
    except ValueError as e:
        raise HTTPException(status_code=401, detail=f"Invalid Google token: {e}")
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Google verification failed: {e}")

    if not idinfo.get("email_verified"):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Google account email is not verified")

    google_id = idinfo["sub"]
    google_email = idinfo.get("email")
    google_name = idinfo.get("name")
    google_picture = idinfo.get("picture")

    # Check if this Google account is already linked to another user
    existing = await get_user_by_google_id(db, google_id)
    if existing and existing.id != current_user.id:
        raise HTTPException(status_code=409, detail="Google account already linked to another user")

    # Link Google ID
    current_user.google_id = google_id

    # Update display name from Google (always safe)
    if google_name:
        current_user.display_name = google_name
        
    if google_picture and not current_user.profile_image_url:
        current_user.profile_image_url = google_picture

    # Update email only if it's different and not already taken by another user
    if google_email and google_email != current_user.email:
        email_owner = await get_user_by_email(db, google_email)
        if email_owner and email_owner.id != current_user.id:
            raise HTTPException(status_code=409, detail="Google email is already used by another account")
        current_user.email = google_email
        
    current_user.is_verified = True

    await db.commit()
    return {"message": "Google account linked"}


@router.post("/refresh")
async def refresh_access_token(request: Request, response: Response):
    """Exchange a refresh token for a new access token — and rotate the refresh.

    The refresh token is accepted from the HttpOnly cookie OR the JSON body,
    because cross-site deployments (Vercel frontend + Render backend) have
    third-party cookies blocked by Safari and Chrome. Relying on the cookie alone
    meant refresh always failed there and the session died when the 24h access
    token expired. Rotating on every refresh slides the window forward, so an
    active user stays signed in indefinitely.
    """
    body_token = None
    try:
        if "application/json" in (request.headers.get("content-type") or ""):
            payload_body = await request.json()
            if isinstance(payload_body, dict):
                body_token = payload_body.get("refresh_token")
    except Exception:
        body_token = None

    refresh_token = request.cookies.get("refresh_token") or body_token
    if not refresh_token:
        raise HTTPException(status_code=401, detail="No refresh token")

    payload = decode_access_token(refresh_token)
    if payload is None or payload.get("type") != "refresh":
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(status_code=401, detail="Invalid refresh token")

    new_access = create_access_token(data={"sub": user_id})
    new_refresh = create_refresh_token(data={"sub": user_id})

    cookie_kwargs = {
        "httponly": True,
        "secure": settings.SECURE_COOKIES,
        "samesite": "None",
    }
    response.set_cookie(
        key="access_token",
        value=new_access,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        **cookie_kwargs,
    )
    response.set_cookie(
        key="refresh_token",
        value=new_refresh,
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        **cookie_kwargs,
    )

    # Return both, so clients that cannot use cookies can keep the session alive.
    return {
        "status": "ok",
        "access_token": new_access,
        "refresh_token": new_refresh,
        "token_type": "bearer",
    }

@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie("access_token")
    response.delete_cookie("refresh_token")
    return {"message": "Logged out"}


def _send_auth_email_background(to_email: str, subject: str, html_body: str) -> None:
    """Non-blocking email dispatch via Brevo."""
    import asyncio
    async def _send() -> None:
        try:
            from ....services.brevo_client import send_email
            await send_email(to_email, subject, html_body)
        except Exception as exc:
            logger.warning("[auth] Background email failed for %s: %s", to_email, exc)
    asyncio.create_task(_send())


# ── Forgot / reset password (non-OAuth and OAuth users) ───────────────────────

@router.post("/forgot-password")
async def forgot_password(
    payload: dict = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """Email a one-time reset link. Always returns a generic message to prevent
    user enumeration."""
    from secrets import token_urlsafe
    import hashlib
    from ....models.password_reset_token import PasswordResetToken

    raw_identifier = str(payload.get("email") or "").strip()
    user = None
    if "@" in raw_identifier:
        user = await get_user_by_email(db, raw_identifier.lower())
    elif raw_identifier:
        from ....crud.user import get_user_by_phone
        user = await get_user_by_phone(db, raw_identifier)
        if not user:
            user = await get_user_by_email(db, raw_identifier.lower())

    if user and user.email:
        token = token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        db.add(PasswordResetToken(
            user_id=user.id,
            token_hash=token_hash,
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        ))
        await db.commit()

        frontend_url = (settings.FRONTEND_URL or "https://gigrr.vercel.app").rstrip("/")
        reset_url = f"{frontend_url}/reset-password?token={token}"
        user_name = user.display_name or "there"

        is_oauth_account = not user.hashed_password
        context_msg = (
            "We received a request to set a password for your Gigr account (which was registered with Google). "
            "Setting a password lets you sign in with both your email and password."
            if is_oauth_account
            else "We received a request to reset the password for your Gigr account."
        )

        html = f"""<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="margin:0;padding:0;background-color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
  <div style="max-width:560px;margin:32px auto;padding:32px 24px;background-color:#ffffff;border-radius:16px;border:1px solid #e5e7eb;box-shadow:0 1px 3px rgba(0,0,0,0.05)">
    <div style="margin-bottom:24px">
      <h2 style="font-size:22px;font-weight:700;margin:0 0 8px;color:#111827">Reset your Gigr password</h2>
      <p style="font-size:14px;color:#4b5563;margin:0">Hello {user_name},</p>
    </div>
    <p style="font-size:14px;line-height:1.6;color:#374151;margin:0 0 20px">{context_msg} This link expires in <strong>1 hour</strong>.</p>
    <div style="margin:28px 0;text-align:center">
      <a href="{reset_url}" style="display:inline-block;background-color:#000000;color:#ffffff;padding:12px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:14px">Reset Password</a>
    </div>
    <p style="font-size:12px;color:#6b7280;line-height:1.5;margin:0 0 16px">If the button does not work, copy and paste this link into your browser:<br><span style="color:#2563eb;word-break:break-all">{reset_url}</span></p>
    <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 16px" />
    <p style="margin:0;font-size:12px;color:#9ca3af">If you did not request a password reset, you can safely ignore this email.</p>
  </div>
</body>
</html>"""
        _send_auth_email_background(user.email, "Reset your Gigr password", html)

    return {"message": "If that email or phone number belongs to an account, a reset link has been sent to the registered email."}


@router.post("/reset-password")
async def reset_password(
    payload: dict = Body(...),
    db: AsyncSession = Depends(get_db),
):
    """Set a new password using a one-time reset token."""
    import hashlib
    from sqlalchemy import select as _select
    from ....models.password_reset_token import PasswordResetToken

    token = str(payload.get("token") or "").strip()
    new_password = str(payload.get("new_password") or "")
    if not token:
        raise HTTPException(status_code=400, detail="Reset token is required")
    if len(new_password) < 6:
        raise HTTPException(status_code=400, detail="Password must be at least 6 characters")

    token_hash = hashlib.sha256(token.encode()).hexdigest()
    row = (await db.execute(
        _select(PasswordResetToken).where(PasswordResetToken.token_hash == token_hash)
    )).scalar_one_or_none()
    if not row or row.expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=400, detail="Invalid or expired reset link")

    user = await get_user_by_id(db, row.user_id)
    if not user:
        raise HTTPException(status_code=400, detail="Invalid reset link")

    user.hashed_password = get_password_hash(new_password)
    await db.delete(row)
    await db.commit()
    return {"message": "Password updated successfully. You can now sign in."}

