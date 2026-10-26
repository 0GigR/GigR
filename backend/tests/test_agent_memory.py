"""Tests for the agent memory backend and its Walrus Memory flag.

The defect regressions (lost update, silent missing-user save, forget/save
divergence) are exercised through the same seams the application uses: the
``/ai/memory`` endpoints and the ``_load_memory`` / ``_save_memory`` helpers the
agent loop calls. Walrus itself is always a fake gateway; no test contacts the
relayer.
"""

from __future__ import annotations

import asyncio
import json
import uuid

import pytest
from sqlalchemy import text

from app.api.v1.endpoints import ai as ai_endpoints
from app.core.config import settings
from app.core.database import async_session, engine
from app.core.gateways.walrus_memory_gateway import RecalledMemory
from conftest import auth_headers, register_user

MEMORY_URL = "/api/v1/ai/memory"


class FakeGateway:
    """The three methods AgentMemoryService is allowed to use."""

    configured = True

    def __init__(
        self,
        recall_texts: tuple[str, ...] = (),
        fail_remember: bool = False,
        fail_recall: bool = False,
        recall_created_at: str | None = None,
    ) -> None:
        self.recall_texts = recall_texts
        self.recall_created_at = recall_created_at
        self.fail_remember = fail_remember
        self.fail_recall = fail_recall
        self.remember_calls: list[dict] = []
        self.recall_calls: list[dict] = []

    async def remember(self, text, namespace, idempotency_key=None):
        self.remember_calls.append(
            {"text": text, "namespace": namespace, "idempotency_key": idempotency_key}
        )
        if self.fail_remember:
            raise RuntimeError("relayer unreachable")
        return "job-1"

    async def recall(self, query, namespace, limit):
        self.recall_calls.append(
            {"query": query, "namespace": namespace, "limit": limit}
        )
        if self.fail_recall:
            raise RuntimeError("relayer unreachable")
        return tuple(
            RecalledMemory(
                text=text, score=None, created_at=self.recall_created_at
            )
            for text in self.recall_texts
        )

    async def list_namespaces(self):
        return ()


def use_walrus(monkeypatch, gateway) -> None:
    """Enable the flag and inject the fake gateway at the composition root."""
    from app.core import container

    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)
    monkeypatch.setattr(container, "agent_memory_gateway", gateway)


def use_json_only(monkeypatch) -> None:
    from app.core import container

    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", False)
    monkeypatch.setattr(container, "agent_memory_gateway", None)


async def read_ai_settings(user_id: str) -> dict:
    """Read the raw JSONB column, not the endpoint's view of it."""
    async with engine.connect() as conn:
        row = (
            await conn.execute(
                text("SELECT ai_settings::text FROM users WHERE id = :id"),
                {"id": user_id},
            )
        ).first()
    assert row is not None, "the user row disappeared during the test"
    return json.loads(row[0]) if row[0] else {}


async def write_ai_settings(user_id: str, value: dict) -> None:
    async with engine.begin() as conn:
        await conn.execute(
            text("UPDATE users SET ai_settings = CAST(:value AS jsonb) WHERE id = :id"),
            {"value": json.dumps(value), "id": user_id},
        )


async def make_user(client, role: str = "client") -> tuple[dict, dict, uuid.UUID]:
    user = await register_user(client, role=role)
    return user, auth_headers(user["token"]), uuid.UUID(user["user_id"])


async def patch_memory(client, headers, patch: dict):
    return await client.patch(MEMORY_URL, headers=headers, json=patch)


async def test_memory_patch_round_trip_is_visible_to_the_agent_context(client):
    """A PATCHed key must reach the context the agent loop injects."""
    user, headers, user_id = await make_user(client)

    resp = await patch_memory(client, headers, {"last_search": "plumber"})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"status": "ok", "memory": {"last_search": "plumber"}}

    async with async_session() as db:
        context = await ai_endpoints._load_memory(db, user_id)
        await db.rollback()

    entries = getattr(context, "entries", context)
    assert entries == {"last_search": "plumber"}


