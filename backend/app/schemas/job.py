from pydantic import BaseModel, Field
from typing import Optional
from uuid import UUID
from datetime import datetime
from decimal import Decimal

class JobCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    description: str
    price: Decimal
    min_price: Optional[Decimal] = None      # new
    max_price: Optional[Decimal] = None 
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    image_url: Optional[str] = None

class JobOut(BaseModel):
    id: UUID
    client_id: UUID
    provider_id: Optional[UUID] = None
    service_listing_id: Optional[UUID] = None
    title: str
    description: str
    status: str
    price: Decimal
    min_price: Optional[Decimal] = None      # new
    max_price: Optional[Decimal] = None      # new
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    escrow_address: Optional[str] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    image_url: Optional[str] = None
    work_submitted_at: Optional[datetime] = None
    auto_release_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class JobStatusUpdate(BaseModel):
    status: str  # validated in endpoint

class JobAssign(BaseModel):
    provider_id: UUID

class JobFund(BaseModel):
    pass  # no body needed, derived from job and user

class JobRelease(BaseModel):
    pass  # no body needed

class JobCancel(BaseModel):
    pass