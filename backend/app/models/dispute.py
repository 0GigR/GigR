import uuid
from sqlalchemy import Column, String, Text, DateTime, func, ForeignKey, Enum as SqlEnum
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
import enum
from ..core.database import Base


class DisputeStatus(str, enum.Enum):
    OPEN = "open"
    RESOLVED = "resolved"


class Dispute(Base):
    __tablename__ = "disputes"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id = Column(UUID(as_uuid=True), ForeignKey("jobs.id"), nullable=False)
    client_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    provider_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    reason = Column(Text, nullable=False)
    status = Column(SqlEnum(DisputeStatus), default=DisputeStatus.OPEN)
    resolution = Column(String(50), nullable=True)  # "refund", "release", "split"
    ai_summary = Column(Text, nullable=True)  # AI-generated neutral jury brief
    resolved_at = Column(DateTime(timezone=True), nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    job = relationship("Job", back_populates="disputes")
    client = relationship("User", back_populates="disputes_as_client", foreign_keys=[client_id])
    provider = relationship("User", back_populates="disputes_as_provider", foreign_keys=[provider_id])

    votes = relationship("Vote", back_populates="dispute")
    jury_panels = relationship("JuryPanel", back_populates="dispute")
    raised_by = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)  # who opened the dispute