async def test_concurrent_memory_saves_keep_every_key(client):
    """Regression for the lost update: two snapshots must not discard a key."""
    user, headers, user_id = await make_user(client)
    assert (await patch_memory(client, headers, {"base": 1})).status_code == 200

    updates = {f"key_{index}": index for index in range(5)}
    responses = await asyncio.gather(
        *[patch_memory(client, headers, {key: value}) for key, value in updates.items()]
    )
    assert [response.status_code for response in responses] == [200] * len(updates)

    stored = await read_ai_settings(user["user_id"])
    assert stored["memory"] == {"base": 1, **updates}


async def test_concurrent_crud_merges_keep_every_key(client):
    """The row lock is what makes the concurrent endpoint test above pass."""
    from app.crud.agent_memory import merge_memory

    user, _, user_id = await make_user(client)
    updates = {f"crud_{index}": index for index in range(8)}

    async def save(key: str, value: int) -> None:
        async with async_session() as db:
            await merge_memory(db, user_id, {key: value})
            await db.commit()

    await asyncio.gather(*[save(key, value) for key, value in updates.items()])

    async with async_session() as db:
        stored = await merge_memory(db, user_id, {})
        await db.rollback()

    assert stored == updates
    assert (await read_ai_settings(user["user_id"]))["memory"] == updates


async def test_saving_memory_for_a_missing_user_raises_instead_of_succeeding(
    db_ready,
):
    """Regression for the silent return: a save that did not happen must fail."""
    missing_user = uuid.uuid4()
    async with async_session() as db:
        with pytest.raises(Exception) as caught:
            await ai_endpoints._save_memory(db, missing_user, {"last_search": "x"})
        await db.rollback()

    # The internal error names the identifier, so an operator can trace it.
    assert str(missing_user) in str(caught.value)


async def test_missing_user_save_raises_the_typed_crud_error(db_ready):
    """The router maps this exact type to a 404; nothing else may be raised."""
    from app.core.errors import RecordNotFoundError

    missing_user = uuid.uuid4()
    async with async_session() as db:
        with pytest.raises(RecordNotFoundError) as caught:
            await ai_endpoints._save_memory(db, missing_user, {"last_search": "x"})
        await db.rollback()

    assert caught.value.code == "record_not_found"
    assert caught.value.entity == "user"


async def test_forget_and_save_are_one_locked_operation(client):
    """Regression for duplicated logic: forget and save must serialize."""
    users = []
    for _ in range(4):
        user, headers, user_id = await make_user(client)
        assert (
            await patch_memory(client, headers, {"keep": 1, "doomed": 2})
        ).status_code == 200
        users.append((user, headers))

    async def forget_and_save(headers) -> tuple[int, int]:
        forget, save = await asyncio.gather(
            client.delete(f"{MEMORY_URL}/doomed", headers=headers),
            patch_memory(client, headers, {"added": 3}),
        )
        return forget.status_code, save.status_code

    results = await asyncio.gather(*[forget_and_save(headers) for _, headers in users])

    assert results == [(200, 200)] * len(users)
    for user, _ in users:
        stored = await read_ai_settings(user["user_id"])
        assert stored["memory"] == {"keep": 1, "added": 3}


async def test_flag_off_writes_the_jsonb_column_exactly_and_never_calls_walrus(
    client, monkeypatch
):
    """With the flag off a configured gateway must be ignored entirely."""
    fake = FakeGateway()
    from app.core import container

    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", False)
    monkeypatch.setattr(container, "agent_memory_gateway", fake)

    user, headers, user_id = await make_user(client)
    before = {"autonomyLevel": "high", "memory": {"old": True}}
    await write_ai_settings(user["user_id"], before)

    resp = await patch_memory(
        client, headers, {"last_search": "plumber", "max_price": 5000}
    )

    assert resp.status_code == 200, resp.text
    assert resp.json()["memory"] == {
        "old": True,
        "last_search": "plumber",
        "max_price": 5000,
    }
    # The whole column, not just the memory key: siblings are preserved.
    assert await read_ai_settings(user["user_id"]) == {
        "autonomyLevel": "high",
        "memory": {"old": True, "last_search": "plumber", "max_price": 5000},
    }
    assert fake.remember_calls == []
    assert fake.recall_calls == []


