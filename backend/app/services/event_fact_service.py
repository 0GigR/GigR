"""The sentences one marketplace event leaves behind, and the write of them.

An event is stored as an event, not as a recount. A single job row cannot
support an aggregate sentence: "has completed 1 job" built from one row would be
false for a user with five completed jobs, and building the aggregate would mean
re-reading every row the user owns on every event. So the builders below render
only what the event row itself states, and the aggregate sentences stay the
backfill's job. The backfill is idempotent and cheap to re-run, which is what
makes that split safe: re-running it writes only the sentences that changed.

The builders are pure, in the same style as ``user_fact_service``: a mapping in,
a list of at most one sentence out, and nothing written when a value the sentence
needs is missing or is not text. A job title that is a geometry value, empty, or
absent produces no sentence rather than a sentence about a coordinate.

One event can concern two people. A job concerns its client and its provider, and
each gets the sentence for their own side; a rating concerns the person rated; a
dispute resolution concerns both parties. Each sentence is written once, under
that user's namespace, and the relayer deduplicates it against an earlier write
of the same sentence by its idempotency key.

Inert by default: unless FEATURE_AGENT_WALRUS_MEMORY is on and a gateway is
configured, every entry point returns before it reads a row.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Optional
from uuid import UUID

from ..crud.dispute import get_dispute_by_id
from ..crud.job import get_job_by_id
from ..crud.rating import get_rating_by_id
from ..crud.user import get_user_by_id
from .fact_memory_service import FactMemoryService
from .user_fact_service import clean_fact_text, whole_naira

if TYPE_CHECKING:  # pragma: no cover - typing only, never imported at runtime
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

SIDE_CLIENT = "client"
SIDE_PROVIDER = "provider"

_COMPLETED_JOB_STATUS = "completed"
_RESOLVED_DISPUTE_STATUS = "resolved"
_MIN_RATING = 1
_MAX_RATING = 5


def build_job_fact(subject: Any, job: Mapping[str, Any], *, side: str) -> list[str]:
    """One sentence about a job event, said from one side of the job.

    side is "client" or "provider"; both are supported because a job concerns
    both, and the sentence differs: a client posted it or completed it as a
    client, a provider was hired for it or completed it as a provider. An
    unknown side, a missing title or a subject that is not text produces no
    sentence.

    Raises TypeError when job is not a mapping.
    """
    if not isinstance(job, Mapping):
        raise TypeError("job must be a mapping of job fields")

    name = clean_fact_text(subject)
    title = clean_fact_text(job.get("title"))
    if not name or not title:
        return []

    completed = (
        clean_fact_text(job.get("status")).casefold() == _COMPLETED_JOB_STATUS
    )
    if side == SIDE_CLIENT:
        verb = "completed" if completed else "posted a job for"
        suffix = f" {title} as a client" if completed else f" {title}"
    elif side == SIDE_PROVIDER:
        verb = "completed" if completed else "was hired for"
        suffix = f" {title} as a provider" if completed else f" {title}"
    else:
        return []

    price = whole_naira(job.get("price"))
    amount = f" at {price} naira" if price is not None else ""
    return [f"{name} {verb}{suffix}{amount}."]


def build_rating_fact(subject: Any, rating: Mapping[str, Any]) -> list[str]:
    """One sentence about a rating the subject received, or none.

    The row carries the score; it does not carry what the rating was about, and
    nothing here is inferred from the comment.

    Raises TypeError when rating is not a mapping.
    """
    if not isinstance(rating, Mapping):
        raise TypeError("rating must be a mapping of rating fields")

    name = clean_fact_text(subject)
    if not name:
        return []
    score = whole_naira(rating.get("score"))
    if score is None or not _MIN_RATING <= score <= _MAX_RATING:
        return []
    return [f"{name} received a {score} star rating."]


def build_dispute_fact(subject: Any, dispute: Mapping[str, Any]) -> list[str]:
    """One sentence about a dispute resolution, or none.

    Only a resolved dispute produces a sentence. An open dispute is a state the
    backfill's "has a dispute in progress" sentence already covers, and saying it
    twice in two wordings would put two copies of one fact in the store.

    Raises TypeError when dispute is not a mapping.
    """
    if not isinstance(dispute, Mapping):
        raise TypeError("dispute must be a mapping of dispute fields")

    name = clean_fact_text(subject)
    if not name:
        return []
    status = clean_fact_text(dispute.get("status"))
    if status.casefold() != _RESOLVED_DISPUTE_STATUS:
        return []
    return [f"{name} had a dispute resolved."]


class EventFactService:
    """Resolve an event to the users it concerns and store their sentences.

    ``db`` is the caller's session and is only used for reads; ``memory`` owns
    the namespace, the fact keys and the relayer call, and its ``enabled``
    property is the one place the feature flag is honoured.
    """

    def __init__(self, db: "AsyncSession", memory: FactMemoryService) -> None:
        self._db = db
        self._memory = memory

    async def store_from_result(self, result: Any) -> list[str]:
        """Store the sentences named by a task result's marketplace row ids.

        The agent loop passes the result it holds, whether the task ended in
        "completed" or failed after the row was written. A result that carries no
        job, rating or dispute id is not a learned fact about anyone, and nothing
        is written for it.
        """
        if not self._memory.enabled:
            return []
        if not isinstance(result, Mapping):
            return []

        stored: list[str] = []
        job_id = _row_id(result.get("job_id"))
        if job_id is not None:
            stored.extend(await self.store_job_event(job_id))
        rating_id = _row_id(result.get("rating_id"))
        if rating_id is not None:
            stored.extend(await self.store_rating_event(rating_id))
        dispute_id = _row_id(result.get("dispute_id"))
        if dispute_id is not None:
            stored.extend(await self.store_dispute_event(dispute_id))
        return stored

    async def store_job_event(self, job_id: UUID) -> list[str]:
        """Store one sentence for each side of the job, or nothing if it is gone."""
        if not self._memory.enabled:
            return []
        job = await get_job_by_id(self._db, job_id)
        if job is None:
            return []

        row = {"title": job.title, "price": job.price, "status": job.status}
        stored: list[str] = []
        for user_id, side in (
            (job.client_id, SIDE_CLIENT),
            (job.provider_id, SIDE_PROVIDER),
        ):
            if user_id is None:
                continue
            subject = await self._display_name(user_id)
            if not subject:
                continue
            stored.extend(
                await self._store(user_id, build_job_fact(subject, row, side=side))
            )
        return stored

    async def store_rating_event(self, rating_id: UUID) -> list[str]:
        """Store one sentence for the user the rating was left for."""
        if not self._memory.enabled:
            return []
        rating = await get_rating_by_id(self._db, rating_id)
        if rating is None:
            return []
        subject = await self._display_name(rating.ratee_id)
        if not subject:
            return []
        return await self._store(
            rating.ratee_id, build_rating_fact(subject, {"score": rating.score})
        )

    async def store_dispute_event(self, dispute_id: UUID) -> list[str]:
        """Store one sentence for each side of a resolved dispute."""
        if not self._memory.enabled:
            return []
        dispute = await get_dispute_by_id(self._db, dispute_id)
        if dispute is None:
            return []

        # The column stores the enum name in upper case; the sentence compares a
        # lower-case word, so the value is taken from the member itself.
        row = {"status": getattr(dispute.status, "value", dispute.status)}
        stored: list[str] = []
        seen: set[UUID] = set()
        for user_id in (dispute.client_id, dispute.provider_id):
            if user_id is None or user_id in seen:
                continue
            seen.add(user_id)
            subject = await self._display_name(user_id)
            if not subject:
                continue
            stored.extend(await self._store(user_id, build_dispute_fact(subject, row)))
        return stored

    async def _display_name(self, user_id: UUID) -> str:
        """The name a sentence calls the user by, or "" when they are gone."""
        user = await get_user_by_id(self._db, user_id)
        if user is None:
            return ""
        return clean_fact_text(user.display_name)

    async def _store(self, user_id: UUID, facts: list[str]) -> list[str]:
        """Store these sentences for one user, best effort.

        A relayer failure is logged and dropped, like every other memory write on
        the agent path: the agent task must not fail because the search index is
        unavailable. The remaining sentences for this user are abandoned,
        because a refusal usually means the breaker is open.
        """
        if not facts or not self._memory.enabled:
            return []

        stored: list[str] = []
        for write in self._memory.plan(user_id, facts):
            try:
                await self._memory.write(user_id, write)
            except Exception as exc:  # noqa: BLE001 - an outbound dependency may fail any way
                logger.warning(
                    "[memory-facts] storing a fact failed for user_id=%s "
                    "(operation=store_event_fact): %s: %s",
                    user_id,
                    type(exc).__name__,
                    exc,
                )
                break
            stored.append(write.text)
        return stored


def _row_id(value: Any) -> Optional[UUID]:
    """Return value as a UUID, or None when it is absent or not one.

    Task results carry ids as strings and, from an in-process caller, as UUIDs.
    Anything else (a title, a page name) is not a row id and is ignored rather
    than guessed at.
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, UUID):
        return value
    try:
        return UUID(str(value).strip())
    except (ValueError, AttributeError, TypeError):
        return None
