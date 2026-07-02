"""Pydantic schemas for AI agent tasks and logs."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional
from pydantic import BaseModel


# ── Log schemas ──────────────────────────────────────────────────────────────

class AgentLogOut(BaseModel):
    id: uuid.UUID
    task_id: uuid.UUID
    level: str           # info | action | success | error | warning
    message: str
    data: Optional[Dict[str, Any]] = None
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Task schemas ──────────────────────────────────────────────────────────────

class AgentCommandRequest(BaseModel):
    """What the client sends when submitting a voice/text command."""
    text: str


class AgentTaskOut(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    command_text: str
    task_type: str
    params: Optional[Dict[str, Any]] = None
    status: str
    result: Optional[Dict[str, Any]] = None
    created_at: datetime
    updated_at: Optional[datetime] = None
    completed_at: Optional[datetime] = None
    logs: List[AgentLogOut] = []

    model_config = {"from_attributes": True}


class AgentTaskListOut(BaseModel):
    tasks: List[AgentTaskOut]
    total: int
