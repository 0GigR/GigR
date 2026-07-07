from pydantic import BaseModel, Field
from typing import Optional
from uuid import UUID
from datetime import datetime


class RatingCreate(BaseModel):
    job_id: UUID
    score: int = Field(..., ge=1, le=5)
    comment: Optional[str] = Field(None, max_length=500)


class RatingOut(BaseModel):
    id: UUID
    job_id: UUID
    rater_id: UUID
    ratee_id: UUID
    score: int
    comment: Optional[str] = None
    created_at: datetime
    rater_name: Optional[str] = None

    class Config:
        from_attributes = True
