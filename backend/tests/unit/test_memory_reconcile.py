"""Unit tests for the per-fact memory controls and their two endpoints.

No database and no live relayer: ``FakeRelayer`` keeps each namespace in memory
and honours the idempotency key exactly as the relayer does (a repeated key adds
no second row), so a whole reconcile runs for real against a fake boundary.

The tests exist because a reconcile is destructive in a way nothing else here
is: it wipes the user's whole namespace before writing it back. The regressions
they pin, in order of how much they would hurt:

* a wipe cannot happen before the restore list is flushed to disk;
* a process that dies after the wipe is repaired by the next call, and the
  sentence the user asked to delete is not brought back;
* a rewrite that fails part way is reported as partial, never as success, and
  its journal is kept so the next call can finish it;
* a reconcile that cannot read the namespace, cannot plan the rewrite or cannot
  stage the journal refuses to wipe rather than guess;
* the operation only ever names the caller's namespace, whatever the request
  carries;
* two deletes for one user cannot interleave and lose a kept sentence;
* every sentence that is not stored is a clean no-op, not an error.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from types import SimpleNamespace

import httpx
import pytest
from fastapi import FastAPI

from app.api.v1.endpoints import ai as ai_endpoints
from app.core.config import settings
from app.core.dependencies import get_current_user, get_db
from app.core.gateways.walrus_memory_gateway import (
    ForgottenNamespace,
    RecalledMemory,
)
from app.core.memory_namespace import memory_namespace
from app.services.fact_memory_service import FactMemoryService
from app.services.user_fact_service import build_fact_identity
from app.services.memory_reconcile_service import (
    MAX_FACTS_PER_OPERATION,
    RECONCILE_READ_LIMIT,
    KeyedLock,
    MemoryReconcileJournal,
    MemoryReconcileService,
)

USER = uuid.UUID("11111111-1111-4111-8111-111111111111")
OTHER = uuid.UUID("22222222-2222-4222-8222-222222222222")

FACT_ABOUT = "Kosi is based in Yaba."
FACT_JOB = "Kosi hired a provider for Fix sink at 8000 naira."
FACT_JOB_TWO = "Kosi hired a provider for Paint gate at 5000 naira."
FACT_SERVICE = "Kosi lists Fix sink at 8000 naira within 5 km."


class SimulatedCrash(BaseException):
    """The process dying mid-reconcile: nothing after the wipe gets to run.

    Deliberately not an ``Exception``: the service catches those and answers
    with a typed partial result. A crash must leave the journal and no answer,
    which is what this reproduces in-process.
    """


class FakeRelayer:
    """The relayer as the reconcile sees it, keeping one namespace per user.

    A row is stored under its idempotency key, which is what the real relayer
    deduplicates on: a second remember with the same key keeps the first row and
    adds nothing. That is the property a resumed restore depends on.

    Every method yields to the event loop once, so two operations started
    together interleave the way two requests would.
    """

    configured = True

    def __init__(self) -> None:
        self.rows: dict[str, dict[str, str]] = {}
        self.remember_calls: list[dict] = []
        self.recall_calls: list[dict] = []
        self.forget_calls: list[str] = []
        self.fail_recall: str | None = None
        self.fail_forget: str | None = None
        self.fail_remember: str | None = None
        self.crash_remember = False
        self.on_forget = None

    def seed(
        self, memory: FactMemoryService, user_id: uuid.UUID, texts: tuple[str, ...]
    ) -> None:
        """Store sentences under the same keys the fact writer would use."""
        namespace = memory.namespace(user_id)
        rows = self.rows.setdefault(namespace, {})
        for write in memory.plan(user_id, texts):
            rows[write.idempotency_key] = write.text

    def texts(self, user_id: uuid.UUID) -> list[str]:
        """The sentences this user's namespace holds, in insertion order."""
        return list(self.rows.get(memory_namespace(user_id), {}).values())

    def drop_namespace(self, user_id: uuid.UUID) -> None:
        """Simulate a wipe that landed outside the service under test."""
        self.rows[memory_namespace(user_id)] = {}

    async def remember(self, text, namespace, idempotency_key=None):
        await asyncio.sleep(0)
        self.remember_calls.append(
            {
                "text": text,
                "namespace": namespace,
                "idempotency_key": idempotency_key,
            }
        )
        if self.crash_remember:
            raise SimulatedCrash("the process died during the rewrite")
        if self.fail_remember is not None:
            raise RuntimeError(self.fail_remember)
        self.rows.setdefault(namespace, {}).setdefault(
            idempotency_key or text, text
        )
        return "job-1"

    async def recall(self, query, namespace, limit, **options):
        await asyncio.sleep(0)
        self.recall_calls.append(
            {"query": query, "namespace": namespace, "limit": limit, **options}
        )
        if self.fail_recall is not None:
            raise RuntimeError(self.fail_recall)
        texts = list(self.rows.get(namespace, {}).values())[:limit]
        return tuple(
            RecalledMemory(text=text, score=None, created_at=None)
            for text in texts
        )

    async def forget(self, namespace):
        await asyncio.sleep(0)
        self.forget_calls.append(namespace)
        if self.on_forget is not None:
            self.on_forget(namespace)
        if self.fail_forget is not None:
            raise RuntimeError(self.fail_forget)
        deleted = len(self.rows.get(namespace, {}))
        self.rows[namespace] = {}
        return ForgottenNamespace(
            namespace=namespace, deleted=deleted, verified=False
        )


