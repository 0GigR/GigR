from pydantic import BaseModel, Field
from typing import Optional
from uuid import UUID
from datetime import datetime
from decimal import Decimal

class ServiceCreate(BaseModel):
    category_id: UUID
    title: str = Field(..., min_length=1, max_length=255)
    description: Optional[str] = None
    price: Decimal
    min_price: Optional[Decimal] = None      # new
    max_price: Optional[Decimal] = None      # new
    latitude: float
    longitude: float
    radius_km: Optional[Decimal] = Decimal("5.0")
    image_url: Optional[str] = None

class ServiceUpdate(BaseModel):
    category_id: Optional[UUID] = None
    title: Optional[str] = Field(None, min_length=1, max_length=255)
    description: Optional[str] = None
    price: Optional[Decimal] = None
    is_active: Optional[bool] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    radius_km: Optional[Decimal] = None
    image_url: Optional[str] = None

class ServiceOut(BaseModel):
    id: UUID
    provider_id: UUID
    category_id: UUID
    title: str
    description: Optional[str] = None
    price: Decimal
    min_price: Optional[Decimal] = None      # new
    max_price: Optional[Decimal] = None      # new
    is_active: bool
    created_at: datetime
    updated_at: Optional[datetime] = None
    latitude: float
    longitude: float
    radius_km: Decimal
    image_url: Optional[str] = None
    # Set only by the geo-aware nearby endpoint: spherical distance from the
    # caller in kilometres. None for text/nearby-less responses.
    distance_km: Optional[float] = None

    class Config:
        from_attributes = True