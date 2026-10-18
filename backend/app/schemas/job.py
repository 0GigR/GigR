from pydantic import BaseModel, Field, model_validator
from typing import Optional, List, Any
from uuid import UUID
from datetime import datetime
from decimal import Decimal
from .milestone import MilestoneOut

class JobCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=255)
    description: str
    price: Optional[Decimal] = None
    min_price: Optional[Decimal] = None      # new
    max_price: Optional[Decimal] = None 
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    image_url: Optional[str] = None
    category_id: Optional[UUID] = None

class JobOut(BaseModel):
    id: UUID
    client_id: UUID
    provider_id: Optional[UUID] = None
    service_listing_id: Optional[UUID] = None
    category_id: Optional[UUID] = None
    title: str
    description: str
    status: str
    price: Optional[Decimal] = None
    min_price: Optional[Decimal] = None      # new
    max_price: Optional[Decimal] = None      # new
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    escrow_address: Optional[str] = None
    milestones: List[MilestoneOut] = []
    created_at: datetime
    updated_at: Optional[datetime] = None
    image_url: Optional[str] = None
    work_submitted_at: Optional[datetime] = None
    auto_release_at: Optional[datetime] = None
    # Escrow: which rail holds the money and where it is (PayPal rail).
    payment_rail: Optional[str] = None
    payment_state: Optional[str] = None      # unfunded | awaiting_approval | escrowed | released | refunded
    paypal_amount: Optional[Decimal] = None  # USD charged / held
    paypal_payout_status: Optional[str] = None
    # Engagement signal (set by list/detail endpoints): how many providers
    # applied. Drives the marketplace ranking and the card's applicant badge.
    applications_count: Optional[int] = None
    # Set only by geo-aware list endpoints (lat/lon supplied): spherical
    # distance from the caller in kilometres. None everywhere else.
    distance_km: Optional[float] = None

    class Config:
        from_attributes = True

    @model_validator(mode="before")
    @classmethod
    def _ensure_milestones_present(cls, data: Any) -> Any:
        # Prevent MissingGreenlet error if ORM instance has unloaded/expired milestones relationship
        if hasattr(data, "_sa_instance_state"):
            from sqlalchemy.orm import attributes
            try:
                state = attributes.instance_state(data)
                if "milestones" not in state.dict:
                    state.dict["milestones"] = []
                    state.expired_attributes.discard("milestones")
            except Exception:
                pass
        return data


class PayPalCapture(BaseModel):
    """Body of POST /jobs/{id}/paypal/capture — the order PayPal sent the payer back with."""
    order_id: str = Field(..., min_length=5, max_length=64)


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