def _namespace_scoped_key(text: str) -> str:
    """The relayer key for one fact, derived independently of the writer.

    This mirrors the contract rather than the implementation under test: a
    namespace, the user and the fact's stable identity, joined and hashed. A
    test that imported the writer's own helper would agree with any change it
    made to the key, including one that broke collapsing.
    """
    _, fact_key = build_fact_identity(text)
    payload = f"{memory_namespace(USER)}\x1f{USER}\x1f{fact_key}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def enable(monkeypatch, value: bool = True) -> None:
    """Turn the memory flag on or off for one test."""
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", value)


def build(tmp_path, *, seed: tuple[str, ...] = (), locks=None):
    """A real service over a fake relayer and a journal in a temporary path."""
    relayer = FakeRelayer()
    memory = FactMemoryService(gateway=relayer)
    journal = MemoryReconcileJournal(
        str(tmp_path / "journal.json"),
        settings.MEMWAL_NAMESPACE_PREFIX,
    )
    service = MemoryReconcileService(
        memory=memory,
        gateway=relayer,
        journal=journal,
        locks=locks or KeyedLock(),
    )
    relayer.seed(memory, USER, seed)
    return service, relayer, journal, memory


# -- Delete: the exact sentences, and only those ------------------------------


async def test_delete_facts_removes_only_the_named_sentences(
    tmp_path, monkeypatch
):
    enable(monkeypatch)
    service, relayer, journal, _ = build(
        tmp_path, seed=(FACT_ABOUT, FACT_JOB, FACT_JOB_TWO)
    )

    result = await service.delete_facts(USER, [FACT_JOB])

    assert result.ok is True
    assert result.reason == "ok"
    assert (result.removed, result.restored, result.remaining) == (1, 2, 2)
    assert result.partial is False
    assert relayer.texts(USER) == [FACT_ABOUT, FACT_JOB_TWO]
    assert relayer.forget_calls == [memory_namespace(USER)]
    assert journal.pending(USER) is None


async def test_a_restored_sentence_is_written_with_its_original_key(
    tmp_path, monkeypatch
):
    """The idempotency key is what makes a resumed restore collapse.

    The key is recomputed here from the fact's identity rather than taken from
    the writer, so a restore that invented a fresh key (and therefore stored
    every kept sentence a second time) cannot pass by agreeing with itself.
    """
    enable(monkeypatch)
    service, relayer, _, _ = build(tmp_path, seed=(FACT_ABOUT, FACT_JOB))
    expected = _namespace_scoped_key(FACT_ABOUT)
    assert expected in relayer.rows[memory_namespace(USER)]

    await service.delete_facts(USER, [FACT_JOB])

    assert expected in {
        call["idempotency_key"] for call in relayer.remember_calls
    }


async def test_every_call_targets_only_the_callers_namespace(
    tmp_path, monkeypatch
):
    enable(monkeypatch)
    service, relayer, _, _ = build(
        tmp_path, seed=(FACT_ABOUT, FACT_JOB, FACT_JOB_TWO)
    )

    await service.delete_facts(USER, [FACT_JOB])

    assert {call["namespace"] for call in relayer.recall_calls} == {
        memory_namespace(USER)
    }
    assert {call["namespace"] for call in relayer.remember_calls} == {
        memory_namespace(USER)
    }
    assert relayer.forget_calls == [memory_namespace(USER)]
    assert memory_namespace(OTHER) not in relayer.forget_calls
    assert relayer.rows.get(memory_namespace(OTHER), {}) == {}


