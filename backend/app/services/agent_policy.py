"""Autonomy policy — the single source of truth for what the agent may do alone.

The settings UI offers five autonomy levels, but the backend used to interpret
them in three scattered places with different definitions (and no shared
guardrails at all). "High" meant one thing in `jobs.py`, another in `ai.py`, and
nothing anywhere else. This module resolves a level into explicit capabilities
plus rate limits, and every autonomous code path consults it, so the level the
user picks is the level that actually runs.

Levels
------
off     nothing happens without an explicit command
low     auto-reply to incoming messages
medium  + negotiate prices on the user's behalf
high    + apply to matching jobs automatically
total   + proactively hunt for work the user needs

Guardrails are deliberately conservative: autonomous actions are counted per
rolling 24 hours via the ``__autonomy`` marker stored on each self-created
AgentTask, so a misconfigured level can never turn into an unbounded message or
application spam loop.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

LEVELS = ("off", "low", "medium", "high", "total")

#: Key stored in ``AgentTask.params`` for tasks the agent queued by itself. Used
#: both for guardrail counting and to surface autonomous work in the UI.
AUTONOMY_MARKER = "__autonomy"

#: Rolling window for the guardrail counters.
GUARDRAIL_WINDOW_HOURS = 24


@dataclass(frozen=True)
class AutonomyPolicy:
    """Resolved capabilities for one user at one level."""

    level: str
    can_auto_reply: bool
    can_negotiate: bool
    can_auto_apply: bool
    can_proactive_hunt: bool
    daily_action_cap: int
    daily_apply_cap: int

    @property
    def is_autonomous(self) -> bool:
        return self.level != "off"


# rank -> (daily autonomous actions, daily auto-applications)
_LIMITS = {
    0: (0, 0),    # off
    1: (20, 0),   # low
    2: (30, 0),   # medium
    3: (40, 10),  # high
    4: (60, 20),  # total
}


def policy_for_level(level: Any) -> AutonomyPolicy:
    """Resolve a raw level string into capabilities. Unknown → ``off`` (fail safe)."""
    normalized = str(level or "off").strip().lower()
    if normalized not in LEVELS:
        logger.warning("[agent] unknown autonomy level %r — treating as 'off'", level)
        normalized = "off"
    rank = LEVELS.index(normalized)
    actions, applies = _LIMITS[rank]
    return AutonomyPolicy(
        level=normalized,
        can_auto_reply=rank >= 1,
        can_negotiate=rank >= 2,
        can_auto_apply=rank >= 3,
        can_proactive_hunt=rank >= 4,
        daily_action_cap=actions,
        daily_apply_cap=applies,
    )


def resolve_policy(ai_settings: Optional[Dict[str, Any]]) -> AutonomyPolicy:
    """Resolve the policy from a user's ``ai_settings`` JSON blob."""
    return policy_for_level((ai_settings or {}).get("autonomyLevel", "off"))


async def count_recent_autonomous_actions(
    db: AsyncSession,
    user_id: UUID,
    *,
    hours: int = GUARDRAIL_WINDOW_HOURS,
    feature: Optional[str] = None,
) -> int:
    """How many autonomous actions this user has taken in the rolling window."""
    from ..models.agent_task import AgentTask

    cutoff = datetime.now(timezone.utc) - timedelta(hours=hours)
    conditions = [
        AgentTask.user_id == user_id,
        AgentTask.created_at >= cutoff,
        AgentTask.params[AUTONOMY_MARKER].astext.isnot(None),
    ]
    if feature:
        conditions.append(AgentTask.params[AUTONOMY_MARKER].astext == feature)

    result = await db.execute(select(func.count(AgentTask.id)).where(*conditions))
    return int(result.scalar() or 0)


async def within_guardrails(
    db: AsyncSession,
    user_id: UUID,
    *,
    feature: str,
    cap: int,
) -> bool:
    """True when the user still has autonomous budget for ``feature``.

    ``cap <= 0`` always denies: a level that doesn't grant a capability never
    gets to spend budget on it.
    """
    if cap <= 0:
        return False
    used = await count_recent_autonomous_actions(db, user_id, feature=feature)
    if used >= cap:
        logger.info(
            "[agent] guardrail hit: user=%s feature=%s used=%d cap=%d",
            user_id, feature, used, cap,
        )
        return False
    return True
