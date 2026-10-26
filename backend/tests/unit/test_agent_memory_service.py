"""Unit tests for the agent memory service: the namespace and the prompt date.

No database and no network. The crud layer is replaced with a fixed local
memory mapping and the gateway with a recording fake, so what is exercised is
the service's own two decisions: the namespace it builds, and the date it puts
next to each recalled fact before that fact reaches the prompt.

The namespace tests are the regression for a prefix that was a module constant:
changing MEMWAL_NAMESPACE_PREFIX in the environment had no effect on the
namespace the relayer received.
"""

from __future__ import annotations

import uuid

import pytest

from app.core.config import Settings, settings
from app.core.gateways.walrus_memory_gateway import RecalledMemory
from app.services import agent_memory_service as memory_module
from app.services.agent_guardrails import build_memory_hint
from app.services.agent_memory_service import AgentMemoryService


def recalled(
    text: str,
    *,
    score: float | None = None,
    created_at: object = None,
) -> RecalledMemory:
    """One recalled entry, shaped as the gateway returns it."""
    return RecalledMemory(text=text, score=score, created_at=created_at)


class RecordingGateway:
    """The two gateway methods the service uses."""

    configured = True

    def __init__(self, memories: tuple[RecalledMemory, ...] = ()) -> None:
        self.memories = memories
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
        return self.memories


async def _load(monkeypatch, gateway, local_memory):
    """Run the semantic load against a fixed local memory, without a database."""
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)

    async def fake_load_memory(db, user_id):
        return dict(local_memory)

    monkeypatch.setattr(memory_module, "load_memory", fake_load_memory)
    service = AgentMemoryService(db=None, gateway=gateway)
    return await service.load(uuid.uuid4(), query="fix a leak")


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

    gateway = RecordingGateway(memories=(recalled('last_search: "plumber"'),))
    service = AgentMemoryService(db=None, gateway=gateway)
    user_id = uuid.uuid4()

    await service._mirror(user_id, {"last_search": "plumber"})
    await service._recall_memories(user_id, "fix a leak")

    expected = f"acme-user-{user_id}"
    assert [call["namespace"] for call in gateway.remember_calls] == [expected]
    assert [call["namespace"] for call in gateway.recall_calls] == [expected]
    assert gateway.remember_calls[0]["text"] == 'last_search: "plumber"'


async def test_a_recalled_fact_reaches_the_prompt_with_its_date(monkeypatch):
    """The model must see when a recalled fact was written, so a contradiction
    can be settled by recency. The date is YYYY-MM-DD and sits after the value."""
    gateway = RecordingGateway(
        memories=(
            recalled(
                'last_search: "plumber"',
                score=0.93,
                created_at="2026-01-05T10:00:00Z",
            ),
        )
    )

    context = await _load(monkeypatch, gateway, {"last_search": "plumber"})

    assert context.source == "walrus"
    assert context.recall_log_line == "Searching memory: Recalled 1 memory from Walrus"
    # The raw entries stay as the JSONB store holds them.
    assert context.entries == {"last_search": "plumber"}
    # The prompt sees the dated value.
    assert context.prompt_entries == {"last_search": "plumber (2026-01-05)"}
    assert build_memory_hint(context.prompt_entries) == (
        "last_search: plumber (2026-01-05)"
    )


@pytest.mark.parametrize("created_at", [None, "", "   ", "not-a-date", 12345])
async def test_a_memory_without_a_usable_date_reaches_the_prompt_with_no_date(
    monkeypatch, created_at
):
    """A missing or unparseable timestamp must not become a placeholder, a guess
    or a crash: the fact is injected exactly as the JSONB store would inject it."""
    gateway = RecordingGateway(
        memories=(recalled('last_search: "plumber"', created_at=created_at),)
    )

    context = await _load(monkeypatch, gateway, {"last_search": "plumber"})

    assert context.entries == {"last_search": "plumber"}
    assert context.prompt_entries == {"last_search": "plumber"}
    assert build_memory_hint(context.prompt_entries) == "last_search: plumber"


async def test_the_newest_date_wins_when_the_same_fact_was_recalled_twice(
    monkeypatch,
):
    """Walrus is append-only, so one fact can come back several times. The prompt
    must carry the newest date, which is the one that settles a contradiction."""
    gateway = RecordingGateway(
        memories=(
            recalled(
                'usual_price_job: 12000',
                score=0.80,
                created_at="2025-03-01T09:00:00Z",
            ),
            recalled(
                'usual_price_job: 15000',
                score=0.91,
                created_at="2026-01-05T10:00:00Z",
            ),
        )
    )

    context = await _load(monkeypatch, gateway, {"usual_price_job": 15000})

    assert context.prompt_entries == {"usual_price_job": "15000 (2026-01-05)"}


