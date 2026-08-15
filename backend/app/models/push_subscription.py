from datetime import datetime, timezone
import uuid
from typing import Optional

from sqlalchemy import Column, String, DateTime, ForeignKey, JSON
from sqlalchemy.dialects.postgresql import UUID

from app.core.database import Base

class PushSubscription(Base):
    __tablename__ = "push_subscriptions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    endpoint = Column(String, nullable=False, unique=True, index=True)
    keys = Column(JSON, nullable=False) # e.g. {"p256dh": "...", "auth": "..."}
    # Browser/OS of the subscribing device — used to pick the right
    # notification-click behaviour (openWindow on mobile, focus on desktop).
    user_agent = Column(String(500), nullable=True)
    
    created_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))
