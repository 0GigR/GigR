"""Gather one user's marketplace rows and turn them into fact sentences.

This is the only place that knows which rows make a fact about a user, and the
only place that resolves the fields the extractor cannot resolve for itself:

* a job row carries ``category_id``, so the category name is fetched in one
  batched query and passed under the ``category`` key the extractor reads;
* ``users.role`` holds authorization values ("user", "admin", "postgres", ...)
  and is never read here. Gigr has no fixed sides: the same person can hire and
  be hired, so no marketplace side is derived and no role sentence is produced.
  The per-user activity counts kept on :class:`UserHistory` are there for the
  operator's dry-run header, not to label anyone.

Location is resolved, not copied. ``users.last_location`` and ``jobs.location``
are PostGIS geography columns, and no column in this schema holds a place name.
The extractor needs a place name for "is based in ..." and for "hired a provider
for ... in ..."; passing a geometry value would render a coordinate pair as if
it were a place, which contract 3 of its docstring forbids.

So a point becomes a place name only through the injected geocoding gateway,
which reuses the process's Nominatim client and its cache. The gateway is the
only reason this service makes an outbound call, it is optional (the map-less
default is unchanged), and a lookup that fails is caught here: a missing place
name costs one prepositional phrase, never the user's other facts. With no
gateway, or no place, no location sentence is produced at all.

The service reads through the crud layer and never builds a query itself.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Optional
from uuid import UUID

from ..core.geo import extract_coordinates
from ..crud.category import get_category_names
from ..crud.dispute import list_disputes_for_jobs, list_disputes_for_user
from ..crud.job import (
    list_all_jobs_by_client,
    list_all_jobs_by_provider,
    list_jobs_by_ids,
)
from ..crud.message import list_messages_by_sender, list_messages_for_jobs
from ..crud.rating import list_ratings_by_ratee
from ..crud.service import list_active_services_by_provider
from ..crud.user import get_user_by_id, list_user_ids
from .message_fact_service import build_message_facts
from .user_fact_service import build_user_facts, clean_fact_text

if TYPE_CHECKING:  # pragma: no cover - typing only, never imported at runtime
    from sqlalchemy.ext.asyncio import AsyncSession

    from ..core.gateways.geocoding_gateway import GeocodingGateway

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class UserHistory:
    """One user's fact sentences plus the counts the dry run reports.

    ``as_client``, ``as_provider`` and ``active_listings`` are activity counts
    for the operator's header line: how many jobs they posted, how many they
    were hired for, and how many listings are live. They label nobody, because
    the product has no fixed sides. ``display_name`` is already cleaned for
    output.
    """

    user_id: UUID
    display_name: str
    as_client: int
    as_provider: int
    active_listings: int
    facts: tuple[str, ...]


class UserHistoryService:
    """Build the fact sentences one user's rows support.

    ``db`` is the caller's session; the service only reads. Every query is
    batched over the user's own rows, so the work per user is a fixed set of
    queries rather than one per job or per message.

    ``geocoder`` is injected from the composition root and may be None, in which
    case no point is ever turned into a place name and no location sentence is
    produced. It is the only outbound dependency this service has.
    """

    def __init__(
        self,
        db: "AsyncSession",
        geocoder: Optional["GeocodingGateway"] = None,
    ) -> None:
        self._db = db
        self._geocoder = geocoder

    async def user_ids(self) -> list[UUID]:
        """Every user id, in the stable order the backfill walks them."""
        return await list_user_ids(self._db)

    async def history(self, user_id: UUID) -> Optional[UserHistory]:
        """Return the user's facts, or None when the user does not exist."""
        user = await get_user_by_id(self._db, user_id)
        if user is None:
            return None

        services = await list_active_services_by_provider(self._db, user_id)
        client_jobs = await list_all_jobs_by_client(self._db, user_id)
        provider_jobs = await list_all_jobs_by_provider(self._db, user_id)
        ratings = await list_ratings_by_ratee(self._db, user_id)
        disputes = await list_disputes_for_user(self._db, user_id)
        category_names = await get_category_names(
            self._db,
            [job.category_id for job in client_jobs if job.category_id is not None],
        )

        display_name = clean_fact_text(user.display_name)
        user_place = await self._place_name(user.last_location)
        client_places = await self._places_for_jobs(client_jobs)

        facts: list[str] = []
        facts.extend(
            build_user_facts(
                {
                    "id": user.id,
                    "display_name": user.display_name,
                    "skills": user.skills,
                    "last_location": user_place,
                },
                services=[_service_row(listing) for listing in services],
                client_jobs=[
                    _job_row(job, category_names, client_places.get(job.id))
                    for job in client_jobs
                ],
                provider_jobs=[
                    _job_row(job, category_names) for job in provider_jobs
                ],
                ratings=[_rating_row(rating) for rating in ratings],
                disputes=[_dispute_row(dispute) for dispute in disputes],
            )
        )
        facts.extend(await self._message_facts(user_id, user, client_jobs, provider_jobs))

        return UserHistory(
            user_id=user.id,
            display_name=display_name,
            as_client=len(client_jobs),
            as_provider=len(provider_jobs),
            active_listings=len(services),
            facts=tuple(dict.fromkeys(facts)),
        )

    async def _message_facts(
        self,
        user_id: UUID,
        user: Any,
        client_jobs: list[Any],
        provider_jobs: list[Any],
    ) -> list[str]:
        """Conversation facts for the jobs and threads this user is part of.

        Two message queries, not one: a pre-assignment conversation hangs off a
        job the applicant is neither the client nor the provider of, so the
        messages on the user's own jobs do not include what they wrote there.
        The two sets overlap, and a message counted twice would inflate the
        thread counts, so they are merged on the message id.
        """
        own_jobs = list(client_jobs) + list(provider_jobs)
        own_job_ids = [job.id for job in own_jobs]
        titles = {job.id: job.title for job in own_jobs}

        messages: dict[Any, Any] = {}
        for message in await list_messages_for_jobs(self._db, own_job_ids):
            messages[message.id] = message
        for message in await list_messages_by_sender(self._db, user_id):
            messages.setdefault(message.id, message)

        if not messages:
            return []

        discussed_job_ids = {message.job_id for message in messages.values()}
        missing_ids = [job_id for job_id in discussed_job_ids if job_id not in titles]
        if missing_ids:
            for job in await list_jobs_by_ids(self._db, missing_ids):
                titles[job.id] = job.title

        disputed_job_ids = {
            dispute.job_id
            for dispute in await list_disputes_for_jobs(
                self._db, list(discussed_job_ids)
            )
        }

        threads = _threads(messages.values(), user_id, titles, disputed_job_ids)
        return build_message_facts(
            {"display_name": user.display_name}, threads=threads
        )

    async def _place_name(self, location_value: Any) -> Optional[str]:
        """The place name for one PostGIS point, or None.

        ``extract_coordinates`` is the one geometry reader in the codebase, and
        it answers (None, None) for a missing or unreadable value; no lookup is
        attempted then. A lookup failure is caught here as well as inside the
        gateway, because a missing place name may cost one clause but must never
        cost the user the rest of their facts.
        """
        if self._geocoder is None:
            return None
        latitude, longitude = extract_coordinates(location_value)
        if latitude is None or longitude is None:
            return None
        try:
            return await self._geocoder.place_name(latitude, longitude)
        except Exception as exc:  # noqa: BLE001 - a geocoder must not fail the backfill
            logger.warning(
                "[user-history] reverse geocode failed (operation=place_name): "
                "%s: %s; the fact is written without a place",
                type(exc).__name__,
                exc,
            )
            return None

    async def _places_for_jobs(self, jobs: list[Any]) -> dict[Any, Optional[str]]:
        """Reverse-geocode the user's job points, keyed by job id.

        Only a job that names a provider can produce the sentence that carries a
        place, so the rest are not looked up at all: a backfill must not spend
        the Nominatim budget on a row whose fact would be skipped anyway.
        """
        places: dict[Any, Optional[str]] = {}
        for job in jobs:
            if getattr(job, "provider_id", None) is None:
                continue
            places[job.id] = await self._place_name(getattr(job, "location", None))
        return places


