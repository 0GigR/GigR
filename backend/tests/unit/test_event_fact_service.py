"""An event becomes one sentence per person it concerns, and nobody else.

Two layers are tested here: the pure builders, which decide whether a row can
support a sentence at all, and the service, which resolves an event to the users
it concerns and writes through the real fact writer with a fake gateway. Every
assertion is on a sentence, a namespace or a key, never on a mock call.
"""

from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from geoalchemy2.elements import WKBElement

import app.services.event_fact_service as event_module
from app.core.config import settings
from app.services.event_fact_service import (
    EventFactService,
    build_dispute_fact,
    build_job_fact,
    build_rating_fact,
)
from app.services.fact_memory_service import FactMemoryService

CLIENT = UUID("11111111-1111-4111-8111-111111111111")
PROVIDER = UUID("22222222-2222-4222-8222-222222222222")
PREFIX = "gigr-user"


class FakeGateway:
    """The relayer, including the recall a failed write is verified with.

    ``fail`` is an unreachable relayer: nothing lands and the verification
    recall fails too, which is the worst case the write path has to handle
    without making a duplicate.
    """

    configured = True

    def __init__(self, fail=False):
        self.calls = []
        self.recall_calls = []
        self.fail = fail

    async def remember(self, text, namespace, idempotency_key=None):
        self.calls.append(
            {"text": text, "namespace": namespace, "idempotency_key": idempotency_key}
        )
        if self.fail:
            raise RuntimeError("relayer unreachable")
        return "job-1"

    async def recall(self, query, namespace, limit):
        self.recall_calls.append(
            {"query": query, "namespace": namespace, "limit": limit}
        )
        if self.fail:
            raise RuntimeError("relayer unreachable")
        return ()


# --- the pure builders -------------------------------------------------------


def test_a_client_job_with_a_price_reads_as_a_posting():
    assert build_job_fact(
        "Bola Ade", {"title": "Fix leaking sink", "price": 18000, "status": "open"}, side="client"
    ) == ["Bola Ade posted a job for Fix leaking sink at 18000 naira."]


def test_a_completed_job_says_completed_from_each_side():
    job = {"title": "Fix leaking sink", "price": 18000, "status": "completed"}
    assert build_job_fact("Bola Ade", job, side="client") == [
        "Bola Ade completed Fix leaking sink as a client at 18000 naira."
    ]
    assert build_job_fact("Bola Ade", job, side="provider") == [
        "Bola Ade completed Fix leaking sink as a provider at 18000 naira."
    ]


def test_a_hired_provider_gets_the_hired_sentence_before_completion():
    assert build_job_fact(
        "Bola Ade", {"title": "Fix leaking sink", "status": "in_progress"}, side="provider"
    ) == ["Bola Ade was hired for Fix leaking sink."]


def test_a_missing_price_omits_the_amount_instead_of_inventing_one():
    assert build_job_fact(
        "Bola Ade", {"title": "Fix leaking sink", "price": 0, "status": "open"}, side="client"
    ) == ["Bola Ade posted a job for Fix leaking sink."]
    assert build_job_fact(
        "Bola Ade", {"title": "Fix leaking sink", "price": 18000.5, "status": "open"}, side="client"
    ) == ["Bola Ade posted a job for Fix leaking sink."]


def test_a_geometry_is_not_a_job_title():
    point = WKBElement(
        bytes.fromhex("0101000020E61000000000000000001C400000000000001040"),
        srid=4326,
    )
    assert build_job_fact("Bola Ade", {"title": point, "status": "open"}, side="client") == []


def test_a_job_without_a_title_or_a_known_side_produces_no_sentence():
    assert build_job_fact("Bola Ade", {"status": "open"}, side="client") == []
    assert build_job_fact("Bola Ade", {"title": "Fix tap"}, side="driver") == []
    assert build_job_fact("  ", {"title": "Fix tap"}, side="client") == []


def test_a_rating_sentence_carries_the_score_from_the_row():
    assert build_rating_fact("Bola Ade", {"score": 5}) == [
        "Bola Ade received a 5 star rating."
    ]


def test_a_score_outside_one_to_five_produces_no_sentence():
    assert build_rating_fact("Bola Ade", {"score": 0}) == []
    assert build_rating_fact("Bola Ade", {"score": 6}) == []
    assert build_rating_fact("Bola Ade", {"score": None}) == []


def test_only_a_resolved_dispute_produces_a_sentence():
    assert build_dispute_fact("Bola Ade", {"status": "RESOLVED"}) == [
        "Bola Ade had a dispute resolved."
    ]
    assert build_dispute_fact("Bola Ade", {"status": "resolved"}) == [
        "Bola Ade had a dispute resolved."
    ]
    assert build_dispute_fact("Bola Ade", {"status": "open"}) == []


