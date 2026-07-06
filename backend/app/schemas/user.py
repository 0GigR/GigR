from pydantic import BaseModel, EmailStr, Field
from typing import Optional, Dict, Any
from uuid import UUID
from datetime import datetime

class UserCreate(BaseModel):
    email: EmailStr
    password: Optional[str] = None  # required for email signup, None for Google OAuth
    display_name: str = Field(..., min_length=1, max_length=100)
    phone_number: Optional[str] = None

class UserLogin(BaseModel):
    email: EmailStr
    password: str

class UserGoogleAuth(BaseModel):
    token: str  # Google ID token

class UserOut(BaseModel):
    id: UUID
    email: EmailStr
    display_name: str
    phone_number: Optional[str] = None
    profile_image_url: Optional[str] = None
    google_id: Optional[str] = None          # <-- add this
    is_verified: bool
    role: Optional[str] = None
    created_at: datetime
    ai_settings: Optional[Dict[str, Any]] = None

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

    class Config:
        from_attributes = True


class UserUpdate(BaseModel):
    display_name: Optional[str] = Field(None, min_length=1, max_length=100)
    phone_number: Optional[str] = None
    profile_image_url: Optional[str] = None
    ai_settings: Optional[Dict[str, Any]] = None

class UserLocationUpdate(BaseModel):
    latitude: float
    longitude: float