def _job_row(
    job: Any, category_names: dict[Any, str], place: Optional[str] = None
) -> dict[str, Any]:
    """The mapping the extractor reads for one job, with the category name.

    ``place`` is the reverse-geocoded name of the job point, or None when there
    is no point, no geocoder, or the lookup failed. The extractor renders it
    only when it is real text, so a missing name drops the "in ..." clause
    instead of putting a coordinate in the sentence.
    """
    category_name = category_names.get(job.category_id) if job.category_id else None
    return {
        "id": job.id,
        "client_id": job.client_id,
        "provider_id": job.provider_id,
        "title": job.title,
        "price": job.price,
        "status": job.status,
        "created_at": job.created_at,
        "category": category_name,
        "location": place,
    }


def _service_row(listing: Any) -> dict[str, Any]:
    """The mapping the extractor reads for one service listing."""
    return {
        "id": listing.id,
        "provider_id": listing.provider_id,
        "title": listing.title,
        "price": listing.price,
        "radius_km": listing.radius_km,
        "is_active": listing.is_active,
    }


def _rating_row(rating: Any) -> dict[str, Any]:
    """The mapping the extractor reads for one received rating."""
    return {"id": rating.id, "ratee_id": rating.ratee_id, "score": rating.score}


def _dispute_row(dispute: Any) -> dict[str, Any]:
    """The mapping the extractor reads for one dispute.

    ``status`` is passed as its plain string value: the column is an enum whose
    stored name is upper case, and the extractor compares the lower-case word.
    """
    status = getattr(dispute.status, "value", dispute.status)
    return {
        "id": dispute.id,
        "job_id": dispute.job_id,
        "client_id": dispute.client_id,
        "provider_id": dispute.provider_id,
        "status": status,
    }


def _threads(
    messages: Any,
    user_id: UUID,
    titles: dict[Any, str],
    disputed_job_ids: set[Any],
) -> list[dict[str, Any]]:
    """Group messages into conversations, one mapping per (job, applicant).

    ``sent_count`` is how many of the conversation's messages this user sent,
    and ``last_message_at`` is the newest timestamp in it. Both come straight
    from columns; nothing here reads the message body.
    """
    grouped: dict[tuple[Any, Any], dict[str, Any]] = {}
    for message in messages:
        key = (message.job_id, message.applicant_id)
        entry = grouped.setdefault(
            key,
            {
                "job_id": message.job_id,
                "applicant_id": message.applicant_id,
                "sent_count": 0,
                "last_message_at": None,
            },
        )
        if message.sender_id == user_id:
            entry["sent_count"] += 1
        created_at = message.created_at
        if created_at is not None and (
            entry["last_message_at"] is None or created_at > entry["last_message_at"]
        ):
            entry["last_message_at"] = created_at

    return [
        {
            **entry,
            "job_title": titles.get(entry["job_id"]),
            "disputed": entry["job_id"] in disputed_job_ids,
        }
        for entry in grouped.values()
    ]
