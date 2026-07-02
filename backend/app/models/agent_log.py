"""
AgentLog model — one log entry per step the agent takes while executing a task.

Logs are displayed in the Agent Activity Panel so users can see exactly what
the AI did on their behalf, step by step.
"""

import uuid
from sqlalchemy import Column, String, Text, DateTime, func, ForeignKey
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from ..core.database import Base


class AgentLog(Base):
    __tablename__ = "agent_logs"
    __table_args__ = {"extend_existing": True}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # FK to the task this log entry belongs to
    task_id = Column(UUID(as_uuid=True), ForeignKey("agent_tasks.id", ondelete="CASCADE"), nullable=False, index=True)

    # Log level controls the icon shown in the UI
    # Possible values: info | action | success | error | warning
    level = Column(String(20), nullable=False, default="info")

    # Human-readable message shown in the activity panel
    message = Column(Text, nullable=False)

    # Optional structured data for debugging (not shown to users by default)
    data = Column(JSONB, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)

    # Relationship back to task
    task = relationship("AgentTask", back_populates="logs")