def test_a_geometry_is_not_a_dispute_status():
    point = WKBElement(
        bytes.fromhex("0101000020E61000000000000000001C400000000000001040"),
        srid=4326,
    )
    assert build_dispute_fact("Bola Ade", {"status": point}) == []


def test_the_builders_refuse_a_row_that_is_not_a_mapping():
    with pytest.raises(TypeError):
        build_job_fact("Bola Ade", ["not", "a", "job"], side="client")
    with pytest.raises(TypeError):
        build_rating_fact("Bola Ade", ["not", "a", "rating"])
    with pytest.raises(TypeError):
        build_dispute_fact("Bola Ade", ["not", "a", "dispute"])


# --- the service -------------------------------------------------------------


class FakeJob:
    def __init__(self, client_id, provider_id, status="in_progress", **overrides):
        self.id = uuid4()
        self.client_id = client_id
        self.provider_id = provider_id
        self.title = "Fix leaking sink"
        self.price = 18000
        self.status = status
        for key, value in overrides.items():
            setattr(self, key, value)


class FakeRating:
    def __init__(self, ratee_id, score=5):
        self.id = uuid4()
        self.ratee_id = ratee_id
        self.score = score


class FakeDispute:
    def __init__(self, client_id, provider_id, status="RESOLVED"):
        self.id = uuid4()
        self.client_id = client_id
        self.provider_id = provider_id
        self.status = status


def _user(display_name, user_id=None):
    return SimpleNamespace(id=user_id or uuid4(), display_name=display_name)


def _enable(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)