async def test_flag_off_agent_context_is_the_whole_memory_dump(client, monkeypatch):
    use_json_only(monkeypatch)
    _, headers, user_id = await make_user(client)
    memory = {"a": 1, "b": 2, "c": 3}
    assert (await patch_memory(client, headers, memory)).status_code == 200

    async with async_session() as db:
        recall = await ai_endpoints._load_memory(db, user_id, query="anything at all")
        await db.rollback()

    assert recall.entries == memory
    assert recall.semantic is False


async def test_flag_on_falls_back_to_json_when_the_gateway_fails(client, monkeypatch):
    fake = FakeGateway(fail_remember=True, fail_recall=True)
    use_walrus(monkeypatch, fake)
    user, headers, user_id = await make_user(client)

    resp = await patch_memory(client, headers, {"last_search": "plumber"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["memory"] == {"last_search": "plumber"}
    assert (await read_ai_settings(user["user_id"]))["memory"] == {
        "last_search": "plumber"
    }
    assert fake.remember_calls, "the save should have been mirrored before failing"

    async with async_session() as db:
        recall = await ai_endpoints._load_memory(db, user_id, query="fix a leak")
        await db.rollback()

    assert recall.source == "json"
    assert recall.semantic is True
    assert recall.entries == {"last_search": "plumber"}
    assert recall.recall_log_line == (
        "Searching memory: Recalled 1 memory from local storage"
    )


async def test_flag_on_injects_only_the_semantically_recalled_entries(
    client, monkeypatch
):
    fake = FakeGateway(
        recall_texts=(
            'last_search: "plumber"',
            "usual_price_job: 5000",
            "unknown_entry: 1",
        )
    )
    use_walrus(monkeypatch, fake)
    _, headers, user_id = await make_user(client)
    assert (
        await patch_memory(
            client,
            headers,
            {"last_search": "plumber", "usual_price_job": 5000, "unrelated": "secret"},
        )
    ).status_code == 200

    async with async_session() as db:
        recall = await ai_endpoints._load_memory(db, user_id, query="fix a leak")
        await db.rollback()

    assert recall.entries == {"last_search": "plumber", "usual_price_job": 5000}
    assert recall.source == "walrus"
    assert recall.semantic is True
    assert recall.count == 2
    assert recall.recall_log_line == (
        "Searching memory: Recalled 2 memories from Walrus"
    )
    assert fake.recall_calls == [
        {
            "query": "fix a leak",
            "namespace": f"gigr-user-{user_id}",
            "limit": 5,
        }
    ]


async def test_flag_on_recalls_nothing_when_the_gateway_returns_no_matches(
    client, monkeypatch
):
    use_walrus(monkeypatch, FakeGateway(recall_texts=()))
    _, headers, user_id = await make_user(client)
    assert (await patch_memory(client, headers, {"last_search": "plumber"})).status_code == 200

    async with async_session() as db:
        recall = await ai_endpoints._load_memory(db, user_id, query="fix a leak")
        await db.rollback()

    assert recall.entries == {}
    assert recall.source == "walrus"
    assert recall.recall_log_line == (
        "Searching memory: Recalled 0 memories from Walrus"
    )


async def test_flag_on_mirrors_each_key_with_a_stable_idempotency_key(
    client, monkeypatch
):
    fake = FakeGateway()
    use_walrus(monkeypatch, fake)
    _, headers, user_id = await make_user(client)

    for _ in range(2):
        assert (
            await patch_memory(client, headers, {"last_search": "plumber"})
        ).status_code == 200

    assert len(fake.remember_calls) == 2
    first, second = fake.remember_calls
    assert first["text"] == 'last_search: "plumber"'
    assert first["namespace"] == f"gigr-user-{user_id}"
    assert first["idempotency_key"]
    assert first["idempotency_key"] == second["idempotency_key"]


async def test_flag_on_without_credentials_keeps_writing_json(client, monkeypatch):
    use_walrus(monkeypatch, None)
    user, headers, user_id = await make_user(client)

    resp = await patch_memory(client, headers, {"last_search": "plumber"})

    assert resp.status_code == 200, resp.text
    assert (await read_ai_settings(user["user_id"]))["memory"] == {
        "last_search": "plumber"
    }
    async with async_session() as db:
        recall = await ai_endpoints._load_memory(db, user_id, query="fix a leak")
        await db.rollback()
    assert recall.source == "json"
    assert recall.semantic is False


async def test_flag_on_caps_mirroring_but_keeps_every_key_in_json(client, monkeypatch):
    """A large patch must not spend the relayer budget, but must not lose data."""
    from app.services.agent_memory_service import MEMORY_MIRROR_MAX_KEYS

    fake = FakeGateway()
    use_walrus(monkeypatch, fake)
    user, headers, _ = await make_user(client)
    patch = {f"key_{index}": index for index in range(MEMORY_MIRROR_MAX_KEYS + 5)}

    resp = await patch_memory(client, headers, patch)

    assert resp.status_code == 200, resp.text
    assert len(fake.remember_calls) == MEMORY_MIRROR_MAX_KEYS
    assert (await read_ai_settings(user["user_id"]))["memory"] == patch


async def test_namespace_prefix_env_var_changes_the_namespace_sent_to_walrus(
    client, monkeypatch
):
    """MEMWAL_NAMESPACE_PREFIX must reach both the mirror and the recall."""
    from app.core.config import Settings

    monkeypatch.setenv("MEMWAL_NAMESPACE_PREFIX", "acme-user")
    startup = Settings()
    monkeypatch.setattr(
        settings, "MEMWAL_NAMESPACE_PREFIX", startup.MEMWAL_NAMESPACE_PREFIX
    )

    fake = FakeGateway(recall_texts=('last_search: "plumber"',))
    use_walrus(monkeypatch, fake)
    _, headers, user_id = await make_user(client)

    assert (
        await patch_memory(client, headers, {"last_search": "plumber"})
    ).status_code == 200
    async with async_session() as db:
        recall = await ai_endpoints._load_memory(db, user_id, query="fix a leak")
        await db.rollback()

    expected = f"acme-user-{user_id}"
    assert [call["namespace"] for call in fake.remember_calls] == [expected]
    assert [call["namespace"] for call in fake.recall_calls] == [expected]
    assert recall.entries == {"last_search": "plumber"}


class RaisingVerifier:
    """A Sui verifier whose every call fails, as an unreachable gateway would."""

    configured = True

    def __init__(self) -> None:
        self.calls: list[str] = []

    async def get_object(self, object_id):
        self.calls.append(object_id)
        raise RuntimeError("sui rpc unreachable")


async def test_sui_verification_is_advisory_and_never_affects_memory(
    client, monkeypatch
):
    """A broken Sui gateway must leave every memory read and write untouched."""
    from app.core import container

    verifier = RaisingVerifier()
    monkeypatch.setattr(settings, "FEATURE_TATUM_SUI", True)
    monkeypatch.setattr(container, "tatum_sui_gateway", verifier)
    user, headers, user_id = await make_user(client)

    save = await patch_memory(client, headers, {"last_search": "plumber"})
    assert save.status_code == 200, save.text
    assert "verified" not in save.json()
    assert (await read_ai_settings(user["user_id"]))["memory"] == {
        "last_search": "plumber"
    }

    async with async_session() as db:
        recall = await ai_endpoints._load_memory(db, user_id, query="fix a leak")
        await db.rollback()
    assert recall.entries == {"last_search": "plumber"}

    verification = await client.get(
        f"{MEMORY_URL}/verification",
        headers=headers,
        params={"reference": "0x" + "ab" * 32},
    )
    assert verification.status_code == 200, verification.text
    body = verification.json()
    assert body["advisory"] is True
    assert body["available"] is True
    assert body["checked"] is True
    assert body["verified"] is False
    assert body["reason"] == "verification_unavailable"
    assert verifier.calls == ["0x" + "ab" * 32]


async def test_sui_verification_endpoint_shows_no_badge_when_the_flag_is_off(
    client, monkeypatch
):
    """With the flag off the capability answers without touching the gateway."""
    from app.core import container

    verifier = RaisingVerifier()
    monkeypatch.setattr(settings, "FEATURE_TATUM_SUI", False)
    monkeypatch.setattr(container, "tatum_sui_gateway", verifier)
    _, headers, _ = await make_user(client)

    verification = await client.get(
        f"{MEMORY_URL}/verification",
        headers=headers,
        params={"reference": "0x" + "ab" * 32},
    )

    assert verification.status_code == 200, verification.text
    body = verification.json()
    assert body["available"] is False
    assert body["verified"] is False
    assert body["reason"] == "feature_disabled"
    assert verifier.calls == []
