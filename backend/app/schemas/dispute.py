from pydantic import BaseModel
from typing import Optional
from uuid import UUID
from datetime import datetime

class DisputeCreate(BaseModel):
    job_id: UUID
    reason: str

class DisputeResolve(BaseModel):
    resolution: str  # "refund", "release", "split"

class DisputeOut(BaseModel):
    id: UUID
    job_id: UUID
    client_id: UUID
    provider_id: UUID
    reason: str
    status: str
    resolution: Optional[str] = None
    ai_summary: Optional[str] = None
    resolved_at: Optional[datetime] = None
    created_at: datetime

    class Config:
        from_attributes = True