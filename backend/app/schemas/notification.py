from pydantic import BaseModel, ConfigDict
from uuid import UUID
from datetime import datetime
from typing import Optional

class NotificationBase(BaseModel):
    title: str
    message: str
    link: Optional[str] = None

class NotificationCreate(NotificationBase):
    user_id: UUID

class NotificationOut(NotificationBase):
    id: UUID
    is_read: bool
    created_at: datetime
    
    model_config = ConfigDict(from_attributes=True)
