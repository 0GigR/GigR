from pydantic import BaseModel, Field
from uuid import UUID
from datetime import datetime

from typing import Optional

class MessageCreate(BaseModel):
    job_id: UUID
    content: str = Field(..., min_length=1)
    image_url: Optional[str] = None
    # NULL => contract room; set => pre-assignment discussion with this applicant
    applicant_id: Optional[UUID] = None

class MessageOut(BaseModel):
    id: UUID
    job_id: UUID
    sender_id: UUID
    content: str
    image_url: Optional[str] = None
    applicant_id: Optional[UUID] = None
    sender_name: Optional[str] = None
    sender_image_url: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True