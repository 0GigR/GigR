"""Unit tests for the namespace-level Forget (memwal 0.2.2) and its endpoint.

No database, no relayer and no network: the SDK client and the gateway are fakes
that record what they were asked to delete, and the endpoint is mounted with a
stand-in for the authenticated user.

Three properties are covered here, because each one is a way this feature could
hurt a user:

* the delete is never repeated blind. A write whose outcome is unknown is
  verified by reading the namespace first, exactly as the fact writer does;
* a failure is an answer, never an exception. The page and the chat turn must
  not break because the relayer did;
* the endpoint deletes the caller's namespace and only that one, and it is not
  reachable at all with the feature off.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.api.v1.endpoints import ai as ai_endpoints
from app.core.config import settings
from app.core.dependencies import get_current_user, get_db
from app.core.errors import DependencyUnavailableError
from app.core.gateways.walrus_memory_gateway import (
    FORGET_VERIFY_LIMIT,
    ForgottenNamespace,
    RecalledMemory,
    WalrusMemoryGateway,
)
from app.core.memory_namespace import memory_namespace
from app.core.resilience import Boundary, ResiliencePolicy, StructuredLogMetricSink
from app.services.agent_memory_service import AgentMemoryService, NamespaceForget

PRIVATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
ACCOUNT_ID = "0xaccount"
NAMESPACE = "gigr-user-7"


def make_boundary(timeout: float = 1.0, attempts: int = 1) -> Boundary:
    return Boundary(
        ResiliencePolicy(
            dependency="walrus-memory",
            timeout_seconds=timeout,
            failure_threshold=5,
            reset_timeout_seconds=60.0,
            max_attempts=attempts,
            max_concurrency=2,
        ),
        StructuredLogMetricSink("walrus-memory-test"),
    )


def recalled(text: str) -> RecalledMemory:
    return RecalledMemory(text=text, score=None, created_at=None)


class ForgetSdk:
    """The subset of the memwal client the gateway calls for a namespace wipe."""

    def __init__(
        self,
        *,
        forget_failures: int = 0,
        recall_failures: int = 0,
        list_failures: int = 0,
        memories: tuple[RecalledMemory, ...] = (),
        memory_count: int | None = 0,
        deleted: int = 4,
    ) -> None:
        self.forget_failures = forget_failures
        self.recall_failures = recall_failures
        self.list_failures = list_failures
        self.memories = memories
        self.memory_count = memory_count
        self.deleted = deleted
        self.forget_calls: list[str] = []
        self.recall_calls: list[dict] = []

    async def forget(self, namespace=None):
        self.forget_calls.append(namespace)
        if self.forget_failures:
            self.forget_failures -= 1
            raise RuntimeError("relayer returned 503")
        return SimpleNamespace(namespace=namespace, deleted=self.deleted, owner=ACCOUNT_ID)

    async def recall(self, query, limit=10, namespace=None, max_distance=None):
        self.recall_calls.append({"query": query, "limit": limit, "namespace": namespace})
        if self.recall_failures:
            self.recall_failures -= 1
            raise RuntimeError("recall unavailable")
        return SimpleNamespace(results=list(self.memories), total=len(self.memories))

    async def list_namespaces(self, cursor=None, limit=None):
        if self.list_failures:
            self.list_failures -= 1
            raise RuntimeError("namespace listing unavailable")
        summaries = []
        if self.memory_count is not None:
            summaries.append(
                SimpleNamespace(name=NAMESPACE, memory_count=self.memory_count)
            )
        return SimpleNamespace(namespaces=summaries)


def make_gateway(client, boundary: Boundary | None = None) -> WalrusMemoryGateway:
    return WalrusMemoryGateway(
        boundary=boundary or make_boundary(),
        private_key=PRIVATE_KEY,
        account_id=ACCOUNT_ID,
        server_url="https://relayer.memory.walrus.xyz",
        client=client,
    )


# -- Gateway: the write, and the verification before any repeat ---------------


async def test_forget_deletes_the_namespace_and_returns_its_row_count():
    sdk = ForgetSdk(deleted=12)

    result = await make_gateway(sdk).forget(NAMESPACE)

    assert result == ForgottenNamespace(namespace=NAMESPACE, deleted=12, verified=False)
    assert sdk.forget_calls == [NAMESPACE]
    # A delete that answered is not second-guessed with extra reads.
    assert sdk.recall_calls == []


async def test_forget_requires_a_namespace():
    """An empty namespace would be the client's default namespace, not the user's."""
    sdk = ForgetSdk()

    with pytest.raises(ValueError):
        await make_gateway(sdk).forget("   ")

    assert sdk.forget_calls == []


async def test_forget_failure_on_an_empty_namespace_is_not_repeated():
    """The error may have been the relayer's answer after it deleted the rows.

    Both reads say there is nothing left, so the delete is treated as applied.
    Asking again would be harmless but would spend another relayer call and
    would still not add a row count this account never got.
    """
    sdk = ForgetSdk(forget_failures=1, memories=(), memory_count=0)

    result = await make_gateway(sdk).forget(NAMESPACE)

    assert result == ForgottenNamespace(namespace=NAMESPACE, deleted=None, verified=True)
    assert sdk.forget_calls == [NAMESPACE]
    assert len(sdk.recall_calls) == 1
    assert sdk.recall_calls[0]["namespace"] == NAMESPACE
    assert sdk.recall_calls[0]["limit"] == FORGET_VERIFY_LIMIT


async def test_forget_failure_with_rows_still_present_is_deleted_once_more():
    """The verification is what earns the retry: a row came back, so the delete
    did not land. Exactly one repeat follows, never a loop."""
    sdk = ForgetSdk(forget_failures=1, memories=(recalled("Kosi lives in Yaba"),))

    result = await make_gateway(sdk).forget(NAMESPACE)

    assert result == ForgottenNamespace(namespace=NAMESPACE, deleted=4, verified=False)
    assert sdk.forget_calls == [NAMESPACE, NAMESPACE]


async def test_forget_failure_that_cannot_be_verified_is_not_repeated():
    """No evidence is not evidence of absence: the call fails, nothing is deleted
    a second time."""
    sdk = ForgetSdk(forget_failures=1, recall_failures=1)

    with pytest.raises(DependencyUnavailableError):
        await make_gateway(sdk).forget(NAMESPACE)

    assert sdk.forget_calls == [NAMESPACE]


async def test_forget_failure_with_an_unavailable_count_is_not_repeated():
    """A recall that comes back empty is not enough on its own.

    The listing is the stronger signal: when it cannot be read, the namespace is
    not provably empty, so the delete must not be claimed nor repeated.
    """
    sdk = ForgetSdk(forget_failures=1, memories=(), memory_count=0, list_failures=1)

    with pytest.raises(DependencyUnavailableError):
        await make_gateway(sdk).forget(NAMESPACE)

    assert sdk.forget_calls == [NAMESPACE]


# -- Service: an answer, never an exception -----------------------------------


class RecordingGateway:
    """The gateway methods the memory service is allowed to use."""

    configured = True

    def __init__(self, result: ForgottenNamespace | None = None, failure=None) -> None:
        self.result = result or ForgottenNamespace(
            namespace=NAMESPACE, deleted=3, verified=False
        )
        self.failure = failure
        self.forget_calls: list[str] = []

    async def forget(self, namespace):
        self.forget_calls.append(namespace)
        if self.failure is not None:
            raise self.failure
        return self.result

    async def recall(self, query, namespace, limit, **options):
        raise AssertionError("the service must not recall while forgetting")

    async def remember(self, text, namespace, idempotency_key=None):
        raise AssertionError("the service must not write while forgetting")


async def test_service_forget_namespace_deletes_the_callers_namespace(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)
    gateway = RecordingGateway()
    user_id = uuid.uuid4()

    result = await AgentMemoryService(db=None, gateway=gateway).forget_namespace(
        user_id
    )

    assert result == NamespaceForget(ok=True, reason="ok", deleted=3)
    assert gateway.forget_calls == [memory_namespace(user_id)]


async def test_service_forget_namespace_is_disabled_with_the_flag_off(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", False)
    gateway = RecordingGateway()

    result = await AgentMemoryService(db=None, gateway=gateway).forget_namespace(
        uuid.uuid4()
    )

    assert result == NamespaceForget(ok=False, reason="feature_disabled", deleted=None)
    assert gateway.forget_calls == []


async def test_service_forget_namespace_reports_an_unconfigured_gateway(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)

    result = await AgentMemoryService(db=None, gateway=None).forget_namespace(
        uuid.uuid4()
    )

    assert result == NamespaceForget(ok=False, reason="not_configured", deleted=None)


async def test_service_forget_namespace_never_raises_when_the_gateway_fails(monkeypatch):
    """Every gateway failure becomes a typed answer the page can render.

    This is the promise that a relayer outage cannot turn a memory page or a
    chat turn into a 500.
    """
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)
    failure = DependencyUnavailableError("walrus-memory", "timeout after 8.0s")
    gateway = RecordingGateway(failure=failure)

    result = await AgentMemoryService(db=None, gateway=gateway).forget_namespace(
        uuid.uuid4()
    )

    assert result.ok is False
    assert result.deleted is None
    assert result.reason == "relayer_timeout"
    assert gateway.forget_calls != []


@pytest.mark.parametrize(
    ("message", "reason"),
    [
        ("rate_limited: 429 Too Many Requests", "relayer_busy"),
        ("timeout after 8.0s", "relayer_timeout"),
        ("connection reset by peer", "relayer_unavailable"),
    ],
)
async def test_service_forget_namespace_names_the_failure(
    monkeypatch, message, reason
):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)
    gateway = RecordingGateway(failure=RuntimeError(message))

    result = await AgentMemoryService(db=None, gateway=gateway).forget_namespace(
        uuid.uuid4()
    )

    assert result.ok is False
    assert result.reason == reason


# -- Endpoint: authenticated, own namespace, behind the flag ------------------


def mount_router() -> FastAPI:
    app = FastAPI()
    app.include_router(ai_endpoints.router, prefix="/api/v1")
    return app


async def call_delete(app: FastAPI, path: str = "/api/v1/ai/memory", **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        return await client.request("DELETE", path, **kwargs)


async def test_delete_memory_requires_authentication():
    """An unauthenticated caller must never reach the delete.

    The route is mounted alone so no database session is needed: auth rejects
    the request before a user or a namespace is resolved.
    """
    app = mount_router()

    response = await call_delete(app)

    assert response.status_code == 401
    assert "deleted" not in response.text


async def test_delete_memory_is_not_exposed_with_the_flag_off(monkeypatch):
    """With the feature off the route answers 404 and deletes nothing."""
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", False)
    gateway = RecordingGateway()
    monkeypatch.setattr(
        ai_endpoints,
        "build_agent_memory_service",
        lambda db: AgentMemoryService(db=None, gateway=gateway),
    )
    app = mount_router()
    user = SimpleNamespace(id=uuid.uuid4())
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: None

    response = await call_delete(app)

    assert response.status_code == 404
    assert gateway.forget_calls == []


async def test_delete_memory_wipes_the_authenticated_callers_namespace(monkeypatch):
    """The decisive endpoint test: another user cannot be named.

    A namespace in the query string and another in the body are both ignored,
    because the namespace comes from the authenticated principal. The gateway is
    the real one's interface, so this proves the value that reaches the relayer.
    """
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)
    user = SimpleNamespace(id=uuid.uuid4())
    other = uuid.uuid4()
    gateway = RecordingGateway()
    monkeypatch.setattr(
        ai_endpoints,
        "build_agent_memory_service",
        lambda db: AgentMemoryService(db=None, gateway=gateway),
    )
    app = mount_router()
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: None

    response = await call_delete(
        app,
        params={"namespace": memory_namespace(other)},
        json={"namespace": memory_namespace(other)},
    )

    assert response.status_code == 200
    assert gateway.forget_calls == [memory_namespace(user.id)]
    assert memory_namespace(other) not in gateway.forget_calls
    assert response.json() == {
        "status": "ok",
        "ok": True,
        "deleted": 3,
        "reason": "ok",
    }


async def test_delete_memory_answers_with_the_reason_when_the_wipe_fails(monkeypatch):
    """A failed wipe is a 200 with ok false, not a 500.

    The page reads ok and reason; raising here is what would break it.
    """
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)
    gateway = RecordingGateway(failure=RuntimeError("rate_limited: 429"))
    monkeypatch.setattr(
        ai_endpoints,
        "build_agent_memory_service",
        lambda db: AgentMemoryService(db=None, gateway=gateway),
    )
    app = mount_router()
    user = SimpleNamespace(id=uuid.uuid4())
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: None

    response = await call_delete(app)

    assert response.status_code == 200
    assert response.json() == {
        "status": "failed",
        "ok": False,
        "deleted": None,
        "reason": "relayer_busy",
    }
