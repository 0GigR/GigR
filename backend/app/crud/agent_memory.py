"""Persistence for the agent memory held in ``users.ai_settings['memory']``.

The memory is a sub-document of one entity, so every function here locks and
rewrites that one row. The read-modify-write runs under ``SELECT ... FOR UPDATE``
so two concurrent agent actions cannot each merge onto the same snapshot and
silently discard one another's key.
"""

from __future__ import annotations

from typing import Any, Dict
from uuid import UUID

from sqlalchemy import select, update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.errors import RecordNotFoundError
from ..models.user import User

_MEMORY_KEY = "memory"


def _memory_from(settings_now: Dict[str, Any] | None) -> Dict[str, Any]:
    """The memory sub-dict of an ai_settings value, copied so callers cannot alias it."""
    memory = (settings_now or {}).get(_MEMORY_KEY)
    return dict(memory) if isinstance(memory, dict) else {}


async def _locked_settings(db: AsyncSession, user_id: UUID, operation: str) -> Dict[str, Any]:
    """Read ``ai_settings`` under a row lock, or raise if the user does not exist.

    The lock is held until the caller commits, which is what makes the caller's
    read-modify-write atomic against another request doing the same.
    """
    result = await db.execute(
        select(User.ai_settings).where(User.id == user_id).with_for_update()
    )
    row = result.first()
    if row is None:
        raise RecordNotFoundError(operation, "user", user_id)
    return dict(row[0] or {})


async def _write_settings(db: AsyncSession, user_id: UUID, settings_now: Dict[str, Any]) -> None:
    await db.execute(
        sql_update(User).where(User.id == user_id).values(ai_settings=settings_now)
    )
    await db.flush()


async def load_memory(db: AsyncSession, user_id: UUID) -> Dict[str, Any]:
    """Return the user's agent memory, or an empty dict when there is none.

    A missing user is not an error on the read path: the agent loop must not
    crash because the account was deleted mid-task. Writes are stricter; see
    :func:`merge_memory`.
    """
    result = await db.execute(
        select(User.ai_settings).where(User.id == user_id)
    )
    row = result.first()
    if row is None:
        return {}
    return _memory_from(row[0])


async def merge_memory(
    db: AsyncSession, user_id: UUID, updates: Dict[str, Any]
) -> Dict[str, Any]:
    """Merge ``updates`` into the user's memory and return the merged result.

    Raises :class:`RecordNotFoundError` when the user does not exist, so a write
    that did not happen can never be reported as a success. Flushes but does not
    commit; the caller owns the transaction and therefore the lock.
    """
    settings_now = await _locked_settings(db, user_id, "merge_agent_memory")
    memory = _memory_from(settings_now)
    memory.update(updates)
    settings_now[_MEMORY_KEY] = memory
    await _write_settings(db, user_id, settings_now)
    return memory


async def delete_memory_key(
    db: AsyncSession, user_id: UUID, key: str
) -> Dict[str, Any]:
    """Remove one key from the user's memory and return the remaining memory.

    Raises :class:`RecordNotFoundError` when the user does not exist. Flushes
    but does not commit; the caller owns the transaction and therefore the lock.
    """
    settings_now = await _locked_settings(db, user_id, "forget_agent_memory")
    memory = _memory_from(settings_now)
    memory.pop(key, None)
    settings_now[_MEMORY_KEY] = memory
    await _write_settings(db, user_id, settings_now)
    return memory
