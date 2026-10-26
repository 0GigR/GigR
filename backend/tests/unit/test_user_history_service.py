"""One user's rows become the sentences their history really supports.

The service is exercised through its own seam: the crud functions it imports are
replaced with rows shaped exactly like the columns they come from (UUID keys,
numeric prices, timezone-aware timestamps, a PostGIS value for the location).
Nothing here asserts on a mock call; every assertion is on the returned
sentences and the counts they were derived from.
"""

from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from geoalchemy2.elements import WKBElement

import app.services.osm_geo as osm_geo
import app.services.user_history_service as history_module
from app.core.gateways.geocoding_gateway import GeocodingGateway
from app.core.resilience import Boundary, ResiliencePolicy, StructuredLogMetricSink
from app.models.dispute import Dispute, DisputeStatus
from app.models.job import Job
from app.models.message import Message
from app.models.rating import Rating
from app.models.service import ServiceListing
from app.models.user import User
from app.services.user_history_service import UserHistoryService

USER_ID = UUID("0b7f9a52-1c4d-4e88-9f31-2a1c5d6e7f80")
OTHER_ID = UUID("9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f")
CATEGORY_ID = UUID("7f3a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c")

# A real PostGIS point, as the geography column hands it back.
LOCATION = WKBElement(
    bytes.fromhex("0101000020E61000000000000000001C400000000000001040"),
    srid=4326,
)


def _user(**overrides):
    user = User(
        id=USER_ID,
        display_name="Bola Ade",
        role="postgres",
        skills=["plumbing", "tiling"],
        last_location=LOCATION,
        location_lat=6.5095,
        location_lng=3.3711,
    )
    for key, value in overrides.items():
        setattr(user, key, value)
    return user


def _job(**overrides):
    job = Job(
        id=uuid4(),
        client_id=USER_ID,
        provider_id=OTHER_ID,
        title="Fix leaking sink",
        price=Decimal("18000.00"),
        status="completed",
        category_id=CATEGORY_ID,
        location=LOCATION,
        created_at=datetime(2026, 3, 12, 9, 30, tzinfo=timezone.utc),
    )
    for key, value in overrides.items():
        setattr(job, key, value)
    return job


def _provider_job(**overrides):
    job = _job(provider_id=USER_ID, client_id=OTHER_ID, title="Leak repair")
    for key, value in overrides.items():
        setattr(job, key, value)
    return job


def _listing(**overrides):
    listing = ServiceListing(
        id=uuid4(),
        provider_id=USER_ID,
        title="Emergency pipe repair",
        price=Decimal("12000.00"),
        radius_km=Decimal("7.50"),
        is_active=True,
        category_id=CATEGORY_ID,
        location=LOCATION,
    )
    for key, value in overrides.items():
        setattr(listing, key, value)
    return listing


def _rating(**overrides):
    rating = Rating(
        id=uuid4(), job_id=uuid4(), ratee_id=USER_ID, score=4,
        created_at=datetime(2026, 3, 12, 9, 30, tzinfo=timezone.utc),
    )
    for key, value in overrides.items():
        setattr(rating, key, value)
    return rating


def _dispute(**overrides):
    dispute = Dispute(
        id=uuid4(),
        job_id=uuid4(),
        client_id=USER_ID,
        provider_id=OTHER_ID,
        reason="Work was not finished.",
        raised_by=USER_ID,
        status=DisputeStatus.RESOLVED,
    )
    for key, value in overrides.items():
        setattr(dispute, key, value)
    return dispute


def _message(**overrides):
    message = Message(
        id=overrides.pop("id", uuid4()),
        job_id=overrides.pop("job_id", uuid4()),
        sender_id=overrides.pop("sender_id", USER_ID),
        applicant_id=overrides.pop("applicant_id", None),
        content="See you at ten.",
        created_at=overrides.pop(
            "created_at", datetime(2026, 3, 12, 9, 30, tzinfo=timezone.utc)
        ),
    )
    for key, value in overrides.items():
        setattr(message, key, value)
    return message


