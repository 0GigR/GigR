"""Unit tests for the read-only Walrus Memory review and its endpoint.

No database and no network: the gateway is a recording fake and the endpoint is
called with a stub service. What is exercised is the review's own decisions: the
query, namespace and bound it sends, the deduplication it applies, every state
that must degrade instead of raising, and the exact response the page consumes.

The regression these tests exist for: /dashboard/memory used to show four
placeholder cards while the relayer held real sentences. A review that returned
nothing, raised on an outage, or shaped a body the page cannot read would put
that page back in the same place.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import httpx
from fastapi import FastAPI

from app.api.v1.endpoints import ai as ai_endpoints
from app.core import container
from app.core.config import settings
from app.core.dependencies import get_current_user, get_db
from app.core.gateways.walrus_memory_gateway import RecalledMemory
from app.services.agent_memory_service import (
    MEMORY_REVIEW_LIMIT,
    MEMORY_REVIEW_QUERY,
    MEMORY_REVIEW_TIMEOUT_SECONDS,
    AgentMemoryService,
    RecalledFacts,
)


def recalled(text: str) -> RecalledMemory:
    """One stored entry, shaped as the gateway returns it."""
    return RecalledMemory(text=text, score=None, created_at=None)


class RecordingGateway:
    """The two gateway methods AgentMemoryService is allowed to use."""

    configured = True

    def __init__(
        self,
        memories: tuple[RecalledMemory, ...] = (),
        fail_recall: bool = False,
        failure: BaseException | None = None,
    ) -> None:
        self.memories = memories
        self.fail_recall = fail_recall
        self.failure = failure
        self.recall_calls: list[dict] = []
        self.remember_calls: list[dict] = []

    async def recall(self, query, namespace, limit, **options):
        self.recall_calls.append(
            {
                "query": query,
                "namespace": namespace,
                "limit": limit,
                **options,
            }
        )
        if self.failure is not None:
            raise self.failure
        if self.fail_recall:
            raise RuntimeError("recall failed")
        return self.memories

    async def remember(self, text, namespace, idempotency_key=None):
        self.remember_calls.append(
            {"text": text, "namespace": namespace, "idempotency_key": idempotency_key}
        )
        return "job-1"


async def _review(monkeypatch, gateway, *, query=None, user_id=None) -> RecalledFacts:
    """Run one review against a fake gateway, with the flag on."""
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)
    service = AgentMemoryService(db=None, gateway=gateway)
    return await service.review_facts(user_id or uuid.uuid4(), query=query)


async def test_review_returns_walrus_sentences_deduplicated_trimmed_and_read_only(
    monkeypatch,
):
    """The page must list what the relayer holds, once each, with no blank line.

    A relayer that stored one fact twice must not produce two rows, a blank text
    is not a memory, and a review must never write: the gateway's remember is
    untouched.
    """
    duplicate = "Kosi hired a plumber for 15000 naira"
    gateway = RecordingGateway(
        (
            recalled(duplicate),
            recalled("  Kosi lives in Yaba  "),
            recalled(duplicate),
            recalled("   "),
        )
    )

    result = await _review(monkeypatch, gateway)

    assert result.facts == (duplicate, "Kosi lives in Yaba")
    assert result.count == 2
    assert result.source == "walrus"
    assert result.reason == "ok"
    assert gateway.remember_calls == []


async def test_review_asks_the_users_namespace_with_the_bounded_broad_default(
    monkeypatch,
):
    """With no query the review must send its broad default and its own bound.

    The namespace is the one the fact writer uses, so the page reads the facts
    that were actually written for this user. The bound is the review limit, not
    the five-entry prompt recall: a page that showed five rows while the account
    held thirty-four would still be lying.
    """
    monkeypatch.setattr(settings, "MEMWAL_NAMESPACE_PREFIX", "review-user")
    user_id = uuid.uuid4()
    gateway = RecordingGateway()

    await _review(monkeypatch, gateway, user_id=user_id)

    assert gateway.recall_calls == [
        {
            "query": MEMORY_REVIEW_QUERY,
            "namespace": f"review-user-{user_id}",
            "limit": 50,
            "timeout_seconds": 20.0,
            "retry": False,
        }
    ]
    assert MEMORY_REVIEW_LIMIT == 50
    assert MEMORY_REVIEW_TIMEOUT_SECONDS == 20.0
    assert MEMORY_REVIEW_QUERY.strip() != ""


async def test_review_sends_the_callers_query_and_falls_back_when_it_is_blank(
    monkeypatch,
):
    """The query parameter selects what is read; whitespace is the same as none.

    A blank value must not reach the gateway: the real gateway raises on an
    empty query, which would turn a careless request into a failed page.
    """
    gateway = RecordingGateway()

    await _review(monkeypatch, gateway, query="plumber in Yaba")
    await _review(monkeypatch, gateway, query="   ")

    assert [call["query"] for call in gateway.recall_calls] == [
        "plumber in Yaba",
        MEMORY_REVIEW_QUERY,
    ]


async def test_review_is_inert_when_the_feature_flag_is_off(monkeypatch):
    """With the flag off the review must answer an empty disabled state.

    It must also not touch the relayer: an inert flag is inert, not a quiet
    network call.
    """
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", False)
    gateway = RecordingGateway((recalled("a fact that must not be read"),))

    result = await AgentMemoryService(db=None, gateway=gateway).review_facts(
        uuid.uuid4()
    )

    assert result == RecalledFacts(reason="feature_disabled")
    assert result.facts == ()
    assert result.source == "none"
    assert gateway.recall_calls == []


async def test_review_reports_not_configured_instead_of_raising(monkeypatch):
    """A gateway without credentials is a calm reason, not a 500.

    The page must be able to say memory is not set up without asking the
    relayer, which cannot answer at all in this state.
    """
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)
    gateway = RecordingGateway((recalled("a fact that must not be read"),))
    gateway.configured = False

    result = await AgentMemoryService(db=None, gateway=gateway).review_facts(
        uuid.uuid4()
    )

    assert result.facts == ()
    assert result.source == "none"
    assert result.reason == "not_configured"
    assert gateway.recall_calls == []


async def test_review_returns_empty_and_a_reason_when_the_relayer_fails(monkeypatch):
    """A relayer outage must never reach the caller.

    A read that fails is reported as unavailable so the page shows a calm note
    and a retry. Raising here is what would turn a relayer outage into a broken
    memory page.
    """
    gateway = RecordingGateway(fail_recall=True)

    result = await _review(monkeypatch, gateway)

    assert result.facts == ()
    assert result.count == 0
    assert result.source == "none"
    assert result.reason == "relayer_unavailable"


async def test_review_reports_a_rate_limited_relayer_as_busy(monkeypatch):
    """A spent request budget is not an outage and must not read like one.

    The relayer answers 429 with no retry, so the page must ask the reader to
    wait a minute rather than show the same note as an unreachable service. The
    boundary carries the reason in the typed error's message.
    """
    gateway = RecordingGateway(
        failure=RuntimeError("rate_limited: 429 Too Many Requests")
    )

    result = await _review(monkeypatch, gateway)

    assert result.facts == ()
    assert result.reason == "relayer_busy"
    assert gateway.recall_calls[0]["retry"] is False


async def test_review_reports_an_expired_deadline_as_a_timeout(monkeypatch):
    """A recall that ran out of time is reported as slow, not as a failure.

    The page can tell the reader that the recall took too long, which is true
    even when the relayer is healthy and the entries are safe.
    """
    gateway = RecordingGateway(failure=RuntimeError("timeout after 20.0s"))

    result = await _review(monkeypatch, gateway)

    assert result.facts == ()
    assert result.reason == "relayer_timeout"


class StubMemoryService:
    """The one service method the endpoint calls, recorded."""

    def __init__(self, result: RecalledFacts) -> None:
        self.result = result
        self.calls: list[dict] = []

    async def review_facts(self, user_id, query=None):
        self.calls.append({"user_id": user_id, "query": query})
        return self.result


async def test_facts_endpoint_returns_the_documented_shape(monkeypatch):
    """The page consumes facts, count, source and reason, and nothing else.

    The entries are objects with a text field, the count is the number of
    entries, and the query parameter reaches the service.
    """
    service = StubMemoryService(
        RecalledFacts(
            facts=("Kosi lives in Yaba", "Kosi paid 15000 naira"),
            source="walrus",
            reason="ok",
        )
    )
    monkeypatch.setattr(
        ai_endpoints, "build_agent_memory_service", lambda db: service
    )
    user = SimpleNamespace(id=uuid.uuid4())

    body = await ai_endpoints.list_memory_facts_endpoint(
        query="plumber", current_user=user, db=None
    )

    assert body == {
        "facts": [
            {"text": "Kosi lives in Yaba"},
            {"text": "Kosi paid 15000 naira"},
        ],
        "count": 2,
        "source": "walrus",
        "reason": "ok",
    }
    assert service.calls == [{"user_id": user.id, "query": "plumber"}]


async def test_facts_endpoint_degrades_calmly_when_the_flag_is_off(monkeypatch):
    """With the flag off the page must receive a 200, an empty list and a reason.

    This goes through the mounted router, not the function body, so it also
    proves the shape the client normalises. An error status here would make the
    page show a failure instead of its calm disabled state.
    """
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", False)
    gateway = RecordingGateway((recalled("a fact that must not be read"),))
    monkeypatch.setattr(container, "agent_memory_gateway", gateway)

    app = FastAPI()
    app.include_router(ai_endpoints.router, prefix="/api/v1")
    app.dependency_overrides[get_current_user] = lambda: SimpleNamespace(id=uuid.uuid4())
    app.dependency_overrides[get_db] = lambda: None
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        response = await client.get("/api/v1/ai/memory/facts")

    assert response.status_code == 200
    assert response.json() == {
        "facts": [],
        "count": 0,
        "source": "none",
        "reason": "feature_disabled",
    }
    assert gateway.recall_calls == []


async def test_facts_endpoint_requires_authentication():
    """An unauthenticated caller must never reach the memory service.

    The route is mounted alone so no database session is needed: the auth
    dependency rejects the request before a user is looked up. The rejection is
    a failure status, never a 200 with an empty list, because an empty 200
    would claim the user has no memory.
    """
    app = FastAPI()
    app.include_router(ai_endpoints.router, prefix="/api/v1")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        response = await client.get("/api/v1/ai/memory/facts")

    assert response.status_code == 401
    assert "facts" not in response.text