def _disable(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", False)


def _service(monkeypatch, gateway, names):
    """Build the service with the row lookups replaced by fixed values."""

    def lookup(name, value):
        async def fake(db, row_id):
            return value

        monkeypatch.setattr(event_module, name, fake)

    users = {}

    async def fake_user(db, user_id):
        return users.get(user_id)

    monkeypatch.setattr(event_module, "get_user_by_id", fake_user)
    for user_id, display_name in names.items():
        users[user_id] = _user(display_name, user_id)
    return lookup, EventFactService(
        db=object(), memory=FactMemoryService(gateway=gateway)
    )


async def test_a_job_event_stores_one_sentence_per_side(monkeypatch):
    _enable(monkeypatch)
    job = FakeJob(CLIENT, PROVIDER, status="completed")
    gateway = FakeGateway()
    lookup, service = _service(monkeypatch, gateway, {CLIENT: "Bola Ade", PROVIDER: "Kemi Bello"})
    lookup("get_job_by_id", job)

    stored = await service.store_job_event(job.id)

    assert stored == [
        "Bola Ade completed Fix leaking sink as a client at 18000 naira.",
        "Kemi Bello completed Fix leaking sink as a provider at 18000 naira.",
    ]
    assert [call["namespace"] for call in gateway.calls] == [
        f"{PREFIX}-{CLIENT}",
        f"{PREFIX}-{PROVIDER}",
    ]


async def test_a_job_event_for_an_open_job_does_not_claim_a_completion(monkeypatch):
    _enable(monkeypatch)
    job = FakeJob(CLIENT, None, status="open")
    gateway = FakeGateway()
    lookup, service = _service(monkeypatch, gateway, {CLIENT: "Bola Ade"})
    lookup("get_job_by_id", job)

    stored = await service.store_job_event(job.id)

    assert stored == ["Bola Ade posted a job for Fix leaking sink at 18000 naira."]


async def test_a_rating_event_stores_one_sentence_for_the_ratee(monkeypatch):
    _enable(monkeypatch)
    rating = FakeRating(PROVIDER, score=4)
    gateway = FakeGateway()
    lookup, service = _service(monkeypatch, gateway, {PROVIDER: "Kemi Bello"})
    lookup("get_rating_by_id", rating)

    stored = await service.store_rating_event(rating.id)

    assert stored == ["Kemi Bello received a 4 star rating."]
    assert [call["namespace"] for call in gateway.calls] == [f"{PREFIX}-{PROVIDER}"]


async def test_a_resolved_dispute_stores_a_sentence_for_both_sides(monkeypatch):
    _enable(monkeypatch)
    dispute = FakeDispute(CLIENT, PROVIDER)
    gateway = FakeGateway()
    lookup, service = _service(monkeypatch, gateway, {CLIENT: "Bola Ade", PROVIDER: "Kemi Bello"})
    lookup("get_dispute_by_id", dispute)

    stored = await service.store_dispute_event(dispute.id)

    assert stored == [
        "Bola Ade had a dispute resolved.",
        "Kemi Bello had a dispute resolved.",
    ]


async def test_an_open_dispute_stores_nothing(monkeypatch):
    _enable(monkeypatch)
    dispute = FakeDispute(CLIENT, PROVIDER, status="OPEN")
    gateway = FakeGateway()
    lookup, service = _service(monkeypatch, gateway, {CLIENT: "Bola Ade", PROVIDER: "Kemi Bello"})
    lookup("get_dispute_by_id", dispute)

    assert await service.store_dispute_event(dispute.id) == []
    assert gateway.calls == []


async def test_the_flag_off_reads_nothing_and_writes_nothing(monkeypatch):
    _disable(monkeypatch)

    def exploding_lookup(db, row_id):
        raise AssertionError("a lookup must not run when the flag is off")

    monkeypatch.setattr(event_module, "get_job_by_id", exploding_lookup)
    gateway = FakeGateway()
    service = EventFactService(db=object(), memory=FactMemoryService(gateway=gateway))

    assert await service.store_job_event(uuid4()) == []
    assert await service.store_from_result({"job_id": str(uuid4())}) == []
    assert gateway.calls == []


async def test_a_missing_row_writes_nothing(monkeypatch):
    _enable(monkeypatch)
    gateway = FakeGateway()
    lookup, service = _service(monkeypatch, gateway, {})
    lookup("get_job_by_id", None)

    assert await service.store_job_event(uuid4()) == []
    assert gateway.calls == []


async def test_a_missing_user_writes_nothing(monkeypatch):
    _enable(monkeypatch)
    job = FakeJob(CLIENT, PROVIDER)
    gateway = FakeGateway()
    lookup, service = _service(monkeypatch, gateway, {})
    lookup("get_job_by_id", job)

    assert await service.store_job_event(job.id) == []
    assert gateway.calls == []


async def test_a_relayer_failure_is_swallowed(monkeypatch):
    _enable(monkeypatch)
    job = FakeJob(CLIENT, None)
    gateway = FakeGateway(fail=True)
    lookup, service = _service(monkeypatch, gateway, {CLIENT: "Bola Ade"})
    lookup("get_job_by_id", job)

    # The agent loop must not fail because the search index is unavailable.
    assert await service.store_job_event(job.id) == []
    assert len(gateway.calls) == 1


async def test_the_same_event_twice_carries_the_same_idempotency_key(monkeypatch):
    _enable(monkeypatch)
    job = FakeJob(CLIENT, None)
    gateway = FakeGateway()
    lookup, service = _service(monkeypatch, gateway, {CLIENT: "Bola Ade"})
    lookup("get_job_by_id", job)

    await service.store_job_event(job.id)
    await service.store_job_event(job.id)

    keys = [call["idempotency_key"] for call in gateway.calls]
    assert len(keys) == 2
    assert keys[0] == keys[1]


async def test_a_result_without_marketplace_ids_writes_nothing(monkeypatch):
    _enable(monkeypatch)
    gateway = FakeGateway()
    service = EventFactService(db=object(), memory=FactMemoryService(gateway=gateway))

    assert await service.store_from_result({"page": "home", "message": "Done"}) == []
    assert await service.store_from_result(None) == []
    assert await service.store_from_result("not a result") == []
    assert gateway.calls == []


async def test_a_result_with_a_job_id_stores_that_job(monkeypatch):
    _enable(monkeypatch)
    job = FakeJob(CLIENT, None, status="open")
    gateway = FakeGateway()
    lookup, service = _service(monkeypatch, gateway, {CLIENT: "Bola Ade"})
    lookup("get_job_by_id", job)

    stored = await service.store_from_result({"created": True, "job_id": str(job.id)})

    assert stored == ["Bola Ade posted a job for Fix leaking sink at 18000 naira."]


async def test_a_result_with_every_id_stores_each_event(monkeypatch):
    _enable(monkeypatch)
    job = FakeJob(CLIENT, None, status="open")
    rating = FakeRating(CLIENT, score=5)
    dispute = FakeDispute(CLIENT, PROVIDER)
    gateway = FakeGateway()
    lookup, service = _service(
        monkeypatch, gateway, {CLIENT: "Bola Ade", PROVIDER: "Kemi Bello"}
    )
    lookup("get_job_by_id", job)
    lookup("get_rating_by_id", rating)
    lookup("get_dispute_by_id", dispute)

    stored = await service.store_from_result(
        {
            "job_id": str(job.id),
            "rating_id": str(rating.id),
            "dispute_id": str(dispute.id),
        }
    )

    assert stored == [
        "Bola Ade posted a job for Fix leaking sink at 18000 naira.",
        "Bola Ade received a 5 star rating.",
        "Bola Ade had a dispute resolved.",
        "Kemi Bello had a dispute resolved.",
    ]


async def test_a_result_with_a_bad_id_is_ignored(monkeypatch):
    _enable(monkeypatch)
    gateway = FakeGateway()
    service = EventFactService(db=object(), memory=FactMemoryService(gateway=gateway))

    assert await service.store_from_result({"job_id": "not-a-uuid"}) == []
    assert gateway.calls == []
