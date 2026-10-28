"""Unit tests for the Walrus Memory gateway.

No database and no network: the SDK client is replaced by a fake that implements
the same three async methods the gateway uses. The SDK's own shapes are covered
by the optional test at the bottom, which only runs when memwal is installed.
"""

from __future__ import annotations

import asyncio
import logging
import types

import pytest

from app.core.errors import DependencyUnavailableError
from app.core.gateways.walrus_memory_gateway import WalrusMemoryGateway
from app.core.resilience import Boundary, ResiliencePolicy, StructuredLogMetricSink

PRIVATE_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
ACCOUNT_ID = "0xaccount"


def make_boundary(timeout: float = 1.0, attempts: int = 1, threshold: int = 5) -> Boundary:
    return Boundary(
        ResiliencePolicy(
            dependency="walrus-memory",
            timeout_seconds=timeout,
            failure_threshold=threshold,
            reset_timeout_seconds=60.0,
            max_attempts=attempts,
            max_concurrency=2,
        ),
        StructuredLogMetricSink("walrus-memory-test"),
    )


class FakeSdk:
    """The subset of the memwal client the gateway calls."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self.remember_result = types.SimpleNamespace(job_id="job-42", status="pending")
        self.recall_result = types.SimpleNamespace(
            results=[
                types.SimpleNamespace(
                    blob_id="b1",
                    text="first",
                    distance=0.1,
                    score=0.93,
                    created_at="2026-01-05T10:00:00Z",
                ),
                types.SimpleNamespace(
                    blob_id="b2",
                    text="second",
                    distance=0.2,
                    score=0.81,
                    created_at="2025-12-31T23:00:00Z",
                ),
            ],
            total=2,
        )
        self.namespaces_result = types.SimpleNamespace(
            namespaces=[
                types.SimpleNamespace(name="gigr-user-1", memory_count=2),
                types.SimpleNamespace(name="gigr-user-2", memory_count=1),
            ]
        )
        self.remember_calls: list[dict] = []
        self.recall_calls: list[dict] = []

    async def remember(self, text, namespace=None, idempotency_key=None):
        self.calls.append(("remember", text, namespace, idempotency_key))
        self.remember_calls.append(
            {"text": text, "namespace": namespace, "idempotency_key": idempotency_key}
        )
        return self.remember_result

    async def recall(self, query, limit=10, namespace=None, max_distance=None):
        self.calls.append(("recall", query, limit, namespace))
        self.recall_calls.append({"query": query, "limit": limit, "namespace": namespace})
        return self.recall_result

    async def list_namespaces(self, cursor=None, limit=None):
        self.calls.append(("list_namespaces",))
        return self.namespaces_result


class RaisingSdk:
    """A client whose every method fails, as a relayer outage would."""

    def __init__(self, exc: BaseException | None = None) -> None:
        self.exc = exc or RuntimeError("relayer unreachable")
        self.calls = 0

    async def remember(self, text, namespace=None, idempotency_key=None):
        self.calls += 1
        raise self.exc

    async def recall(self, query, limit=10, namespace=None, max_distance=None):
        self.calls += 1
        raise self.exc

    async def list_namespaces(self, cursor=None, limit=None):
        self.calls += 1
        raise self.exc


class SlowSdk(FakeSdk):
    async def recall(self, query, limit=10, namespace=None, max_distance=None):
        await asyncio.sleep(5)
        return await super().recall(query, limit, namespace, max_distance)


class DelayedSdk(FakeSdk):
    """A recall that outlasts the dependency policy but not the override."""

    async def recall(self, query, limit=10, namespace=None, max_distance=None):
        await asyncio.sleep(0.2)
        return await super().recall(query, limit, namespace, max_distance)


def make_gateway(client, boundary: Boundary | None = None) -> WalrusMemoryGateway:
    return WalrusMemoryGateway(
        boundary=boundary or make_boundary(),
        private_key=PRIVATE_KEY,
        account_id=ACCOUNT_ID,
        server_url="https://relayer.memory.walrus.xyz",
        client=client,
    )


async def test_remember_returns_job_id_and_forwards_idempotency_key():
    sdk = FakeSdk()
    job_id = await make_gateway(sdk).remember(
        "last_search: \"plumber\"", "gigr-user-7", idempotency_key="idem-1"
    )

    assert job_id == "job-42"
    assert sdk.remember_calls == [
        {
            "text": "last_search: \"plumber\"",
            "namespace": "gigr-user-7",
            "idempotency_key": "idem-1",
        }
    ]


async def test_recall_returns_text_score_and_created_at_in_order():
    """A recall must not throw away the metadata memwal 0.2.x returns: the
    timestamp is what lets a reader tell two contradicting facts apart by age."""
    sdk = FakeSdk()
    memories = await make_gateway(sdk).recall("leaking tap", "gigr-user-7", 5)

    assert [(memory.text, memory.score, memory.created_at) for memory in memories] == [
        ("first", 0.93, "2026-01-05T10:00:00Z"),
        ("second", 0.81, "2025-12-31T23:00:00Z"),
    ]
    assert sdk.recall_calls == [
        {"query": "leaking tap", "limit": 5, "namespace": "gigr-user-7"}
    ]


async def test_list_namespaces_returns_names():
    sdk = FakeSdk()
    names = await make_gateway(sdk).list_namespaces()

    assert names == ("gigr-user-1", "gigr-user-2")


async def test_recall_timeout_raises_dependency_unavailable_and_stops_waiting():
    gateway = make_gateway(SlowSdk(), make_boundary(timeout=0.05))

    started = asyncio.get_running_loop().time()
    with pytest.raises(DependencyUnavailableError) as caught:
        await gateway.recall("leaking tap", "gigr-user-7", 5)
    elapsed = asyncio.get_running_loop().time() - started

    assert "walrus-memory" in str(caught.value)
    assert elapsed < 1.0


async def test_recall_can_use_a_longer_deadline_than_the_dependency_policy():
    """A page read that asks for dozens of entries needs more than the task budget.

    The override is per call and only the deadline changes: the breaker and the
    bulkhead stay the dependency's, which is why this still goes through one
    Boundary. Without the override the same call times out (the test above).
    """
    gateway = make_gateway(DelayedSdk(), make_boundary(timeout=0.05))

    memories = await gateway.recall(
        "what do you remember", "gigr-user-7", 50, timeout_seconds=0.5
    )

    assert [memory.text for memory in memories] == ["first", "second"]


async def test_recall_without_retry_calls_the_sdk_once():
    """One long attempt, not two: a retry would double what the page waits."""
    sdk = RaisingSdk()
    gateway = make_gateway(sdk, make_boundary(timeout=0.5, attempts=3))

    with pytest.raises(DependencyUnavailableError):
        await gateway.recall("query", "gigr-user-7", 50, retry=False)

    assert sdk.calls == 1


async def test_breaker_opens_after_threshold_and_stops_calling_the_sdk():
    sdk = RaisingSdk()
    gateway = make_gateway(sdk, make_boundary(timeout=0.5, threshold=2))

    for _ in range(2):
        with pytest.raises(DependencyUnavailableError):
            await gateway.recall("query", "gigr-user-7", 5)
    assert sdk.calls == 2

    # Open now: the caller still gets a typed failure, and the SDK is not hit.
    with pytest.raises(DependencyUnavailableError):
        await gateway.recall("query", "gigr-user-7", 5)
    assert sdk.calls == 2


async def test_a_failing_write_is_never_retried():
    sdk = RaisingSdk()
    gateway = make_gateway(sdk, make_boundary(timeout=0.5, attempts=3))

    with pytest.raises(DependencyUnavailableError):
        await gateway.remember("last_search: \"plumber\"", "gigr-user-7")

    assert sdk.calls == 1


async def test_gateway_repr_and_failure_logs_never_contain_the_private_key(caplog):
    caplog.set_level(logging.DEBUG)

    gateway = make_gateway(RaisingSdk(), make_boundary(timeout=0.5))
    assert PRIVATE_KEY not in repr(gateway)
    assert PRIVATE_KEY not in str(gateway)

    with pytest.raises(DependencyUnavailableError) as caught:
        await gateway.recall("query", "gigr-user-7", 5)

    assert PRIVATE_KEY not in str(caught.value)
    assert PRIVATE_KEY not in caplog.text


async def test_gateway_without_credentials_refuses_without_calling_the_sdk():
    sdk = FakeSdk()
    gateway = WalrusMemoryGateway(
        boundary=make_boundary(),
        private_key="",
        account_id="",
        server_url="https://relayer.memory.walrus.xyz",
        client=sdk,
    )

    assert gateway.configured is False
    with pytest.raises(DependencyUnavailableError):
        await gateway.remember("text", "gigr-user-7")
    assert sdk.calls == []


async def test_gateway_round_trips_through_the_installed_sdk_mock():
    """Proves the three methods match the real memwal API, not just our fake."""
    memwal = pytest.importorskip("memwal")
    client = memwal.MemWalMock.create(namespace="gigr-user-9")
    gateway = make_gateway(client)

    job_id = await gateway.remember(
        "last_search: \"plumber\"", "gigr-user-9", idempotency_key="idem-9"
    )
    assert isinstance(job_id, str) and job_id

    memories = await gateway.recall("plumber", "gigr-user-9", 5)
    assert [memory.text for memory in memories] == ['last_search: "plumber"']
    # The installed SDK really carries the two fields the gateway now keeps.
    assert memories[0].score is not None
    assert memories[0].created_at is not None

    assert (await gateway.list_namespaces()) == ("gigr-user-9",)


def test_installed_sdk_offers_the_namespace_level_forget_the_gateway_calls():
    """Proves the pin, not just our fake: memwal 0.2.1 had no delete at all.

    This is the conformance test for requirements' ``memwal>=0.2.2``. The
    gateway calls ``forget(namespace=...)``; 0.2.1 answers AttributeError, and
    0.2.2 answers with a ``ForgetResult``.

    The SDK's in-process mock is deliberately not used here: in 0.2.2
    ``MemWalMock.forget`` still takes a blob id, so the mock has not caught up
    with the real client. Asserting on the real class is what keeps this test
    honest.
    """
    import inspect

    memwal = pytest.importorskip("memwal")

    forget = inspect.signature(memwal.MemWal.forget)
    assert list(forget.parameters) == ["self", "namespace"]
    assert forget.parameters["namespace"].default is None

    alias = inspect.signature(memwal.MemWal.forget_namespace)
    assert alias.parameters["namespace"].default is None

    assert "ForgetResult" in dir(memwal)
