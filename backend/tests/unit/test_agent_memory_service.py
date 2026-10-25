"""Unit tests for the agent memory service's Walrus namespace prefix.

No database and no network. The service's two outbound methods are called
directly with a recording gateway, and the namespace they build is asserted.
This is the regression for a prefix that was a module constant: changing
MEMWAL_NAMESPACE_PREFIX in the environment had no effect on the namespace the
relayer received.
"""

from __future__ import annotations

import uuid

from app.core.config import Settings, settings
from app.services.agent_memory_service import AgentMemoryService


class RecordingGateway:
    """The two gateway methods the namespace tests touch."""

    configured = True

    def __init__(self, recall_texts: tuple[str, ...] = ()) -> None:
        self.recall_texts = recall_texts
        self.remember_calls: list[dict] = []
        self.recall_calls: list[dict] = []

    async def remember(self, text, namespace, idempotency_key=None):
        self.remember_calls.append(
            {"text": text, "namespace": namespace, "idempotency_key": idempotency_key}
        )
        return "job-1"

    async def recall(self, query, namespace, limit):
        self.recall_calls.append(
            {"query": query, "namespace": namespace, "limit": limit}
        )
        return self.recall_texts


def test_settings_read_the_namespace_prefix_from_the_environment(monkeypatch):
    """Startup must take the prefix from MEMWAL_NAMESPACE_PREFIX, not a literal."""
    monkeypatch.setenv("MEMWAL_NAMESPACE_PREFIX", "acme-user")

    assert Settings().MEMWAL_NAMESPACE_PREFIX == "acme-user"


def test_settings_default_namespace_prefix_keeps_existing_namespaces(monkeypatch):
    """With the variable unset the historical prefix must still be the default."""
    monkeypatch.delenv("MEMWAL_NAMESPACE_PREFIX", raising=False)

    assert Settings().MEMWAL_NAMESPACE_PREFIX == "gigr-user"


def test_blank_namespace_prefix_is_absorbed_instead_of_writing_a_malformed_one(
    monkeypatch,
):
    """A blank variable is a careless input, not a namespaceless deployment."""
    monkeypatch.setenv("MEMWAL_NAMESPACE_PREFIX", "   ")

    assert Settings().MEMWAL_NAMESPACE_PREFIX == "gigr-user"


async def test_env_namespace_prefix_reaches_the_gateway_for_reads_and_writes(
    monkeypatch,
):
    """The namespace the gateway receives must come from the environment."""
    monkeypatch.setenv("MEMWAL_NAMESPACE_PREFIX", "acme-user")
    startup = Settings()
    monkeypatch.setattr(
        settings, "MEMWAL_NAMESPACE_PREFIX", startup.MEMWAL_NAMESPACE_PREFIX
    )

    gateway = RecordingGateway(recall_texts=('last_search: "plumber"',))
    service = AgentMemoryService(db=None, gateway=gateway)
    user_id = uuid.uuid4()

    await service._mirror(user_id, {"last_search": "plumber"})
    await service._recall_texts(user_id, "fix a leak")

    expected = f"acme-user-{user_id}"
    assert [call["namespace"] for call in gateway.remember_calls] == [expected]
    assert [call["namespace"] for call in gateway.recall_calls] == [expected]
    assert gateway.remember_calls[0]["text"] == 'last_search: "plumber"'
