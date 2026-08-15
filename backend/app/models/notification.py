import uuid
from sqlalchemy import Column, String, Text, DateTime, Boolean, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from ..core.database import Base

class Notification(Base):
    __tablename__ = "notifications"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    title = Column(String(255), nullable=False)
    message = Column(Text, nullable=False)
    link = Column(String(500), nullable=True)
    # Category of notification: message | job | request | application | accepted |
    # payment | work | cancelled | agent | system. Drives the bell's icon/color and
    # the web-push presentation (grouping, priority, action buttons).
    type = Column(String(32), nullable=False, default="system", index=True)
    # Coalescing key — message notifications share one tag per conversation
    # ("chat:{job_id}") so a message spam doesn't stack rows; announcements use
    # "announcement:{id}" so each popup maps to exactly one notification.
    tag = Column(String(100), nullable=True, index=True)
    is_read = Column(Boolean, default=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    user = relationship("User")
