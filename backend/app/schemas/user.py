from pydantic import BaseModel, EmailStr, Field, field_validator
from typing import Optional, Dict, Any, List
from uuid import UUID
from datetime import datetime
from ..core.phone import normalize_phone_number

class UserCreate(BaseModel):
    email: EmailStr
    password: Optional[str] = None  # required for email signup, None for Google OAuth
    display_name: str = Field(..., min_length=1, max_length=100)
    phone_number: Optional[str] = None

    @field_validator("email", mode="before")
    @classmethod
    def _normalize_email(cls, v: Any) -> Any:
        if isinstance(v, str):
            return v.strip().lower()
        return v

    @field_validator("phone_number", mode="before")
    @classmethod
    def _normalize_phone(cls, v: Any) -> Any:
        if not v:
            return None
        return normalize_phone_number(str(v))

    @field_validator("display_name", mode="before")
    @classmethod
    def _clean_name(cls, v: Any) -> Any:
        if isinstance(v, str):
            return v.strip()
        return v

    @field_validator("password", mode="before")
    @classmethod
    def _validate_password(cls, v: Any) -> Any:
        if v is not None and isinstance(v, str) and len(v) < 6:
            raise ValueError("Password must be at least 6 characters")
        return v

class UserLogin(BaseModel):
    email: str  # Accepts either email or normalized phone number
    password: str

    @field_validator("email", mode="before")
    @classmethod
    def _clean_identifier(cls, v: Any) -> Any:
        if isinstance(v, str):
            cleaned = v.strip()
            if "@" in cleaned:
                return cleaned.lower()
            return cleaned
        return v

class UserGoogleAuth(BaseModel):
    # One of these. `token` = Google ID token (GoogleLogin button).
    # `access_token` = OAuth access token (useGoogleLogin hook / custom button).
    token: Optional[str] = None
    access_token: Optional[str] = None

class UserOut(BaseModel):
    id: UUID
    email: EmailStr
    display_name: str
    phone_number: Optional[str] = None
    profile_image_url: Optional[str] = None
    google_id: Optional[str] = None
    is_verified: bool
    role: Optional[str] = None
    created_at: datetime
    ai_settings: Optional[Dict[str, Any]] = None
    # UI preferences (onboarding dismissal, etc.) — server-side so they survive
    # cleared browser storage.
    ui_settings: Optional[Dict[str, Any]] = None
    ai_enabled: bool = True
    location_public: bool = False
    # Saved home/neighbourhood location — returned to the user themselves so the
    # WebMCP get_user_location tool can feed nearby provider searches.
    location_lat: Optional[float] = None
    location_lng: Optional[float] = None
    bio: Optional[str] = None
    skills: Optional[List[str]] = None
    permissions: Optional[List[str]] = None

    class Config:
        from_attributes = True

class PublicUserOut(BaseModel):
    """Safe subset of user fields returned by the unauthenticated public profile endpoint.
    Deliberately omits email, phone_number, google_id, and ai_settings."""
    id: UUID
    display_name: str
    profile_image_url: Optional[str] = None
    is_verified: bool
    role: Optional[str] = None
    created_at: datetime
    last_seen_at: Optional[datetime] = None
    # Location — only populated when the user has enabled location sharing
    location_lat: Optional[float] = None
    location_lng: Optional[float] = None
    bio: Optional[str] = None
    skills: Optional[List[str]] = None
    # Computed from ratings table — injected by the endpoint, not from the model
    avg_rating: Optional[float] = None
    rating_count: Optional[int] = None
    # Computed — number of verified vouches this user has received
    vouches_received_count: Optional[int] = None

    class Config:
        from_attributes = True


class UserUpdate(BaseModel):
    display_name: Optional[str] = Field(None, min_length=1, max_length=100)
    phone_number: Optional[str] = None
    profile_image_url: Optional[str] = None
    ai_settings: Optional[Dict[str, Any]] = None
    ui_settings: Optional[Dict[str, Any]] = None
    location_public: Optional[bool] = None
    bio: Optional[str] = Field(None, max_length=500)
    skills: Optional[List[str]] = None

    @field_validator("phone_number", mode="before")
    @classmethod
    def _normalize_phone(cls, v: Any) -> Any:
        if not v:
            return None
        return normalize_phone_number(str(v))

class UserLocationUpdate(BaseModel):
    latitude: float
    longitude: float
    sync_services_mode: Optional[str] = "all"  # "all", "none"