async def test_deleting_a_sentence_that_is_gone_is_a_noop_without_a_wipe(
    tmp_path, monkeypatch
):
    """A no-op must never wipe: there is nothing to restore, so nothing runs."""
    enable(monkeypatch)
    service, relayer, journal, _ = build(
        tmp_path, seed=(FACT_ABOUT, FACT_JOB, FACT_JOB_TWO)
    )

    result = await service.delete_facts(USER, ["Kosi is based in Ikeja."])

    assert result.ok is True
    assert result.reason == "nothing_to_remove"
    assert (result.removed, result.restored, result.remaining) == (0, 0, 3)
    assert result.detail != ""
    assert relayer.forget_calls == []
    assert relayer.remember_calls == []
    assert journal.pending(USER) is None


async def test_a_near_match_is_not_removed(tmp_path, monkeypatch):
    """Matching is by exact text, so a missing full stop is a different sentence."""
    enable(monkeypatch)
    service, relayer, _, _ = build(tmp_path, seed=(FACT_ABOUT,))

    result = await service.delete_facts(USER, [FACT_ABOUT.rstrip(".")])

    assert result.reason == "nothing_to_remove"
    assert relayer.forget_calls == []
    assert relayer.texts(USER) == [FACT_ABOUT]


# -- Delete one category ------------------------------------------------------


async def test_delete_category_removes_every_sentence_in_that_group(
    tmp_path, monkeypatch
):
    enable(monkeypatch)
    service, relayer, _, _ = build(
        tmp_path,
        seed=(FACT_ABOUT, FACT_JOB, FACT_JOB_TWO, FACT_SERVICE),
    )

    result = await service.delete_category(USER, "jobs")

    assert result.ok is True
    assert (result.removed, result.restored, result.remaining) == (2, 2, 2)
    assert set(relayer.texts(USER)) == {FACT_ABOUT, FACT_SERVICE}


async def test_delete_category_with_nothing_in_it_is_a_noop_without_a_wipe(
    tmp_path, monkeypatch
):
    enable(monkeypatch)
    service, relayer, _, _ = build(tmp_path, seed=(FACT_ABOUT, FACT_JOB))

    result = await service.delete_category(USER, "ratings")

    assert result.ok is True
    assert result.reason == "nothing_to_remove"
    assert result.remaining == 2
    assert relayer.forget_calls == []


# -- Replace one sentence -----------------------------------------------------


async def test_replace_fact_removes_the_old_and_saves_the_new_in_its_place(
    tmp_path, monkeypatch
):
    enable(monkeypatch)
    service, relayer, _, _ = build(
        tmp_path, seed=(FACT_ABOUT, FACT_JOB, FACT_JOB_TWO)
    )
    edited = "Kosi hired a provider for Fix sink at 9000 naira."

    result = await service.replace_fact(USER, FACT_JOB, edited)

    assert result.ok is True
    assert (result.removed, result.restored, result.remaining) == (1, 3, 3)
    assert relayer.texts(USER) == [FACT_ABOUT, edited, FACT_JOB_TWO]


async def test_replacing_a_sentence_that_is_gone_does_not_save_the_new_text(
    tmp_path, monkeypatch
):
    """Saving the orphan would put back a sentence a previous delete removed."""
    enable(monkeypatch)
    service, relayer, _, _ = build(tmp_path, seed=(FACT_ABOUT,))
    edited = "Kosi hired a provider for Fix sink at 9000 naira."

    result = await service.replace_fact(USER, FACT_JOB, edited)

    assert result.ok is True
    assert result.reason == "nothing_to_replace"
    assert result.detail != ""
    assert relayer.forget_calls == []
    assert relayer.texts(USER) == [FACT_ABOUT]


async def test_replacing_a_sentence_with_itself_is_unchanged_and_wipes_nothing(
    tmp_path, monkeypatch
):
    enable(monkeypatch)
    service, relayer, _, _ = build(tmp_path, seed=(FACT_ABOUT, FACT_JOB))

    result = await service.replace_fact(USER, FACT_JOB, FACT_JOB)

    assert result.reason == "unchanged"
    assert result.remaining == 2
    assert relayer.forget_calls == []


# -- Every unavailable state is a typed answer --------------------------------


