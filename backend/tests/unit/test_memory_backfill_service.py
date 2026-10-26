"""The backfill is idempotent, resumable, paced, and inert without the flag.

The gateway, the fact source and the clock are fakes; the state machine, the
pacing arithmetic and the flag check are the real ones. Each test is written so
that removing the guard it covers makes it fail: the recorded-key skip for
idempotency, the per-write save for resumability, the pacer call for the rate,
the dry-run branch for the no-write promise, and the enabled check for the flag.
"""

import json
import os
from uuid import UUID

import pytest

from app.core.config import settings
from app.services.fact_memory_service import FactMemoryService
from app.services.memory_backfill_service import (
    MAX_REQUESTS_PER_MINUTE,
    BackfillState,
    MemoryBackfillService,
    Pacer,
)
from app.services.user_history_service import UserHistory

USER_ONE = UUID("11111111-1111-4111-8111-111111111111")
USER_TWO = UUID("22222222-2222-4222-8222-222222222222")
PREFIX = "gigr-user"


class FakeGateway:
    """The one gateway method a write goes through."""

    configured = True

    def __init__(self, fail_on_call=None):
        self.calls = []
        self.fail_on_call = fail_on_call

    async def remember(self, text, namespace, idempotency_key=None):
        self.calls.append(
            {"text": text, "namespace": namespace, "idempotency_key": idempotency_key}
        )
        if self.fail_on_call is not None and len(self.calls) == self.fail_on_call:
            raise RuntimeError("relayer unreachable")
        return "job-1"


class FakeHistory:
    """The fact source: what the database behind UserHistoryService would give."""

    def __init__(self, histories):
        self._histories = histories
        self.read = []

    async def user_ids(self):
        return list(self._histories)

    async def history(self, user_id):
        self.read.append(user_id)
        return self._histories[user_id]