async def test_duplicate_recalled_texts_collapse_before_the_prompt(monkeypatch):
    """The relayer is append-only: a write that reported a server error may still
    have been stored, so one fact comes back several times. Exact duplicates must
    collapse to the first occurrence before the prompt is built."""
    gateway = RecordingGateway(
        memories=(
            recalled('last_search: "plumber"', created_at="2026-01-05T10:00:00Z"),
            recalled('last_search: "plumber"', created_at="2026-01-05T10:00:00Z"),
            recalled('last_search: "plumber"', created_at="2026-01-04T10:00:00Z"),
            recalled(
                'usual_price_job: 15000', created_at="2025-03-01T09:00:00Z"
            ),
        )
    )
    service = AgentMemoryService(db=None, gateway=gateway)

    memories = await service._recall_memories(uuid.uuid4(), "fix a leak")

    assert [memory.text for memory in memories] == [
        'last_search: "plumber"',
        'usual_price_job: 15000',
    ]
    # The first occurrence is the one kept, so its date is the one that survives.
    assert memories[0].created_at == "2026-01-05T10:00:00Z"


async def test_near_duplicate_recalled_facts_are_not_collapsed(monkeypatch):
    """Only exact text equality is a duplicate. Two different sentences that say
    similar things are two facts, and both must reach the prompt."""
    gateway = RecordingGateway(
        memories=(
            recalled('last_search: "plumber"'),
            recalled('usual_search: "plumber"'),
        )
    )

    context = await _load(
        monkeypatch,
        gateway,
        {"last_search": "plumber", "usual_search": "plumber"},
    )

    assert context.count == 2
    assert context.prompt_entries == {
        "last_search": "plumber",
        "usual_search": "plumber",
    }


async def test_a_recalled_sentence_fact_reaches_the_prompt_without_a_local_key(
    monkeypatch,
):
    """Backfilled facts are whole sentences, not local memory keys.

    The relayer holds "Kosi hired a provider for a leaking pipe at 15000 naira"
    while the JSONB store holds keys like "last_search". Matching recalled text
    against the local keys alone discarded every backfilled fact, so the relayer
    answered while the prompt received nothing and the task logged "Recalled 0".
    A recalled sentence that matches no local key must still reach the model.
    """
    gateway = RecordingGateway(
        memories=(
            recalled("Kosi hired a provider for a leaking pipe at 15000 naira."),
            recalled('last_search: "plumber"'),
        )
    )

    context = await _load(monkeypatch, gateway, {"last_search": "plumber"})

    assert context.source == "walrus"
    assert context.recall_log_line == "Searching memory: Recalled 2 memories from Walrus"
    # The key-matched entry keeps its own name and value.
    assert context.entries["last_search"] == "plumber"
    # The sentence fact is present under its own label and is not lost.
    assert "Kosi hired a provider for a leaking pipe at 15000 naira." in (
        context.prompt_entries.values()
    )
    hint = build_memory_hint(context.prompt_entries)
    assert "leaking pipe" in hint
    assert "last_search" in hint


async def test_a_recalled_mirror_of_a_forgotten_key_never_reaches_the_prompt(
    monkeypatch,
):
    """Forget deletes the JSONB key, but Walrus Memory keeps the mirrored text.

    The relayer is append-only, so a recalled ``last_search: "plumber"`` whose
    key is no longer local is the mirror of a forgotten preference. Injecting it
    as a sentence fact would silently undo Forget and hand the model the value
    the user removed.
    """
    gateway = RecordingGateway(
        memories=(
            recalled('last_search: "plumber"'),
            recalled("Kosi hired a provider for a leaking pipe at 15000 naira."),
        )
    )

    context = await _load(monkeypatch, gateway, {})

    assert "last_search" not in context.entries
    assert context.count == 1
    assert "Kosi hired a provider for a leaking pipe at 15000 naira." in (
        context.prompt_entries.values()
    )


async def test_unmatched_key_shaped_text_is_not_injected_as_a_fact(monkeypatch):
    """The regression the smoke suite caught: an unknown entry is not a fact.

    The CI suite recalls a text whose key is not in the local memory beside two
    that are. Only the two local keys may reach the prompt; the third one is a
    mirror the relayer happens to hold, not something Gigr remembers now.
    """
    gateway = RecordingGateway(
        memories=(
            recalled('last_search: "plumber"'),
            recalled("usual_price_job: 5000"),
            recalled("unknown_entry: 1"),
        )
    )
    local = {
        "last_search": "plumber",
        "usual_price_job": 5000,
        "unrelated": "secret",
    }

    context = await _load(monkeypatch, gateway, local)

    assert context.entries == {
        "last_search": "plumber",
        "usual_price_job": 5000,
    }
    assert context.count == 2
    assert context.recall_log_line == "Searching memory: Recalled 2 memories from Walrus"


async def test_a_sentence_fact_that_contains_a_colon_still_reaches_the_prompt(
    monkeypatch,
):
    """The mirror rule must not eat prose that merely contains a colon.

    A backfilled sentence such as "Kosi posted a job for Fix: sink." ends with a
    full stop, so its tail is not JSON and it is still a fact. Without this
    guard, the filter meant to protect Forget would silently drop such facts.
    """
    fact = "Kosi posted a job for Fix: sink."
    gateway = RecordingGateway(memories=(recalled(fact),))

    context = await _load(monkeypatch, gateway, {})

    assert "Kosi posted a job for Fix: sink." in context.prompt_entries.values()
    assert context.count == 1