async def test_the_flag_off_answers_without_touching_the_relayer(
    tmp_path, monkeypatch
):
    enable(monkeypatch, False)
    service, relayer, _, _ = build(tmp_path, seed=(FACT_JOB,))

    result = await service.delete_facts(USER, [FACT_JOB])

    assert result.ok is False
    assert result.reason == "feature_disabled"
    assert result.detail != ""
    assert relayer.recall_calls == []
    assert relayer.forget_calls == []


async def test_an_unconfigured_gateway_answers_without_touching_the_relayer(
    tmp_path, monkeypatch
):
    enable(monkeypatch)
    relayer = FakeRelayer()
    memory = FactMemoryService(gateway=relayer)
    service = MemoryReconcileService(
        memory=memory,
        gateway=None,
        journal=MemoryReconcileJournal(
            str(tmp_path / "journal.json"), settings.MEMWAL_NAMESPACE_PREFIX
        ),
        locks=KeyedLock(),
    )

    result = await service.delete_facts(USER, [FACT_JOB])

    assert result.ok is False
    assert result.reason == "not_configured"
    assert relayer.forget_calls == []


async def test_a_read_that_fails_wipes_nothing(tmp_path, monkeypatch):
    enable(monkeypatch)
    service, relayer, journal, _ = build(tmp_path, seed=(FACT_JOB,))
    relayer.fail_recall = "timeout after 30.0s"

    result = await service.delete_facts(USER, [FACT_JOB])

    assert result.ok is False
    assert result.reason == "relayer_timeout"
    assert result.partial is False
    assert relayer.forget_calls == []
    assert relayer.remember_calls == []
    assert journal.pending(USER) is None


async def test_a_namespace_too_large_to_read_fully_is_not_wiped(
    tmp_path, monkeypatch
):
    """A full read is not proof of the whole namespace, so it cannot be wiped."""
    enable(monkeypatch)
    facts = tuple(
        f"Kosi hired a provider for Job {index} at {1000 + index} naira."
        for index in range(RECONCILE_READ_LIMIT)
    )
    service, relayer, _, _ = build(tmp_path, seed=facts)

    result = await service.delete_facts(USER, [facts[0]])

    assert result.ok is False
    assert result.reason == "memory_too_large"
    assert result.detail != ""
    assert relayer.forget_calls == []
    assert len(relayer.texts(USER)) == RECONCILE_READ_LIMIT


# -- The wipe and the rewrite -------------------------------------------------


async def test_a_wipe_that_fails_puts_every_sentence_back_and_reports_it(
    tmp_path, monkeypatch
):
    """The rows may survive a failed wipe, so the kept sentences are re-written.

    Their idempotency keys are the originals, so a wipe that did not land leaves
    the namespace as it was instead of duplicating every sentence.
    """
    enable(monkeypatch)
    service, relayer, journal, _ = build(
        tmp_path, seed=(FACT_ABOUT, FACT_JOB, FACT_JOB_TWO)
    )
    relayer.fail_forget = "rate_limited: 429"

    result = await service.delete_facts(USER, [FACT_JOB])

    assert result.ok is False
    assert result.reason == "relayer_busy"
    assert result.partial is False
    assert result.removed == 0
    assert result.remaining == 2
    assert set(relayer.texts(USER)) == {FACT_ABOUT, FACT_JOB, FACT_JOB_TWO}
    assert len(relayer.texts(USER)) == 3
    # The kept sentences were written back, not merely left in place: a wipe
    # that did land before erroring must not cost the user anything.
    assert len(relayer.remember_calls) == 2
    assert journal.pending(USER) is None


async def test_a_restore_that_fails_is_partial_and_keeps_the_journal(
    tmp_path, monkeypatch
):
    """The wipe landed and the rewrite did not: the user must not be told it worked."""
    enable(monkeypatch)
    service, relayer, journal, _ = build(
        tmp_path, seed=(FACT_ABOUT, FACT_JOB, FACT_JOB_TWO)
    )
    relayer.fail_remember = "rate_limited: 429"

    result = await service.delete_facts(USER, [FACT_JOB])

    assert result.ok is False
    assert result.reason == "restore_incomplete"
    assert result.partial is True
    assert result.removed == 1
    assert result.restored == 0
    assert result.remaining is None
    assert "restored incompletely" in result.detail
    assert relayer.texts(USER) == []
    pending = journal.pending(USER)
    assert pending is not None
    assert pending.facts == (FACT_ABOUT, FACT_JOB_TWO)


