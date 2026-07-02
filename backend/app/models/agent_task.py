"""
AgentTask model — represents a background task dispatched by the AI agent.

Each task corresponds to one user command (voice or text). The agent loop
picks up queued tasks and executes them in the background.
"""

import uuid
from sqlalchemy import Column, String, Text, DateTime, func, ForeignKey
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from ..core.database import Base


class AgentTask(Base):
    __tablename__ = "agent_tasks"
    __table_args__ = {"extend_existing": True}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Every task belongs to a logged-in user (login is required to use the agent)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    # Raw natural language command the user issued
    command_text = Column(Text, nullable=False)

    # Parsed task type
    # Possible values: search | negotiate | post_job | navigate | generic
    task_type = Column(String(50), nullable=False, default="generic")

    # Structured params extracted from command_text (e.g. {"query": "phone repair", "max_price": 5000})
    params = Column(JSONB, nullable=True, default=dict)

    # Task lifecycle status
    # queued → running → completed | failed | cancelled
    status = Column(String(20), nullable=False, default="queued", index=True)

    # Final result payload (e.g. list of found services, job id created, etc.)
    result = Column(JSONB, nullable=True)

    # Timestamps
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    completed_at = Column(DateTime(timezone=True), nullable=True)

    # Relationships
    user = relationship("User", foreign_keys=[user_id])
    logs = relationship("AgentLog", back_populates="task", cascade="all, delete-orphan", order_by="AgentLog.created_at")
