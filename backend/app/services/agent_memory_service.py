"""Agent long-term memory, behind FEATURE_AGENT_WALRUS_MEMORY.

The JSONB column (``users.ai_settings['memory']``) stays the durable store in
both modes. Walrus Memory is used as the semantic index when the flag is on:
saves are mirrored to it, and loads recall the entries relevant to the current
task instead of injecting the whole memory into every prompt.

The flag is off by default, so an unset environment keeps the previous
behaviour exactly: every key is read from and written to the JSONB column.

Two rules hold on every path:

* A Walrus failure never reaches the caller. It is logged and the JSON path is
  used, which is why a relayer outage cannot turn a memory save into a 500.
* A recall reports where its memories actually came from, so the agent activity
  log never claims a Walrus recall that did not happen.
* A recall collapses exact duplicate texts, keeping the first, because the
  relayer is append-only and a write that reported an error may still have been
  stored. Near-duplicates are left alone: they are different facts.
* A recalled entry keeps the timestamp the relayer returned, and the prompt
  shows that date next to the fact. Recency is then visible to the model, which
  can prefer the newer of two contradicting facts; an entry without a usable
  timestamp is injected without a date, never with a placeholder.

This module imports the persistence layer directly and never a database driver.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import TYPE_CHECKING, Any, Dict, Iterable, Optional
from uuid import UUID

from ..core.agent_features import agent_feature_enabled
from ..core.memory_namespace import FLAG_NAME, memory_namespace
from ..crud.agent_memory import (
    delete_memory_key,
    load_memory,
    merge_memory,
)

if TYPE_CHECKING:  # pragma: no cover - typing only, never imported at runtime
    from sqlalchemy.ext.asyncio import AsyncSession

    from ..core.gateways.walrus_memory_gateway import WalrusMemoryGateway

logger = logging.getLogger(__name__)

MEMORY_RECALL_LIMIT = 5
MEMORY_TEXT_LIMIT = 2000
MEMORY_MIRROR_MAX_KEYS = 10


@dataclass(frozen=True)
class MemoryContext:
    """The memories injected into one task, and where they came from.

    ``source`` is ``"walrus"`` only when the relayer answered the recall and its
    entries were used. ``semantic`` is true when a semantic recall was actually
    attempted, which is what the activity log line keys off.

    ``dates`` maps a recalled memory key to the newest YYYY-MM-DD date the
    relayer reported for it. It is empty whenever the memories came from the
    JSONB store, which carries no per-entry timestamps.
    """

    entries: Dict[str, Any] = field(default_factory=dict)
    source: str = "json"
    semantic: bool = False
    dates: Dict[str, str] = field(default_factory=dict)

    @property
    def count(self) -> int:
        return len(self.entries)

    @property
    def source_label(self) -> str:
        return "Walrus" if self.source == "walrus" else "local storage"

    @property
    def prompt_entries(self) -> Dict[str, Any]:
        """The entries as they enter the prompt, every recalled fact dated.

        The date is appended to the value, so the line the model reads is
        ``last_search: plumber (2026-01-05)``. An entry the relayer returned no
        usable date for is passed through untouched, which keeps the prompt
        identical to the one the JSONB store produces.
        """
        if not self.dates:
            return self.entries
        rendered = dict(self.entries)
        for key, day in self.dates.items():
            if key in rendered:
                rendered[key] = f"{rendered[key]} ({day})"
        return rendered

    @property
    def recall_log_line(self) -> str:
        """The line shown in the task's execution steps. Never claims a recall
        that did not happen: the source is the one that actually answered.

        The "Searching" prefix is not decoration. The frontend activity panel
        puts an info log in the collapsible execution steps only when its
        message starts with one of a fixed set of prefixes, "Searching" among
        them; without it this line is rendered as an outcome card instead.
        """
        noun = "memory" if self.count == 1 else "memories"
        return f"Searching memory: Recalled {self.count} {noun} from {self.source_label}"


def _memory_text(key: str, value: Any) -> str:
    """The text stored in Walrus for one memory entry.

    The key prefixes the JSON-encoded value so a recall can tell which entry it
    matched. The value is never parsed back out of this text; the JSONB store
    remains the source of the value, so types and freshness are exact.
    """
    rendered = json.dumps(value, sort_keys=True, default=str)
    return f"{key}: {rendered}"[:MEMORY_TEXT_LIMIT]


def _memory_date(created_at: Any) -> Optional[str]:
    """The YYYY-MM-DD date of a recalled memory, or None when it has none.

    The relayer sends ISO-8601 text. A value that is missing, is not text, or
    does not parse yields None, and the caller then attaches no date at all: a
    placeholder or a guessed date would tell the model something the store never
    said.
    """
    if isinstance(created_at, datetime):
        return created_at.date().isoformat()
    if isinstance(created_at, date):
        return created_at.isoformat()
    if not isinstance(created_at, str):
        return None
    text = created_at.strip()
    if not text:
        return None
    candidate = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
    try:
        return datetime.fromisoformat(candidate).date().isoformat()
    except ValueError:
        return None


def _deduplicate_recalled(
    memories: Iterable["RecalledMemory"],
) -> tuple["RecalledMemory", ...]:
    """Collapse entries whose stored text is exactly equal, keeping the first.

    The relayer is append-only: a write that reported an error may still have
    been stored, so one fact can come back several times, and a namespace has
    been seen holding fifty recalled entries for forty-four distinct texts.
    Only exact text equality is collapsed. Two different sentences stay, even
    when they are near-duplicates, because they are different facts to the
    model and choosing between them is not this function's decision.

    The first occurrence is kept, which is the relayer's best match for the
    query, and with it the timestamp that entry carried.
    """
    seen: set[str] = set()
    unique: list["RecalledMemory"] = []
    for memory in memories:
        if memory.text in seen:
            continue
        seen.add(memory.text)
        unique.append(memory)
    return tuple(unique)


def _match_recalled(
    memories: Iterable["RecalledMemory"], known_keys: Iterable[str]
) -> list[tuple[str, Optional[str]]]:
    """Map recalled memories back to known memory keys, longest key first.

    Matching against the keys that exist locally means a malformed or foreign
    text is ignored rather than injected, and a key containing spaces or a colon
    still matches unambiguously.

    Returns ``(key, day)`` pairs in the order the memories ranked them. ``day``
    is the newest date among the memories that matched that key: the same fact
    may have been written several times, and the newest version is the one the
    model should see. It is None when no matching memory carried a usable date.
    """
    ordered_keys = sorted(known_keys, key=len, reverse=True)
    matched: dict[str, Optional[str]] = {}
    for memory in memories:
        for key in ordered_keys:
            if memory.text == key or memory.text.startswith(f"{key}: "):
                day = _memory_date(memory.created_at)
                known = matched.get(key)
                if key not in matched:
                    matched[key] = day
                elif day is not None and (known is None or day > known):
                    matched[key] = day
                break
    return list(matched.items())


class AgentMemoryService:
    """Load, save and forget the agent's memory for one user.

    ``db`` is the request's session; ``gateway`` is injected from the composition
    root and may be None when Walrus Memory is not configured.
    """

    def __init__(
        self,
        db: "AsyncSession",
        gateway: Optional["WalrusMemoryGateway"] = None,
    ) -> None:
        self._db = db
        self._gateway = gateway

    def _semantic_enabled(self) -> bool:
        """True when the flag is on and a usable gateway was injected."""
        if not agent_feature_enabled(FLAG_NAME):
            return False
        if self._gateway is None or not self._gateway.configured:
            logger.warning(
                "[agent-memory] %s is enabled but the Walrus Memory gateway is not "
                "configured (MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID must both be "
                "set, operation=load); using the JSONB memory",
                FLAG_NAME,
            )
            return False
        return True

    async def _recall_memories(
        self, user_id: UUID, query: str
    ) -> Optional[tuple["RecalledMemory", ...]]:
        """Recall memories, or None when the relayer could not answer.

        Every failure is caught here: Walrus Memory must never break a task, so
        the caller falls back to the local store instead of seeing an exception.
        Exact duplicate texts are collapsed here, before anything is matched
        against the local keys or reaches the prompt.
        """
        if self._gateway is None:
            return None
        try:
            return _deduplicate_recalled(
                await self._gateway.recall(
                    query, memory_namespace(user_id), MEMORY_RECALL_LIMIT
                )
            )
        except Exception as exc:  # noqa: BLE001 - an outbound dependency may fail any way
            logger.warning(
                "[agent-memory] recall failed for user_id=%s (operation=load): %s: %s; "
                "falling back to the JSONB memory",
                user_id,
                type(exc).__name__,
                exc,
            )
            return None

    async def load(self, user_id: UUID, query: Optional[str] = None) -> MemoryContext:
        """Return the memories to inject into a task.

        With the flag off this is the whole memory dict, exactly as before.
        With it on, ``query`` selects the most relevant entries and only those
        are injected; a recall failure falls back to the whole dict.
        """
        if self._semantic_enabled() and query and query.strip():
            memories = await self._recall_memories(user_id, query)
            if memories is not None:
                local = await load_memory(self._db, user_id)
                matched = _match_recalled(memories, local.keys())
                keys = [key for key, _ in matched]
                return MemoryContext(
                    entries={key: local[key] for key in keys},
                    source="walrus",
                    semantic=True,
                    dates={key: day for key, day in matched if day is not None},
                )
            # The recall was attempted and failed. Report the local store as the
            # source, because that is the store that actually answered.
            return MemoryContext(
                entries=await load_memory(self._db, user_id),
                source="json",
                semantic=True,
            )

        return MemoryContext(
            entries=await load_memory(self._db, user_id),
            source="json",
            semantic=False,
        )

    async def save(self, user_id: UUID, updates: Dict[str, Any]) -> Dict[str, Any]:
        """Merge ``updates`` into the memory and return the merged memory.

        Raises RecordNotFoundError when the user does not exist: a save that did
        not happen is never reported as a success. Commits before mirroring so
        the row lock is not held across a network call.
        """
        memory = await merge_memory(self._db, user_id, updates)
        await self._db.commit()
        if self._semantic_enabled():
            await self._mirror(user_id, updates)
        return memory

    async def forget(self, user_id: UUID, key: str) -> Dict[str, Any]:
        """Remove one key from the memory and return the remaining memory.

        The JSONB entry is deleted; Walrus Memory has no delete call, so the
        text can remain in the append-only relayer. It is never injected again
        because a recall is filtered against the keys that still exist locally.
        Raises RecordNotFoundError when the user does not exist.
        """
        memory = await delete_memory_key(self._db, user_id, key)
        await self._db.commit()
        return memory

    async def _mirror(self, user_id: UUID, updates: Dict[str, Any]) -> None:
        """Copy each saved entry into Walrus Memory, best effort.

        A failure here is logged and dropped: the entry is already durable in
        the JSONB column and the caller must not see an error because a search
        index is unavailable.

        The number of writes per save is capped. A free-form memory patch can
        carry any number of keys, and one relayer call per key would spend the
        account's minute budget on a single request; the JSONB write still keeps
        every key, so a cap loses nothing durable.
        """
        if self._gateway is None:
            return
        namespace = memory_namespace(user_id)
        mirrored = list(updates.items())[:MEMORY_MIRROR_MAX_KEYS]
        if len(updates) > len(mirrored):
            logger.warning(
                "[agent-memory] save for user_id=%s carried %d keys; mirrored the "
                "first %d to Walrus Memory (operation=save). All keys are in the "
                "JSONB memory",
                user_id,
                len(updates),
                len(mirrored),
            )
        for key, value in mirrored:
            idempotency_key = hashlib.sha256(
                f"{user_id}\0{key}\0{json.dumps(value, sort_keys=True, default=str)}".encode()
            ).hexdigest()
            try:
                await self._gateway.remember(
                    _memory_text(key, value), namespace, idempotency_key=idempotency_key
                )
            except Exception as exc:  # noqa: BLE001 - an outbound dependency may fail any way
                logger.warning(
                    "[agent-memory] remember failed for user_id=%s memory_key=%s "
                    "(operation=save): %s: %s; the entry stays in the JSONB memory",
                    user_id,
                    key,
                    type(exc).__name__,
                    exc,
                )