def _patch_crud(
    monkeypatch,
    *,
    user=None,
    services=(),
    client_jobs=(),
    provider_jobs=(),
    ratings=(),
    disputes=(),
    category_names=None,
    messages_for_jobs=(),
    messages_by_sender=(),
    disputes_for_jobs=(),
    jobs_by_ids=(),
):
    """Install the crud layer the service reads, with real row shapes."""

    async def fake_get_user_by_id(db, user_id):
        return user if user is not None and user.id == user_id else None

    async def fake_user_ids(db):
        return [user.id] if user is not None else []

    async def fake_services(db, provider_id):
        return list(services)

    async def fake_client_jobs(db, client_id):
        return list(client_jobs)

    async def fake_provider_jobs(db, provider_id):
        return list(provider_jobs)

    async def fake_ratings(db, ratee_id):
        return list(ratings)

    async def fake_disputes(db, user_id):
        return list(disputes)

    async def fake_category_names(db, category_ids):
        return dict(category_names or {})

    async def fake_messages_for_jobs(db, job_ids):
        return list(messages_for_jobs)

    async def fake_messages_by_sender(db, sender_id):
        return list(messages_by_sender)

    async def fake_disputes_for_jobs(db, job_ids):
        return list(disputes_for_jobs)

    async def fake_jobs_by_ids(db, job_ids):
        return list(jobs_by_ids)

    monkeypatch.setattr(history_module, "get_user_by_id", fake_get_user_by_id)
    monkeypatch.setattr(history_module, "list_user_ids", fake_user_ids)
    monkeypatch.setattr(history_module, "list_active_services_by_provider", fake_services)
    monkeypatch.setattr(history_module, "list_all_jobs_by_client", fake_client_jobs)
    monkeypatch.setattr(history_module, "list_all_jobs_by_provider", fake_provider_jobs)
    monkeypatch.setattr(history_module, "list_ratings_by_ratee", fake_ratings)
    monkeypatch.setattr(history_module, "list_disputes_for_user", fake_disputes)
    monkeypatch.setattr(history_module, "get_category_names", fake_category_names)
    monkeypatch.setattr(history_module, "list_messages_for_jobs", fake_messages_for_jobs)
    monkeypatch.setattr(history_module, "list_messages_by_sender", fake_messages_by_sender)
    monkeypatch.setattr(history_module, "list_disputes_for_jobs", fake_disputes_for_jobs)
    monkeypatch.setattr(history_module, "list_jobs_by_ids", fake_jobs_by_ids)


NOMINATIM_PLACE = {
    "lat": "6.5095",
    "lon": "3.3711",
    "display_name": "Lekki, Lagos, Nigeria",
    "address": {"suburb": "Lekki", "city": "Lagos"},
}


class _FakeResponse:
    """One Nominatim answer, or one failure."""

    def __init__(self, payload=None, fail: bool = False) -> None:
        self._payload = payload
        self._fail = fail

    def raise_for_status(self) -> None:
        if self._fail:
            raise RuntimeError("Nominatim answered 503")

    def json(self):
        return self._payload


class _FakeNominatim:
    """Stands in for httpx.AsyncClient; records every request it receives."""

    def __init__(self, responses) -> None:
        self._responses = list(responses)
        self.requests: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    async def get(self, url, params=None):
        self.requests.append({"url": url, "params": dict(params or {})})
        if not self._responses:
            raise AssertionError("unexpected second Nominatim request")
        response = self._responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def _patch_nominatim(monkeypatch, responses) -> _FakeNominatim:
    """Replace the HTTP layer below the real Nominatim client.

    The throttle timestamp is process-wide, so it is reset too: a lookup an
    earlier test made a moment ago would otherwise make the first request here
    wait a real second and race the boundary's timeout.
    """
    http = _FakeNominatim(responses)
    osm_geo._geocode_cache.clear()
    monkeypatch.setattr(osm_geo, "_last_nominatim_call", 0.0)
    monkeypatch.setattr(osm_geo, "_client", lambda: http)
    return http


def _geocoding_gateway() -> GeocodingGateway:
    """The real gateway over the real Nominatim client and a fake HTTP layer."""
    boundary = Boundary(
        ResiliencePolicy(
            dependency="nominatim",
            timeout_seconds=1.0,
            failure_threshold=5,
            reset_timeout_seconds=60.0,
            max_attempts=1,
            max_concurrency=1,
        ),
        StructuredLogMetricSink("nominatim-test"),
    )
    return GeocodingGateway(boundary=boundary, reverse_geocode=osm_geo.reverse_geocode)


