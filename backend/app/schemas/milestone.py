import uuid
from datetime import datetime
from decimal import Decimal
from typing import Optional
from pydantic import BaseModel, ConfigDict


class MilestoneBase(BaseModel):
    title: str
    amount: Decimal
    description: Optional[str] = None
    milestone_index: Optional[int] = None


class MilestoneCreate(MilestoneBase):
    pass


class MilestoneUpdate(BaseModel):
    title: Optional[str] = None
    amount: Optional[Decimal] = None
    description: Optional[str] = None


class MilestoneOut(BaseModel):
    id: uuid.UUID
    job_id: uuid.UUID
    milestone_index: int
    title: str
    description: Optional[str] = None
    amount: Decimal
    status: str
    contract_milestone_id: str
    escrow_address: Optional[str] = None
    # PayPal rail: USD held for this stage and how its payout is going.
    paypal_amount: Optional[Decimal] = None
    paypal_payout_status: Optional[str] = None
    created_at: datetime
    funded_at: Optional[datetime] = None
    released_at: Optional[datetime] = None

    model_config = ConfigDict(from_attributes=True)