async def test_a_partial_restore_is_finished_by_the_next_call(
    tmp_path, monkeypatch
):
    enable(monkeypatch)
    service, relayer, journal, _ = build(
        tmp_path, seed=(FACT_ABOUT, FACT_JOB, FACT_JOB_TWO)
    )
    relayer.fail_remember = "rate_limited: 429"
    assert (await service.delete_facts(USER, [FACT_JOB])).partial is True

    relayer.fail_remember = None
    result = await service.delete_facts(USER, [FACT_JOB])

    assert result.ok is True
    assert result.recovered is True
    assert result.reason == "nothing_to_remove"
    assert set(relayer.texts(USER)) == {FACT_ABOUT, FACT_JOB_TWO}
    assert journal.pending(USER) is None


async def test_a_new_operation_does_not_start_while_a_restore_is_pending(
    tmp_path, monkeypatch
):
    """The pending restore runs first, and its failure stops the new wipe."""
    enable(monkeypatch)
    service, relayer, journal, memory = build(tmp_path)
    journal.stage(
        USER,
        memory_namespace(USER),
        (FACT_ABOUT, FACT_JOB_TWO),
        "delete_facts",
    )
    relayer.drop_namespace(USER)
    relayer.fail_remember = "rate_limited: 429"

    result = await service.delete_facts(USER, [FACT_JOB])

    assert result.ok is False
    assert result.partial is True
    assert result.reason == "restore_incomplete"
    assert result.detail != ""
    assert relayer.forget_calls == []
    assert journal.pending(USER) is not None


# -- The crash this whole design exists for -----------------------------------


async def test_the_restore_list_is_flushed_to_disk_before_the_wipe(
    tmp_path, monkeypatch
):
    enable(monkeypatch)
    service, relayer, _, _ = build(
        tmp_path, seed=(FACT_ABOUT, FACT_JOB, FACT_JOB_TWO)
    )
    seen: dict = {}

    def snapshot(namespace: str) -> None:
        payload = json.loads((tmp_path / "journal.json").read_text(encoding="utf-8"))
        seen["entry"] = payload["users"][str(USER)]

    relayer.on_forget = snapshot

    result = await service.delete_facts(USER, [FACT_JOB])

    assert result.ok is True
    assert seen["entry"]["facts"] == [FACT_ABOUT, FACT_JOB_TWO]
    assert seen["entry"]["namespace"] == memory_namespace(USER)


async def test_a_crash_after_the_wipe_is_repaired_by_the_next_call(
    tmp_path, monkeypatch
):
    """The central guarantee: a process that dies between wipe and rewrite.

    The crash is a BaseException raised by the first rewrite, which is exactly
    what a dying process looks like to this code: the journal is on disk, the
    namespace is empty and no handler ran. A new service over the same journal
    must write the kept sentences back before it does anything else, and must
    not bring back the sentence the user deleted.
    """
    enable(monkeypatch)
    service, relayer, journal, memory = build(
        tmp_path, seed=(FACT_ABOUT, FACT_JOB, FACT_JOB_TWO)
    )
    relayer.crash_remember = True

    with pytest.raises(SimulatedCrash):
        await service.delete_facts(USER, [FACT_JOB])

    assert relayer.texts(USER) == []
    pending = journal.pending(USER)
    assert pending is not None
    assert pending.facts == (FACT_ABOUT, FACT_JOB_TWO)

    # A new process: a new service, the same journal file on disk.
    relayer.crash_remember = False
    recovered_service = MemoryReconcileService(
        memory=memory,
        gateway=relayer,
        journal=MemoryReconcileJournal(
            str(tmp_path / "journal.json"), settings.MEMWAL_NAMESPACE_PREFIX
        ),
        locks=KeyedLock(),
    )

    result = await recovered_service.delete_facts(
        USER, ["A sentence that is not stored."]
    )

    assert result.ok is True
    assert result.recovered is True
    assert set(relayer.texts(USER)) == {FACT_ABOUT, FACT_JOB_TWO}
    assert FACT_JOB not in relayer.texts(USER)
    assert journal.pending(USER) is None