class _BrokenGeocoder:
    """A geocoder that raises instead of answering: the worst plausible case."""

    async def place_name(self, latitude, longitude):
        raise RuntimeError("geocoder exploded")


async def test_a_user_who_did_both_is_never_given_a_side(monkeypatch):
    """Gigr has no fixed sides: the same person hires and is hired.

    A user who has posted jobs, been hired, and has a live listing still gets no
    sentence about being a client or a provider; the rows produce only what they
    actually show.
    """
    _patch_crud(
        monkeypatch,
        user=_user(),
        client_jobs=[_job(id=uuid4(), status="open"), _job(id=uuid4())],
        provider_jobs=[_provider_job(id=uuid4(), price=Decimal("20000.00"))],
        services=[_listing()],
        category_names={CATEGORY_ID: "Plumbing"},
    )
    history = await UserHistoryService(db=None).history(USER_ID)

    assert not any("on Gigr." in fact for fact in history.facts)
    assert "Bola Ade lists Emergency pipe repair at 12000 naira within 7.5 km." in (
        history.facts
    )
    assert (
        "Bola Ade hired a provider for Fix leaking sink at 18000 naira "
        "(completed, 2026)."
    ) in history.facts
    assert "Bola Ade has completed 1 job as a client and 1 as a provider." in (
        history.facts
    )


async def test_an_active_listing_alone_produces_no_side_sentence(monkeypatch):
    _patch_crud(monkeypatch, user=_user(), services=[_listing()])
    history = await UserHistoryService(db=object()).history(USER_ID)
    assert history.facts == (
        "Bola Ade works in plumbing and tiling.",
        "Bola Ade lists Emergency pipe repair at 12000 naira within 7.5 km.",
    )


async def test_a_user_with_nothing_gets_no_side_sentence(monkeypatch):
    _patch_crud(monkeypatch, user=_user(skills=["plumbing", "tiling"]))
    history = await UserHistoryService(db=object()).history(USER_ID)
    assert history.facts == ("Bola Ade works in plumbing and tiling.",)


async def test_the_job_category_is_passed_as_the_name_not_the_id(monkeypatch):
    jobs = [
        _job(id=uuid4(), title="Fix tap", price=12000),
        _job(id=uuid4(), title="Replace pipe", price=20000),
    ]
    _patch_crud(
        monkeypatch,
        user=_user(),
        client_jobs=jobs,
        category_names={CATEGORY_ID: "Plumbing"},
    )
    history = await UserHistoryService(db=object()).history(USER_ID)

    assert "Bola Ade usually budgets around 16000 naira for Plumbing." in history.facts
    assert not any(str(CATEGORY_ID) in fact for fact in history.facts)


async def test_a_job_without_a_category_produces_no_budget_sentence(monkeypatch):
    jobs = [
        _job(id=uuid4(), title="Fix tap", price=12000, category_id=None),
        _job(id=uuid4(), title="Replace pipe", price=20000, category_id=None),
    ]
    _patch_crud(monkeypatch, user=_user(), client_jobs=jobs)
    history = await UserHistoryService(db=object()).history(USER_ID)
    assert not any("budgets around" in fact for fact in history.facts)


async def test_a_postgis_location_never_becomes_a_place_name(monkeypatch):
    """users.last_location is a geography value and no place text exists, so no
    sentence may claim where the user is based."""
    _patch_crud(
        monkeypatch,
        user=_user(),
        client_jobs=[_job(id=uuid4())],
        category_names={CATEGORY_ID: "Plumbing"},
    )
    history = await UserHistoryService(db=object()).history(USER_ID)

    assert not any("is based in" in fact for fact in history.facts)
    # A job fact needs no place, so it is still written - but the geometry
    # value itself must never appear in any sentence.
    hex_point = str(LOCATION)
    assert not any(hex_point in fact for fact in history.facts)
    assert not any("POINT" in fact for fact in history.facts)
    assert not any("0101" in fact for fact in history.facts)
    assert not any(" in  " in fact for fact in history.facts)


