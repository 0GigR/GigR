"""Backfill every user's facts into their Walrus Memory namespace.

Three properties matter more than speed here, and they are implemented
separately so one cannot be mistaken for another:

Idempotent. A fact's identity comes from :func:`build_fact_identity`, which is a
hash of the sentence. The state file records every key already written for a
user, so a second run over unchanged rows writes nothing. The relayer's
idempotency key is derived from the same identity, so even a write whose
acknowledgement was lost collapses onto the write the relayer already accepted.

Resumable. Progress is a JSON state file, not a database table. A table would
mean a schema change that exists even while the feature flag is off, and this
run must be able to write nothing at all when the flag is off; a file is created
by the run and by nothing else. The file is written atomically (write a sibling
then rename) after every accepted fact, so a killed process loses at most the
request in flight, and the resumed run skips the users already marked complete as
well as the individual facts already recorded.

Survives the pooler. One user's rows are loaded through a session of their own,
and that session is closed before any Walrus write, so no transaction is held
open across a network call and a pooled connection is never reused for a whole
run. A user whose rows or writes fail is logged, left incomplete and retried by
the next run; the run continues with the next user instead of abandoning
everyone behind them.

Paced. The relayer allows roughly 60 weighted requests per minute per account,
and this run is not the only thing that account may be doing, so it waits a
fixed interval before every write. The interval is derived from a configurable
requests-per-minute value and is capped well below the limit.

The service never deletes anything and writes to no table: a dry run writes
nothing at all, not even the state file.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable, Optional
from uuid import UUID

from .fact_memory_service import FactMemoryService
from .user_history_service import UserHistory, UserHistoryService

# Roughly three seconds between writes: a third of the relayer's minute budget,
# which leaves room for the agent loop and any manual call using the same
# account while the backfill is running.
DEFAULT_REQUESTS_PER_MINUTE = 20
# The relayer's documented ceiling is about 60. A run that asks to sit above this
# is refused rather than trusted to stay under a limit it is aimed at.
MAX_REQUESTS_PER_MINUTE = 55

STATE_VERSION = 1


@dataclass(frozen=True)
class BackfillReport:
    """What a run did, or would do in a dry run.

    ``facts_recorded`` counts facts the state file already held and
    ``facts_written`` counts facts this run stored; in a dry run
    ``facts_written`` is 0 and the difference is what it would have written.
    ``users_failed`` counts users this run could not finish: they are left
    incomplete, and the next run starts from their recorded facts.
    """

    dry_run: bool
    users: int
    users_complete: int
    users_missing: int
    users_failed: int
    facts_total: int
    facts_recorded: int
    facts_written: int


class Pacer:
    """Waits a fixed interval before each write, so the run cannot burst.

    ``sleep`` and ``clock`` are injected so a test can drive the pacing without
    spending real minutes on it, and so the interval is asserted rather than
    the wall clock.
    """

    def __init__(
        self,
        requests_per_minute: int = DEFAULT_REQUESTS_PER_MINUTE,
        *,
        sleep: Optional[Callable[[float], Any]] = None,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        if isinstance(requests_per_minute, bool) or not isinstance(
            requests_per_minute, int
        ):
            raise ValueError(
                "requests_per_minute must be a whole number (operation=build_pacer)"
            )
        if not 1 <= requests_per_minute <= MAX_REQUESTS_PER_MINUTE:
            raise ValueError(
                f"requests_per_minute must be between 1 and "
                f"{MAX_REQUESTS_PER_MINUTE}; the relayer allows about 60 per "
                f"minute and this run must stay well under it "
                f"(operation=build_pacer)"
            )
        self._interval_seconds = 60.0 / requests_per_minute
        self._sleep = sleep or asyncio.sleep
        self._clock = clock or time.monotonic
        self._last_request_at: Optional[float] = None

    @property
    def interval_seconds(self) -> float:
        """Seconds between two writes."""
        return self._interval_seconds

    async def wait(self) -> None:
        """Sleep until the next write is allowed, then mark it as taken."""
        if self._last_request_at is not None:
            elapsed = self._clock() - self._last_request_at
            remaining = self._interval_seconds - elapsed
            if remaining > 0:
                await self._sleep(remaining)
        self._last_request_at = self._clock()


class BackfillState:
    """Per-user progress and the fact keys already written, as one JSON file.

    The file is the resume point. ``users[<id>].completed`` skips a user a
    previous run finished; ``users[<id>].facts`` maps every written fact key to
    the sentence it identified, which makes the file auditable by a person and
    lets a resumed run skip individual facts inside a partly finished user.
    """

    def __init__(self, path: str, namespace_prefix: str, payload: dict[str, Any]):
        self.path = path
        self.namespace_prefix = namespace_prefix
        self._payload = payload

    @classmethod
    def load(cls, path: str, namespace_prefix: str) -> "BackfillState":
        """Read the state at path, or return an empty state when there is none.

        Raises ValueError when the file exists but cannot be trusted: a corrupt
        file is not silently replaced, because replacing it would re-write facts
        the relayer already holds, and a file written under another namespace
        prefix describes a different set of namespaces entirely.
        """
        if not os.path.exists(path):
            return cls(path, namespace_prefix, cls._empty(namespace_prefix))
        with open(path, encoding="utf-8") as handle:
            try:
                payload = json.load(handle)
            except json.JSONDecodeError as exc:
                raise ValueError(
                    f"{path} is not valid JSON ({exc}); move it aside to start a "
                    f"new run, or restore it from a backup to resume"
                ) from exc
        if not isinstance(payload, dict) or payload.get("version") != STATE_VERSION:
            raise ValueError(
                f"{path} is not a version {STATE_VERSION} backfill state file; "
                f"move it aside to start a new run"
            )
        recorded_prefix = payload.get("namespace_prefix")
        if recorded_prefix != namespace_prefix:
            raise ValueError(
                f"{path} was written for namespace prefix {recorded_prefix!r} but "
                f"MEMWAL_NAMESPACE_PREFIX is {namespace_prefix!r}; those facts live "
                f"in different namespaces, so this run cannot resume from it"
            )
        if not isinstance(payload.get("users"), dict):
            payload["users"] = {}
        return cls(path, namespace_prefix, payload)

    @staticmethod
    def _empty(namespace_prefix: str) -> dict[str, Any]:
        return {
            "version": STATE_VERSION,
            "namespace_prefix": namespace_prefix,
            "users": {},
        }

    def is_complete(self, user_id: UUID) -> bool:
        """True when a previous run finished this user's facts."""
        entry = self._payload["users"].get(str(user_id))
        return bool(isinstance(entry, dict) and entry.get("completed"))

    def written_keys(self, user_id: UUID) -> set[str]:
        """The fact keys already recorded for this user."""
        entry = self._payload["users"].get(str(user_id))
        if not isinstance(entry, dict):
            return set()
        facts = entry.get("facts")
        return set(facts) if isinstance(facts, dict) else set()

    def record(self, user_id: UUID, fact_key: str, fact_text: str) -> None:
        """Record one accepted fact for a user and leave the file unsaved."""
        entry = self._entry(user_id)
        facts = entry.get("facts")
        if not isinstance(facts, dict):
            facts = {}
            entry["facts"] = facts
        facts[fact_key] = fact_text
        entry["updated_at"] = _now()

    def complete(self, user_id: UUID) -> None:
        """Mark a user as fully recorded and leave the file unsaved."""
        entry = self._entry(user_id)
        entry["completed"] = True
        entry["updated_at"] = _now()

    def _entry(self, user_id: UUID) -> dict[str, Any]:
        entry = self._payload["users"].setdefault(str(user_id), {})
        if not isinstance(entry, dict):
            entry = {}
            self._payload["users"][str(user_id)] = entry
        return entry

    def save(self) -> None:
        """Write the state atomically, so a kill cannot leave half a file.

        A partial file would be a corrupt one on the next run, and the next run
        refuses to guess what it meant. Writing a sibling and renaming it into
        place means the file on disk is always one complete version.
        """
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, exist_ok=True)
        temporary = f"{self.path}.tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(self._payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)