async def test_a_corrupt_journal_refuses_to_wipe(tmp_path, monkeypatch):
    enable(monkeypatch)
    service, relayer, _, _ = build(tmp_path, seed=(FACT_JOB,))
    (tmp_path / "journal.json").write_text("{not json", encoding="utf-8")

    result = await service.delete_facts(USER, [FACT_JOB])

    assert result.ok is False
    assert result.reason == "journal_failed"
    assert result.partial is True
    assert result.detail != ""
    assert relayer.forget_calls == []
    assert relayer.texts(USER) == [FACT_JOB]


async def test_a_journal_from_another_namespace_prefix_refuses_to_wipe(
    tmp_path, monkeypatch
):
    """The staged sentences name a namespace that no longer exists."""
    enable(monkeypatch)
    service, relayer, journal, _ = build(tmp_path, seed=(FACT_JOB,))
    journal.stage(USER, memory_namespace(USER), (FACT_ABOUT,), "delete_facts")

    service_under_another_prefix = MemoryReconcileService(
        memory=FactMemoryService(gateway=relayer),
        gateway=relayer,
        journal=MemoryReconcileJournal(str(tmp_path / "journal.json"), "acme-user"),
        locks=KeyedLock(),
    )

    result = await service_under_another_prefix.delete_facts(USER, [FACT_JOB])

    assert result.ok is False
    assert result.reason == "journal_failed"
    assert relayer.forget_calls == []
    assert relayer.texts(USER) == [FACT_JOB]


# -- Two requests for one user ------------------------------------------------


async def test_two_deletes_for_one_user_cannot_lose_a_kept_sentence(
    tmp_path, monkeypatch
):
    """The per-user lock is what keeps the two rewrites from erasing each other.

    Both requests read the same three sentences, both wipe, and each writes back
    only what it kept. Without the lock the second wipe runs before the first
    restore, so one sentence is lost even though neither request named it.
    """
    enable(monkeypatch)
    locks = KeyedLock()
    relayer = FakeRelayer()
    memory = FactMemoryService(gateway=relayer)
    journal = MemoryReconcileJournal(
        str(tmp_path / "journal.json"), settings.MEMWAL_NAMESPACE_PREFIX
    )
    relayer.seed(memory, USER, (FACT_ABOUT, FACT_JOB, FACT_JOB_TWO))
    request_one = MemoryReconcileService(
        memory=memory, gateway=relayer, journal=journal, locks=locks
    )
    request_two = MemoryReconcileService(
        memory=memory, gateway=relayer, journal=journal, locks=locks
    )

    results = await asyncio.gather(
        request_one.delete_facts(USER, [FACT_JOB]),
        request_two.delete_facts(USER, [FACT_JOB_TWO]),
    )

    assert [result.ok for result in results] == [True, True]
    assert relayer.texts(USER) == [FACT_ABOUT]


# -- The endpoints ------------------------------------------------------------


class StubReconcileService:
    """The three service methods the routes call, recorded."""

    def __init__(self, result=None) -> None:
        self.result = result
        self.calls: list[tuple] = []

    async def delete_facts(self, user_id, facts):
        self.calls.append(("delete_facts", user_id, tuple(facts)))
        return self.result

    async def delete_category(self, user_id, category):
        self.calls.append(("delete_category", user_id, category))
        return self.result

    async def replace_fact(self, user_id, old_text, new_text):
        self.calls.append(("replace_fact", user_id, old_text, new_text))
        return self.result


def mount_app(user_id: uuid.UUID | None = None):
    """The AI router on a bare app, with the caller's identity overridden."""
    app = FastAPI()
    app.include_router(ai_endpoints.router, prefix="/api/v1")
    user = SimpleNamespace(id=user_id or USER)
    app.dependency_overrides[get_current_user] = lambda: user
    app.dependency_overrides[get_db] = lambda: None
    return app, user


async def call(app: FastAPI, method: str, path: str, **kwargs):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(
        transport=transport, base_url="http://testserver"
    ) as client:
        return await client.request(method, path, **kwargs)


def install_service(monkeypatch, service) -> None:
    monkeypatch.setattr(
        ai_endpoints, "build_memory_reconcile_service", lambda: service
    )


async def test_delete_facts_requires_authentication():
    app = FastAPI()
    app.include_router(ai_endpoints.router, prefix="/api/v1")

    response = await call(
        app,
        "DELETE",
        "/api/v1/ai/memory/facts",
        json={"texts": [FACT_JOB]},
    )

    assert response.status_code == 401
    assert "removed" not in response.text