async def test_only_active_listings_produce_a_listing_sentence(monkeypatch):
    _patch_crud(
        monkeypatch,
        user=_user(),
        services=[
            _listing(id=uuid4(), title="Live listing"),
            _listing(id=uuid4(), title="Paused listing", is_active=False),
        ],
    )
    history = await UserHistoryService(db=object()).history(USER_ID)
    assert "Bola Ade lists Live listing at 12000 naira within 7.5 km." in history.facts
    assert not any("Paused listing" in fact for fact in history.facts)


async def test_completed_counts_and_ratings_and_disputes_reach_the_facts(monkeypatch):
    _patch_crud(
        monkeypatch,
        user=_user(),
        client_jobs=[
            _job(id=uuid4(), status="completed"),
            _job(id=uuid4(), status="open"),
        ],
        provider_jobs=[_provider_job(id=uuid4(), status="completed")],
        ratings=[_rating(score=3), _rating(score=5)],
        disputes=[
            _dispute(status=DisputeStatus.OPEN),
            _dispute(status=DisputeStatus.RESOLVED),
        ],
        category_names={CATEGORY_ID: "Plumbing"},
    )
    history = await UserHistoryService(db=object()).history(USER_ID)
    facts = history.facts

    assert "Bola Ade has completed 1 job as a client and 1 as a provider." in facts
    assert "Bola Ade has an average rating of 4.0 from 2 ratings." in facts
    assert "Bola Ade has 1 dispute in progress." in facts
    assert "Bola Ade has 1 resolved dispute." in facts


async def test_messages_on_the_users_own_job_become_conversation_facts(monkeypatch):
    job = _job(id=uuid4())
    _patch_crud(
        monkeypatch,
        user=_user(),
        client_jobs=[job],
        messages_for_jobs=[
            _message(job_id=job.id, applicant_id=None, sender_id=USER_ID),
            _message(job_id=job.id, applicant_id=None, sender_id=OTHER_ID),
        ],
        category_names={CATEGORY_ID: "Plumbing"},
    )
    history = await UserHistoryService(db=object()).history(USER_ID)

    assert "Bola Ade has 1 message conversation on Gigr." in history.facts
    assert "Bola Ade has sent 1 message." in history.facts
    assert "Bola Ade has 1 contract room conversation." in history.facts
    assert "Bola Ade has messaged about Fix leaking sink." in history.facts


async def test_a_message_the_user_sent_on_someone_elses_job_is_included(monkeypatch):
    """An applicant's pre-assignment thread hangs off a job they do not own, so
    the job has to be fetched by id to name it."""
    other_job_id = uuid4()
    _patch_crud(
        monkeypatch,
        user=_user(),
        messages_by_sender=[
            _message(job_id=other_job_id, applicant_id=USER_ID, sender_id=USER_ID)
        ],
        jobs_by_ids=[_job(id=other_job_id, client_id=OTHER_ID, title="Move furniture")],
    )
    history = await UserHistoryService(db=object()).history(USER_ID)

    assert "Bola Ade has 1 message conversation on Gigr." in history.facts
    assert "Bola Ade has messaged about Move furniture." in history.facts


async def test_one_message_returned_by_both_queries_is_counted_once(monkeypatch):
    job = _job(id=uuid4())
    shared = _message(id=uuid4(), job_id=job.id, sender_id=USER_ID)
    _patch_crud(
        monkeypatch,
        user=_user(),
        client_jobs=[job],
        messages_for_jobs=[shared],
        messages_by_sender=[shared],
        category_names={CATEGORY_ID: "Plumbing"},
    )
    history = await UserHistoryService(db=object()).history(USER_ID)

    assert "Bola Ade has sent 1 message." in history.facts
    assert "Bola Ade has 1 message conversation on Gigr." in history.facts


async def test_a_dispute_on_a_discussed_job_reaches_the_message_facts(monkeypatch):
    job = _job(id=uuid4())
    _patch_crud(
        monkeypatch,
        user=_user(),
        client_jobs=[job],
        messages_for_jobs=[_message(job_id=job.id)],
        disputes_for_jobs=[_dispute(job_id=job.id)],
        category_names={CATEGORY_ID: "Plumbing"},
    )
    history = await UserHistoryService(db=object()).history(USER_ID)
    assert "A dispute was raised on a job Bola Ade messaged about." in history.facts


