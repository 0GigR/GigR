from datetime import datetime, timedelta, timezone
import jwt
from jwt.exceptions import InvalidTokenError
import bcrypt
from fastapi import HTTPException, status, Request
from fastapi.security import HTTPBearer, APIKeyCookie
from .config import settings

# We use the `bcrypt` library directly instead of passlib. passlib 1.7.4
# (unmaintained since 2020) crashes on init with bcrypt >= 4.1 / 5.x
# ("password cannot be longer than 72 bytes"), which broke ALL password
# hashing and verification (registration + email login). bcrypt hashes are
# standard $2b$ so existing hashes remain verifiable.

# Simple Bearer token scheme for Swagger UI (shows just a token input)
bearer_scheme = HTTPBearer(auto_error=False)
bearer_scheme = HTTPBearer(auto_error=False, scheme_name="BearerAuth")

# Cookie scheme to read token from "access_token" cookie
cookie_scheme = APIKeyCookie(name="access_token", auto_error=False)


def _to_72_bytes(password: str) -> bytes:
    """bcrypt only uses the first 72 bytes; longer inputs raise in bcrypt 5.x."""
    return password.encode("utf-8")[:72]


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        return bcrypt.checkpw(_to_72_bytes(plain_password), hashed_password.encode("utf-8"))
    except (ValueError, TypeError):
        return False


def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(_to_72_bytes(password), bcrypt.gensalt()).decode("utf-8")


def create_access_token(data: dict, expires_delta: timedelta | None = None) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + (expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES))
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_access_token(token: str) -> dict | None:
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
        return payload
    except InvalidTokenError:
        return None


async def get_token_from_request(request: Request) -> str:
    """Extract JWT token from cookie first, then from Authorization header."""
    # Try cookie first (for real frontend)
    cookie_token = await cookie_scheme(request)
    if cookie_token:
        return cookie_token

    # Fallback to Bearer header (for Swagger UI testing)
    bearer_credentials = await bearer_scheme(request)
    if bearer_credentials:
        return bearer_credentials.credentials

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
    )

REFRESH_TOKEN_EXPIRE_DAYS = 90  # 90 days — PWA should keep users logged in

def create_refresh_token(data: dict) -> str:
    to_encode = data.copy()
    expire = datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode.update({"exp": expire, "type": "refresh"})
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)