class FakeClock:
    """A clock that only moves when the code under test sleeps."""

    def __init__(self):
        self.value = 0.0

    def now(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


def _history(user_id, display_name, *facts):
    return UserHistory(
        user_id=user_id,
        display_name=display_name,
        sides=("client",),
        as_client=1,
        as_provider=0,
        active_listings=0,
        facts=tuple(facts),
    )


def _enable(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)


def _disable(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", False)


async def _no_sleep(seconds):
    """The tests that are not about pacing must not spend its three seconds."""
    return None


def _service(state_path, history, gateway, **overrides):
    overrides.setdefault("sleep", _no_sleep)
    return MemoryBackfillService(
        history=history,
        memory=FactMemoryService(gateway=gateway),
        namespace_prefix=PREFIX,
        state=BackfillState.load(str(state_path), PREFIX),
        emit=overrides.pop("emit", lambda line: None),
        **overrides,
    )


async def test_a_second_run_writes_nothing_new(tmp_path, monkeypatch):
    _enable(monkeypatch)
    state_path = tmp_path / "state.json"
    gateway = FakeGateway()
    history = FakeHistory(
        {
            USER_ONE: _history(USER_ONE, "Bola Ade", "Bola Ade is a client on Gigr.", "Bola Ade has 2 message conversations on Gigr."),
            USER_TWO: _history(USER_TWO, "Kemi Bello", "Kemi Bello is a client on Gigr."),
        }
    )

    first = await _service(state_path, history, gateway).run(dry_run=False)
    assert first.facts_written == 3
    assert len(gateway.calls) == 3

    second_gateway = FakeGateway()
    second_history = FakeHistory({USER_ONE: None, USER_TWO: None})
    second = await _service(state_path, second_history, second_gateway).run(dry_run=False)

    assert second.facts_written == 0
    assert second.facts_total == 0
    assert second.users == 2
    assert second.users_complete == 2
    assert second_gateway.calls == []
    # A completed user is skipped without even reading their rows again.
    assert second_history.read == []


async def test_a_killed_run_resumes_without_writing_a_fact_twice(tmp_path, monkeypatch):
    _enable(monkeypatch)
    state_path = tmp_path / "state.json"
    histories = {
        USER_ONE: _history(
            USER_ONE, "Bola Ade", "Bola Ade is a client on Gigr.", "Bola Ade has 2 message conversations on Gigr."
        ),
        USER_TWO: _history(USER_TWO, "Kemi Bello", "Kemi Bello is a client on Gigr."),
    }

    # The run dies on the second fact, so the first user is half done.
    killed = FakeGateway(fail_on_call=2)
    with pytest.raises(RuntimeError):
        await _service(state_path, FakeHistory(histories), killed).run(dry_run=False)

    assert len(killed.calls) == 2
    recorded = BackfillState.load(str(state_path), PREFIX)
    assert len(recorded.written_keys(USER_ONE)) == 1
    assert recorded.is_complete(USER_ONE) is False
    assert recorded.is_complete(USER_TWO) is False
    assert recorded.written_keys(USER_TWO) == set()

    resumed_gateway = FakeGateway()
    report = await _service(state_path, FakeHistory(histories), resumed_gateway).run(
        dry_run=False
    )

    assert report.facts_recorded == 1
    assert report.facts_written == 2
    assert [call["text"] for call in resumed_gateway.calls] == [
        "Bola Ade has 2 message conversations on Gigr.",
        "Kemi Bello is a client on Gigr.",
    ]
    # The write that failed is retried, because its acknowledgement never
    # arrived and the state file cannot claim it landed. Retrying it is safe
    # only because the two attempts carry the same idempotency key, which is
    # what the relayer collapses on: no sentence reaches the store twice.
    calls = killed.calls + resumed_gateway.calls
    retried = "Bola Ade has 2 message conversations on Gigr."
    assert [call["text"] for call in calls].count(retried) == 2
    keys_for_retry = {
        call["idempotency_key"] for call in calls if call["text"] == retried
    }
    assert len(keys_for_retry) == 1
    # Three distinct facts, three distinct keys, whatever the retry did.
    assert len({call["idempotency_key"] for call in calls}) == 3
    assert len({call["text"] for call in calls}) == 3


async def test_a_dry_run_writes_nothing_at_all(tmp_path, monkeypatch):
    _enable(monkeypatch)
    state_path = tmp_path / "state.json"
    gateway = FakeGateway()
    history = FakeHistory(
        {USER_ONE: _history(USER_ONE, "Bola Ade", "Bola Ade is a client on Gigr.")}
    )
    lines = []

    report = await _service(
        state_path, history, gateway, emit=lines.append
    ).run(dry_run=True)

    assert gateway.calls == []
    assert not os.path.exists(state_path)
    assert report.facts_written == 0
    assert report.facts_total == 1
    assert "  + Bola Ade is a client on Gigr." in lines
    assert any("Bola Ade (client:" in line for line in lines)


async def test_the_pace_waits_the_interval_between_writes(tmp_path, monkeypatch):
    _enable(monkeypatch)
    state_path = tmp_path / "state.json"
    clock = FakeClock()
    sleeps = []

    async def fake_sleep(seconds):
        sleeps.append(seconds)
        clock.advance(seconds)

    gateway = FakeGateway()
    history = FakeHistory(
        {
            USER_ONE: _history(
                USER_ONE,
                "Bola Ade",
                "Bola Ade is a client on Gigr.",
                "Bola Ade has 2 message conversations on Gigr.",
                "Bola Ade has sent 3 messages.",
            )
        }
    )
    report = await _service(
        state_path,
        history,
        gateway,
        requests_per_minute=30,
        sleep=fake_sleep,
        clock=clock.now,
    ).run(dry_run=False)

    assert report.facts_written == 3
    # Thirty requests a minute is one every two seconds, and nothing is waited
    # for before the first write.
    assert sleeps == [2.0, 2.0]


async def test_a_pace_at_or_above_the_relayer_budget_is_refused():
    with pytest.raises(ValueError):
        Pacer(MAX_REQUESTS_PER_MINUTE + 1)
    with pytest.raises(ValueError):
        Pacer(0)


async def test_the_refused_pace_message_names_the_limit():
    with pytest.raises(ValueError) as raised:
        Pacer(60)
    assert "between 1 and 55" in str(raised.value)


async def test_apply_refuses_to_write_when_the_flag_is_off(tmp_path, monkeypatch):
    _disable(monkeypatch)
    state_path = tmp_path / "state.json"
    gateway = FakeGateway()
    history = FakeHistory(
        {USER_ONE: _history(USER_ONE, "Bola Ade", "Bola Ade is a client on Gigr.")}
    )

    with pytest.raises(RuntimeError):
        await _service(state_path, history, gateway).run(dry_run=False)

    assert gateway.calls == []
    assert not os.path.exists(state_path)
    assert history.read == []


async def test_a_dry_run_still_works_with_the_flag_off(tmp_path, monkeypatch):
    _disable(monkeypatch)
    state_path = tmp_path / "state.json"
    lines = []
    report = await _service(
        state_path,
        FakeHistory({USER_ONE: _history(USER_ONE, "Bola Ade", "Bola Ade is a client on Gigr.")}),
        FakeGateway(),
        emit=lines.append,
    ).run(dry_run=True)

    assert report.facts_total == 1
    assert "  + Bola Ade is a client on Gigr." in lines


async def test_every_fact_goes_to_that_users_own_namespace(tmp_path, monkeypatch):
    _enable(monkeypatch)
    state_path = tmp_path / "state.json"
    gateway = FakeGateway()
    history = FakeHistory(
        {
            USER_ONE: _history(USER_ONE, "Bola Ade", "Bola Ade is a client on Gigr."),
            USER_TWO: _history(USER_TWO, "Kemi Bello", "Kemi Bello is a client on Gigr."),
        }
    )
    await _service(state_path, history, gateway).run(dry_run=False)

    assert [call["namespace"] for call in gateway.calls] == [
        f"{PREFIX}-{USER_ONE}",
        f"{PREFIX}-{USER_TWO}",
    ]


async def test_a_user_whose_history_is_gone_is_counted_and_skipped(
    tmp_path, monkeypatch
):
    _enable(monkeypatch)
    state_path = tmp_path / "state.json"
    gateway = FakeGateway()
    history = FakeHistory({USER_ONE: None})

    report = await _service(state_path, history, gateway).run(dry_run=False)

    assert report.users_missing == 1
    assert report.facts_written == 0
    assert gateway.calls == []


async def test_the_state_file_records_the_namespace_prefix(tmp_path, monkeypatch):
    _enable(monkeypatch)
    state_path = tmp_path / "state.json"
    await _service(
        state_path,
        FakeHistory({USER_ONE: _history(USER_ONE, "Bola Ade", "Bola Ade is a client on Gigr.")}),
        FakeGateway(),
    ).run(dry_run=False)

    payload = json.loads(state_path.read_text())
    assert payload["namespace_prefix"] == PREFIX
    assert payload["version"] == 1
    assert payload["users"][str(USER_ONE)]["completed"] is True
    assert list(payload["users"][str(USER_ONE)]["facts"].values()) == [
        "Bola Ade is a client on Gigr."
    ]


def test_a_state_file_for_another_prefix_is_refused(tmp_path):
    state_path = tmp_path / "state.json"
    state_path.write_text(
        json.dumps(
            {"version": 1, "namespace_prefix": "other-prefix", "users": {}}
        )
    )
    with pytest.raises(ValueError) as raised:
        BackfillState.load(str(state_path), PREFIX)
    assert "different namespaces" in str(raised.value)


def test_a_corrupt_state_file_is_refused_instead_of_replaced(tmp_path):
    state_path = tmp_path / "state.json"
    state_path.write_text("{not json")
    with pytest.raises(ValueError) as raised:
        BackfillState.load(str(state_path), PREFIX)
    assert "move it aside" in str(raised.value)


def test_a_state_file_from_an_unknown_version_is_refused(tmp_path):
    state_path = tmp_path / "state.json"
    state_path.write_text(json.dumps({"version": 99, "users": {}}))
    with pytest.raises(ValueError):
        BackfillState.load(str(state_path), PREFIX)


def test_the_state_is_saved_atomically_and_leaves_no_temporary_file(tmp_path):
    state_path = tmp_path / "nested" / "state.json"
    state = BackfillState.load(str(state_path), PREFIX)
    state.record(USER_ONE, "key-1", "Bola Ade is a client on Gigr.")
    state.complete(USER_ONE)
    state.save()

    assert state_path.exists()
    assert not os.path.exists(f"{state_path}.tmp")
    assert BackfillState.load(str(state_path), PREFIX).is_complete(USER_ONE)


async def test_the_report_counts_what_a_dry_run_would_write(tmp_path, monkeypatch):
    _enable(monkeypatch)
    state_path = tmp_path / "state.json"
    histories = {
        USER_ONE: _history(
            USER_ONE, "Bola Ade", "Bola Ade is a client on Gigr.", "Bola Ade has sent 3 messages."
        )
    }
    await _service(state_path, FakeHistory(histories), FakeGateway()).run(dry_run=False)

    # A sentence that changed gets a new key, so a second review sees one
    # recorded fact and one that would be written.
    histories[USER_ONE] = _history(
        USER_ONE,
        "Bola Ade",
        "Bola Ade is a client on Gigr.",
        "Bola Ade has sent 4 messages.",
    )
    report = await _service(
        state_path, FakeHistory(histories), FakeGateway()
    ).run(dry_run=True)

    assert report.facts_total == 2
    assert report.facts_recorded == 1
    assert report.facts_written == 0


def test_the_default_pace_is_well_under_the_relayer_budget():
    assert Pacer().interval_seconds == 3.0


def test_the_namespace_is_the_agent_memory_namespace(monkeypatch):
    monkeypatch.setattr(settings, "MEMWAL_NAMESPACE_PREFIX", "gigr-user")
    memory = FactMemoryService(gateway=None)
    assert memory.namespace(USER_ONE) == f"gigr-user-{USER_ONE}"


def test_a_repeated_fact_is_planned_once():
    memory = FactMemoryService(gateway=None)
    writes = memory.plan(USER_ONE, ["A is a client on Gigr.", "A is a client on Gigr."])
    assert len(writes) == 1
    assert writes[0].idempotency_key == memory.plan(
        USER_ONE, ["A is a client on Gigr."]
    )[0].idempotency_key


def test_a_fact_identity_does_not_depend_on_the_run(monkeypatch):
    """The key is derived from the sentence, so two processes agree on it."""
    memory = FactMemoryService(gateway=None)
    first = memory.plan(USER_ONE, ["Bola Ade is a client on Gigr."])[0]
    second = FactMemoryService(gateway=None).plan(
        USER_ONE, ["Bola Ade is a client on Gigr."]
    )[0]
    assert (first.key, first.idempotency_key) == (
        second.key,
        second.idempotency_key,
    )
    # And a different user's identical sentence is a different relayer write.
    other = memory.plan(USER_TWO, ["Bola Ade is a client on Gigr."])[0]
    assert other.idempotency_key != first.idempotency_key