class MemoryBackfillService:
    """Walk every user and store the facts their history supports.

    ``open_history`` opens one fact source of its own for each read: the caller
    owns the database lifecycle, and calling it must yield a
    :class:`UserHistoryService` bound to a fresh session that is closed when the
    block exits. Opening one per read, rather than holding one for the run, is
    what keeps a long run from sitting on a connection the pooler will close.
    ``memory`` owns the namespace, the fact keys and the relayer call, and
    ``state`` is the resume point. ``emit`` receives one already-formatted line
    at a time so the dry run reads like a report without the service knowing
    about stdout.
    """

    def __init__(
        self,
        *,
        open_history: Callable[
            [], AbstractAsyncContextManager[UserHistoryService]
        ],
        memory: FactMemoryService,
        namespace_prefix: str,
        state: Optional[BackfillState] = None,
        requests_per_minute: int = DEFAULT_REQUESTS_PER_MINUTE,
        emit: Optional[Callable[[str], None]] = None,
        sleep: Optional[Callable[[float], Any]] = None,
        clock: Optional[Callable[[], float]] = None,
    ) -> None:
        self._open_history = open_history
        self._memory = memory
        self._namespace_prefix = namespace_prefix
        self._state = state
        self._pacer = Pacer(requests_per_minute, sleep=sleep, clock=clock)
        self._emit = emit or (lambda line: None)

    async def run(self, *, dry_run: bool) -> BackfillReport:
        """Backfill every user, or describe what would be written.

        In a dry run nothing is written: the relayer is never called and the
        state file is never saved. The report still counts what is already
        recorded, so a second review shows how much of the work is done.
        """
        if not dry_run:
            if not self._memory.enabled:
                raise RuntimeError(
                    "the backfill cannot write: FEATURE_AGENT_WALRUS_MEMORY is off "
                    "or MEMWAL credentials are missing (operation=run_backfill)"
                )

        async with self._open_history() as history:
            user_ids = await history.user_ids()

        total_users = len(user_ids)
        users_complete = 0
        users_missing = 0
        users_failed = 0
        facts_total = 0
        facts_recorded = 0
        facts_written = 0

        for index, user_id in enumerate(user_ids, start=1):
            if not dry_run and self._state is not None and self._state.is_complete(user_id):
                users_complete += 1
                continue

            # One user's failure is that user's problem. A connection the pooler
            # closed, or a relayer that will not answer, must not abandon every
            # user behind this one: the state file already holds what was
            # accepted, so the next run resumes exactly here.
            try:
                history = await self._read_user(user_id)
                if history is None:
                    users_missing += 1
                    self._emit(
                        f"[{index}/{total_users}] {user_id} no longer exists; skipped"
                    )
                    continue

                writes = self._memory.plan(user_id, history.facts)
                facts_total += len(writes)
                recorded_keys = (
                    self._state.written_keys(user_id)
                    if self._state is not None
                    else set()
                )

                self._emit(_header_line(index, total_users, history))
                if not writes:
                    self._emit("  (no facts)")

                user_written = 0
                user_recorded = 0
                for write in writes:
                    if write.key in recorded_keys:
                        facts_recorded += 1
                        user_recorded += 1
                        self._emit(f"  = {write.text}")
                        continue

                    if dry_run:
                        self._emit(f"  + {write.text}")
                        continue

                    await self._pacer.wait()
                    await self._memory.write(user_id, write)
                    if self._state is not None:
                        self._state.record(user_id, write.key, write.text)
                        self._state.save()
                    facts_written += 1
                    user_written += 1
                    self._emit(f"  + {write.text}")

                if not dry_run:
                    if self._state is not None:
                        self._state.complete(user_id)
                        self._state.save()
                    self._emit(
                        f"  wrote {user_written} facts, {user_recorded} already recorded"
                    )
            except Exception as exc:  # noqa: BLE001 - one user must not end the run
                users_failed += 1
                self._emit(
                    f"[{index}/{total_users}] {user_id} stopped: "
                    f"{type(exc).__name__}: {exc}; left incomplete, the next run "
                    f"resumes from here"
                )

        return BackfillReport(
            dry_run=dry_run,
            users=total_users,
            users_complete=users_complete,
            users_missing=users_missing,
            users_failed=users_failed,
            facts_total=facts_total,
            facts_recorded=facts_recorded,
            facts_written=facts_written,
        )

    async def _read_user(self, user_id: UUID) -> Optional[UserHistory]:
        """Load one user's rows through a session of their own, then close it.

        The session is opened and closed inside this call, so the rows are fully
        loaded before any Walrus write and no transaction is held open across a
        network call. That is what a long run against a connection pooler needs:
        a session kept for the whole run is a connection the pooler will close
        underneath it.
        """
        async with self._open_history() as history:
            return await history.history(user_id)

    def describe_pace(self) -> str:
        """One line describing the pace, for the CLI banner."""
        return (
            f"{self._pacer.interval_seconds:.2f} seconds between writes "
            f"({60.0 / self._pacer.interval_seconds:.1f} requests per minute)"
        )

    @property
    def namespace_prefix(self) -> str:
        """The prefix every namespace in this run is built from."""
        return self._namespace_prefix


def _header_line(index: int, total: int, history: UserHistory) -> str:
    """The one-line summary shown before a user's facts.

    Counts only: the product has no fixed sides, so the header says what the
    rows show the user did rather than which side they are on.
    """
    return (
        f"[{index}/{total}] {history.user_id} {history.display_name} "
        f"({history.as_client} posted, {history.as_provider} hired, "
        f"{history.active_listings} active listings)"
    )


def _now() -> str:
    """An ISO-8601 UTC timestamp for the state file."""
    return datetime.now(timezone.utc).isoformat()