async def test_a_missing_user_has_no_history(monkeypatch):
    _patch_crud(monkeypatch, user=None)
    assert await UserHistoryService(db=object()).history(USER_ID) is None


async def test_the_display_name_is_cleaned_for_output(monkeypatch):
    _patch_crud(
        monkeypatch,
        user=_user(display_name="  Bola\u202e Ade  "),
        services=[_listing()],
    )
    history = await UserHistoryService(db=object()).history(USER_ID)
    assert history.display_name == "Bola Ade"
    assert all("\u202e" not in fact for fact in history.facts)


async def test_every_fact_is_unique(monkeypatch):
    _patch_crud(
        monkeypatch,
        user=_user(),
        services=[_listing(id=uuid4()), _listing(id=uuid4())],
        client_jobs=[_job(id=uuid4()), _job(id=uuid4())],
        category_names={CATEGORY_ID: "Plumbing"},
    )
    history = await UserHistoryService(db=object()).history(USER_ID)
    assert len(history.facts) == len(set(history.facts))


async def test_user_ids_come_from_the_crud_order(monkeypatch):
    _patch_crud(monkeypatch, user=_user())
    assert await UserHistoryService(db=object()).user_ids() == [USER_ID]


async def test_a_reverse_geocoded_point_becomes_the_place_in_the_fact(monkeypatch):
    """The PostGIS point is not a place name, so the sentence may only name a
    place the geocoder actually returned. The user point and the job point here
    are the same point, so the cache must answer the second lookup."""
    _patch_crud(
        monkeypatch,
        user=_user(),
        client_jobs=[_job(id=uuid4())],
        category_names={CATEGORY_ID: "Plumbing"},
    )
    http = _patch_nominatim(
        monkeypatch, [_FakeResponse(NOMINATIM_PLACE), _FakeResponse(NOMINATIM_PLACE)]
    )

    history = await UserHistoryService(
        db=object(), geocoder=_geocoding_gateway()
    ).history(USER_ID)

    assert "Bola Ade is based in Lekki, Lagos." in history.facts
    assert (
        "Bola Ade hired a provider for Fix leaking sink at 18000 naira "
        "in Lekki, Lagos (completed, 2026)."
    ) in history.facts
    assert len(http.requests) == 1
    assert http.requests[0]["url"].endswith("/reverse")


async def test_a_failed_reverse_geocode_produces_no_location_fact(monkeypatch):
    """A geocoder outage may cost the place clause, never the other facts: the
    user is written without "based in" and the job without "in ...", and every
    other sentence still appears."""
    _patch_crud(
        monkeypatch,
        user=_user(),
        client_jobs=[_job(id=uuid4(), location=None)],
        services=[_listing()],
        category_names={CATEGORY_ID: "Plumbing"},
    )
    http = _patch_nominatim(monkeypatch, [_FakeResponse(fail=True)])

    history = await UserHistoryService(
        db=object(), geocoder=_geocoding_gateway()
    ).history(USER_ID)

    # One point had to be looked up, and its failure did not stop the rest.
    assert len(http.requests) == 1
    assert http.requests[0]["url"].endswith("/reverse")
    assert not any("is based in" in fact for fact in history.facts)
    assert (
        "Bola Ade hired a provider for Fix leaking sink at 18000 naira "
        "(completed, 2026)."
    ) in history.facts
    assert "Bola Ade lists Emergency pipe repair at 12000 naira within 7.5 km." in (
        history.facts
    )
    assert "Bola Ade works in plumbing and tiling." in history.facts


async def test_a_crashing_geocoder_cannot_fail_the_users_history(monkeypatch):
    """The service must absorb a geocoder that raises, because the backfill it
    feeds is not allowed to stop over a place name."""
    _patch_crud(
        monkeypatch,
        user=_user(),
        client_jobs=[_job(id=uuid4())],
        category_names={CATEGORY_ID: "Plumbing"},
    )

    history = await UserHistoryService(
        db=object(), geocoder=_BrokenGeocoder()
    ).history(USER_ID)

    assert history is not None
    assert not any("is based in" in fact for fact in history.facts)
    assert (
        "Bola Ade hired a provider for Fix leaking sink at 18000 naira "
        "(completed, 2026)."
    ) in history.facts
    assert not any("on Gigr." in fact for fact in history.facts)