async def test_replace_fact_requires_authentication():
    app = FastAPI()
    app.include_router(ai_endpoints.router, prefix="/api/v1")

    response = await call(
        app,
        "PATCH",
        "/api/v1/ai/memory/facts",
        json={"old_text": FACT_JOB, "new_text": "edited"},
    )

    assert response.status_code == 401


@pytest.mark.parametrize("method", ["DELETE", "PATCH"])
async def test_the_reconcile_routes_are_not_exposed_with_the_flag_off(
    monkeypatch, method
):
    enable(monkeypatch, False)
    service = StubReconcileService(result=None)
    install_service(monkeypatch, service)
    app, _ = mount_app()

    if method == "DELETE":
        response = await call(
            app, method, "/api/v1/ai/memory/facts", json={"texts": [FACT_JOB]}
        )
    else:
        response = await call(
            app,
            method,
            "/api/v1/ai/memory/facts",
            json={"old_text": FACT_JOB, "new_text": "edited"},
        )

    assert response.status_code == 404
    assert service.calls == []


async def test_delete_facts_is_not_handled_by_the_per_key_forget_route(
    tmp_path, monkeypatch
):
    """The exact facts path must be declared before /ai/memory/{key}.

    If it were not, this request would delete a saved JSONB key named "facts"
    instead of removing memories, and the page would report a success.
    """
    enable(monkeypatch)
    service, relayer, _, _ = build(tmp_path, seed=(FACT_ABOUT, FACT_JOB))
    install_service(monkeypatch, service)
    app, _ = mount_app()

    response = await call(
        app, "DELETE", "/api/v1/ai/memory/facts", json={"texts": [FACT_JOB]}
    )

    assert response.status_code == 200, response.text
    assert response.json()["removed"] == 1
    assert relayer.forget_calls == [memory_namespace(USER)]


async def test_a_foreign_namespace_in_the_query_and_body_is_ignored(
    tmp_path, monkeypatch
):
    """Only the authenticated caller's namespace is ever read, wiped or written."""
    enable(monkeypatch)
    service, relayer, _, _ = build(tmp_path, seed=(FACT_ABOUT, FACT_JOB))
    install_service(monkeypatch, service)
    app, user = mount_app()

    response = await call(
        app,
        "DELETE",
        "/api/v1/ai/memory/facts",
        params={"namespace": memory_namespace(OTHER)},
        json={
            "texts": [FACT_JOB],
            "namespace": memory_namespace(OTHER),
            "user_id": str(OTHER),
        },
    )

    assert response.status_code == 200, response.text
    assert response.json()["ok"] is True
    assert relayer.forget_calls == [memory_namespace(USER)]
    assert memory_namespace(OTHER) not in relayer.forget_calls
    assert relayer.texts(USER) == [FACT_ABOUT]
    assert relayer.rows.get(memory_namespace(OTHER), {}) == {}
    assert user.id == USER


async def test_a_foreign_namespace_in_the_path_cannot_name_another_user(
    tmp_path, monkeypatch
):
    enable(monkeypatch)
    service, relayer, _, _ = build(tmp_path, seed=(FACT_JOB,))
    install_service(monkeypatch, service)
    app, _ = mount_app()

    response = await call(
        app,
        "DELETE",
        f"/api/v1/ai/memory/facts/{memory_namespace(OTHER)}",
        json={"texts": [FACT_JOB]},
    )

    assert response.status_code in (404, 405)
    assert relayer.forget_calls == []


async def test_delete_answers_with_the_typed_result_and_its_counts(
    tmp_path, monkeypatch
):
    enable(monkeypatch)
    service, _, _, _ = build(
        tmp_path, seed=(FACT_ABOUT, FACT_JOB, FACT_JOB_TWO)
    )
    install_service(monkeypatch, service)
    app, _ = mount_app()

    response = await call(
        app, "DELETE", "/api/v1/ai/memory/facts", json={"texts": [FACT_JOB]}
    )

    assert response.status_code == 200, response.text
    assert response.json() == {
        "status": "ok",
        "ok": True,
        "reason": "ok",
        "removed": 1,
        "restored": 2,
        "remaining": 2,
        "partial": False,
        "recovered": False,
        "detail": (
            "Removed 1 memory. Walrus Memory now holds 2 memories, so "
            "everything you kept is still remembered."
        ),
    }


