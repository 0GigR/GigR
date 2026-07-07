from pydantic import BaseModel, Field
from typing import Optional, List
from uuid import UUID
from datetime import datetime
from decimal import Decimal


class MilestoneCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: Optional[str] = None
    price: Decimal
    order: int = 0


class MilestoneUpdate(BaseModel):
    title: Optional[str] = Field(None, max_length=200)
    description: Optional[str] = None
    price: Optional[Decimal] = None


class MilestoneOut(BaseModel):
    id: UUID
    job_id: UUID
    title: str
    description: Optional[str] = None
    price: Decimal
    status: str
    order: int
    created_at: datetime
    released_at: Optional[datetime] = None

    class Config:
        from_attributes = True