async def test_delete_one_category_removes_that_group(
    tmp_path, monkeypatch
):
    enable(monkeypatch)
    service, relayer, _, _ = build(
        tmp_path,
        seed=(FACT_ABOUT, FACT_JOB, FACT_JOB_TWO, FACT_SERVICE),
    )
    install_service(monkeypatch, service)
    app, _ = mount_app()

    response = await call(
        app, "DELETE", "/api/v1/ai/memory/facts", json={"category": "jobs"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["removed"] == 2
    assert set(relayer.texts(USER)) == {FACT_ABOUT, FACT_SERVICE}


async def test_replace_fact_returns_the_edit_and_the_foreign_namespace_is_ignored(
    tmp_path, monkeypatch
):
    enable(monkeypatch)
    service, relayer, _, _ = build(
        tmp_path, seed=(FACT_ABOUT, FACT_JOB, FACT_JOB_TWO)
    )
    install_service(monkeypatch, service)
    app, _ = mount_app()
    edited = "Kosi hired a provider for Fix sink at 9000 naira."

    response = await call(
        app,
        "PATCH",
        "/api/v1/ai/memory/facts",
        json={
            "old_text": FACT_JOB,
            "new_text": edited,
            "namespace": memory_namespace(OTHER),
        },
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ok"] is True
    assert body["removed"] == 1
    assert body["restored"] == 3
    assert relayer.texts(USER) == [FACT_ABOUT, edited, FACT_JOB_TWO]
    assert relayer.forget_calls == [memory_namespace(USER)]


async def test_a_partial_restore_is_not_reported_as_a_success(
    tmp_path, monkeypatch
):
    enable(monkeypatch)
    service, relayer, _, _ = build(
        tmp_path, seed=(FACT_ABOUT, FACT_JOB, FACT_JOB_TWO)
    )
    relayer.fail_remember = "rate_limited: 429"
    install_service(monkeypatch, service)
    app, _ = mount_app()

    response = await call(
        app, "DELETE", "/api/v1/ai/memory/facts", json={"texts": [FACT_JOB]}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["status"] == "partial"
    assert body["ok"] is False
    assert body["partial"] is True
    assert body["reason"] == "restore_incomplete"
    assert "restored incompletely" in body["detail"]


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"texts": []},
        {"texts": None},
        {"texts": [FACT_JOB], "category": "jobs"},
        {"texts": ["   "]},
        {"texts": ["x"] * (MAX_FACTS_PER_OPERATION + 1)},
        {"category": ""},
        {"category": "a" * 33},
    ],
)
async def test_a_delete_that_names_no_single_target_is_rejected(
    monkeypatch, body
):
    enable(monkeypatch)
    service = StubReconcileService(result=None)
    install_service(monkeypatch, service)
    app, _ = mount_app()

    response = await call(
        app, "DELETE", "/api/v1/ai/memory/facts", json=body
    )

    assert response.status_code == 422
    assert service.calls == []


@pytest.mark.parametrize(
    "body",
    [
        {"old_text": FACT_JOB},
        {"new_text": "edited"},
        {"old_text": "", "new_text": "edited"},
        {"old_text": FACT_JOB, "new_text": "   "},
        {"old_text": "x" * 2001, "new_text": "edited"},
    ],
)
async def test_an_edit_without_two_usable_texts_is_rejected(monkeypatch, body):
    enable(monkeypatch)
    service = StubReconcileService(result=None)
    install_service(monkeypatch, service)
    app, _ = mount_app()

    response = await call(
        app, "PATCH", "/api/v1/ai/memory/facts", json=body
    )

    assert response.status_code == 422
    assert service.calls == []


async def test_every_destructive_detail_is_a_usable_sentence(
    tmp_path, monkeypatch
):
    """The page shows these strings verbatim, so they must be real sentences."""
    enable(monkeypatch)
    details: list[str] = []

    service, relayer, _, _ = build(tmp_path, seed=(FACT_ABOUT, FACT_JOB))
    details.append((await service.delete_facts(USER, [FACT_JOB])).detail)

    relayer.fail_recall = "rate_limited: 429"
    details.append((await service.delete_facts(USER, [FACT_ABOUT])).detail)
    relayer.fail_recall = None

    relayer.fail_forget = "connection reset by peer"
    details.append((await service.delete_facts(USER, [FACT_ABOUT])).detail)

    assert all(detail.strip() for detail in details)
    banned = (
        "something went wrong",
        "an error occurred",
        "invalid input",
        "unknown error",
    )
    for detail in details:
        assert detail.casefold().strip(".") not in banned
        assert not detail.casefold().startswith("error")
