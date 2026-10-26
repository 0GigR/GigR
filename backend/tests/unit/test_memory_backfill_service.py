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
from app.core.errors import DependencyUnavailableError
from app.core.gateways.walrus_memory_gateway import RecalledMemory
from app.services.fact_memory_service import (
    ALREADY_STORED,
    VERIFY_RECALL_LIMIT,
    FactMemoryService,
)
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
    """The relayer as the write path sees it: remember, and the verify recall.

    A successful write is kept in the namespace it was sent to, so a later
    recall answers the way the relayer would. ``fail_texts`` makes a write fail
    every time it is attempted, which is an unreachable relayer rather than one
    that stored the fact.
    """

    configured = True

    def __init__(self, fail_texts=()):
        self.calls = []
        self.recall_calls = []
        self.fail_texts = set(fail_texts)
        self.stored = {}

    async def remember(self, text, namespace, idempotency_key=None):
        self.calls.append(
            {"text": text, "namespace": namespace, "idempotency_key": idempotency_key}
        )
        if text in self.fail_texts:
            raise RuntimeError("relayer unreachable")
        self.stored.setdefault(namespace, []).append(text)
        return "job-1"

    async def recall(self, query, namespace, limit):
        self.recall_calls.append(
            {"query": query, "namespace": namespace, "limit": limit}
        )
        return tuple(
            RecalledMemory(text=text, score=None, created_at=None)
            for text in self.stored.get(namespace, [])
        )


class FakeHistory:
    """The fact source behind one database session, as the CLI opens it.

    Calling the instance opens a fresh session around the same rows, the way the
    script opens one per read. ``fail_for`` makes one user's read fail the way a
    connection the pooler closed does. The counters are what a test uses to see
    that a session was opened per user and closed before the writes.
    """

    def __init__(self, histories, fail_for=()):
        self._histories = histories
        self._fail_for = set(fail_for)
        self.read = []
        self.opened = 0
        self.closed = 0
        self.live = 0
        self.max_live = 0

    def __call__(self):
        self.opened += 1
        return _Session(self)

    async def user_ids(self):
        return list(self._histories)

    async def history(self, user_id):
        self.read.append(user_id)
        if user_id in self._fail_for:
            raise ConnectionError(
                "connection was closed in the middle of operation"
            )
        return self._histories[user_id]


class _Session:
    """One opened session; entering and leaving it is counted by the source."""

    def __init__(self, history):
        self._history = history

    async def __aenter__(self):
        self._history.live += 1
        self._history.max_live = max(self._history.max_live, self._history.live)
        return self._history

    async def __aexit__(self, *exc_info):
        self._history.live -= 1
        self._history.closed += 1
        return False


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
        open_history=history,
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
            USER_ONE: _history(USER_ONE, "Bola Ade", "Bola Ade is based in Yaba, Lagos.", "Bola Ade has 2 message conversations on Gigr."),
            USER_TWO: _history(USER_TWO, "Kemi Bello", "Kemi Bello is based in Ikeja, Lagos."),
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
    first_fact = "Bola Ade is based in Yaba, Lagos."
    second_fact = "Bola Ade has 2 message conversations on Gigr."
    other_user_fact = "Kemi Bello is based in Ikeja, Lagos."
    histories = {
        USER_ONE: _history(USER_ONE, "Bola Ade", first_fact, second_fact),
        USER_TWO: _history(USER_TWO, "Kemi Bello", other_user_fact),
    }

    # The relayer refuses the second fact every time, so the first user stays
    # half done while the run still finishes the second user.
    killed = FakeGateway(fail_texts={second_fact})
    report = await _service(state_path, FakeHistory(histories), killed).run(
        dry_run=False
    )

    assert report.users_failed == 1
    recorded = BackfillState.load(str(state_path), PREFIX)
    assert len(recorded.written_keys(USER_ONE)) == 1
    assert recorded.is_complete(USER_ONE) is False
    assert recorded.is_complete(USER_TWO) is True
    assert recorded.written_keys(USER_TWO) == {
        FactMemoryService(gateway=None).plan(USER_TWO, [other_user_fact])[0].key
    }

    resumed_gateway = FakeGateway()
    report = await _service(state_path, FakeHistory(histories), resumed_gateway).run(
        dry_run=False
    )

    assert report.facts_recorded == 1
    assert report.facts_written == 1
    assert [call["text"] for call in resumed_gateway.calls] == [second_fact]
    # The failed fact was attempted, verified by recall, then attempted again:
    # two attempts, one idempotency key, so the relayer still collapses them.
    attempted = [
        call for call in killed.calls if call["text"] == second_fact
    ]
    assert len(attempted) == 2
    assert len({call["idempotency_key"] for call in attempted}) == 1
    # The user that finished was not read or written again.
    assert [call["text"] for call in resumed_gateway.calls] == [second_fact]


async def test_a_500_whose_fact_was_already_stored_is_recorded_in_the_state(
    tmp_path, monkeypatch
):
    """The state file is what stops the next run from asking again.

    A write whose 500 hid a successful persist is treated as succeeded, so the
    fact must be recorded and the user marked complete, exactly as if the
    acknowledgement had arrived.
    """
    _enable(monkeypatch)
    state_path = tmp_path / "state.json"
    fact = "Bola Ade is based in Yaba, Lagos."
    gateway = ServerErrorGateway(stored=[fact])

    report = await _service(
        state_path,
        FakeHistory({USER_ONE: _history(USER_ONE, "Bola Ade", fact)}),
        gateway,
    ).run(dry_run=False)

    assert [call["text"] for call in gateway.calls] == [fact]
    assert report.users_failed == 0
    assert report.facts_written == 1
    state = BackfillState.load(str(state_path), PREFIX)
    assert state.is_complete(USER_ONE) is True
    assert state.written_keys(USER_ONE) == {
        FactMemoryService(gateway=None).plan(USER_ONE, [fact])[0].key
    }


async def test_a_connection_error_on_one_user_does_not_stop_the_run(
    tmp_path, monkeypatch
):
    """The run died part-way on a pooled connection the server had closed.

    One user's read failing must leave that user incomplete and let the run
    finish the rest, instead of abandoning everyone behind them.
    """
    _enable(monkeypatch)
    state_path = tmp_path / "state.json"
    failed_user_fact = "Bola Ade is based in Yaba, Lagos."
    other_user_fact = "Kemi Bello is based in Ikeja, Lagos."
    histories = {
        USER_ONE: _history(USER_ONE, "Bola Ade", failed_user_fact),
        USER_TWO: _history(USER_TWO, "Kemi Bello", other_user_fact),
    }
    gateway = FakeGateway()
    lines = []

    report = await _service(
        state_path,
        FakeHistory(histories, fail_for={USER_ONE}),
        gateway,
        emit=lines.append,
    ).run(dry_run=False)

    assert report.users == 2
    assert report.users_failed == 1
    assert [call["text"] for call in gateway.calls] == [other_user_fact]
    assert any("connection was closed in the middle of operation" in line for line in lines)
    state = BackfillState.load(str(state_path), PREFIX)
    assert state.is_complete(USER_ONE) is False
    assert state.written_keys(USER_ONE) == set()
    assert state.is_complete(USER_TWO) is True


async def test_a_user_left_by_a_connection_error_resumes_on_the_next_run(
    tmp_path, monkeypatch
):
    _enable(monkeypatch)
    state_path = tmp_path / "state.json"
    failed_user_fact = "Bola Ade is based in Yaba, Lagos."
    other_user_fact = "Kemi Bello is based in Ikeja, Lagos."
    histories = {
        USER_ONE: _history(USER_ONE, "Bola Ade", failed_user_fact),
        USER_TWO: _history(USER_TWO, "Kemi Bello", other_user_fact),
    }

    first = await _service(
        state_path, FakeHistory(histories, fail_for={USER_ONE}), FakeGateway()
    ).run(dry_run=False)
    assert first.users_failed == 1

    resumed_gateway = FakeGateway()
    second = await _service(
        state_path, FakeHistory(histories), resumed_gateway
    ).run(dry_run=False)

    assert second.users_failed == 0
    assert second.users_complete == 1
    assert second.facts_written == 1
    assert [call["text"] for call in resumed_gateway.calls] == [failed_user_fact]
    assert BackfillState.load(str(state_path), PREFIX).is_complete(USER_ONE) is True


async def test_each_user_is_read_through_its_own_closed_session(
    tmp_path, monkeypatch
):
    """One session for the user list and one per user, each closed before the
    next: a session held for the whole run is a connection the pooler closes
    underneath it, and no session may be open while a fact is written."""
    _enable(monkeypatch)
    state_path = tmp_path / "state.json"
    histories = {
        USER_ONE: _history(USER_ONE, "Bola Ade", "Bola Ade is based in Yaba, Lagos."),
        USER_TWO: _history(USER_TWO, "Kemi Bello", "Kemi Bello is based in Ikeja, Lagos."),
    }
    history = FakeHistory(histories)
    live_at_write = []

    class ObservingGateway(FakeGateway):
        async def remember(self, text, namespace, idempotency_key=None):
            live_at_write.append(history.live)
            return await super().remember(text, namespace, idempotency_key)

    report = await _service(state_path, history, ObservingGateway()).run(
        dry_run=False
    )

    assert report.facts_written == 2
    # One read for the user list, one for each user.
    assert history.opened == 3
    assert history.closed == 3
    # Never two sessions at once, and none held during a Walrus write.
    assert history.max_live == 1
    assert live_at_write == [0, 0]


async def test_a_dry_run_writes_nothing_at_all(tmp_path, monkeypatch):
    _enable(monkeypatch)
    state_path = tmp_path / "state.json"
    gateway = FakeGateway()
    history = FakeHistory(
        {USER_ONE: _history(USER_ONE, "Bola Ade", "Bola Ade is based in Yaba, Lagos.")}
    )
    lines = []

    report = await _service(
        state_path, history, gateway, emit=lines.append
    ).run(dry_run=True)

    assert gateway.calls == []
    assert not os.path.exists(state_path)
    assert report.facts_written == 0
    assert report.facts_total == 1
    assert "  + Bola Ade is based in Yaba, Lagos." in lines
    assert any(
        "Bola Ade (1 posted, 0 hired, 0 active listings)" in line
        for line in lines
    )


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
                "Bola Ade is based in Yaba, Lagos.",
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
        {USER_ONE: _history(USER_ONE, "Bola Ade", "Bola Ade is based in Yaba, Lagos.")}
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
        FakeHistory({USER_ONE: _history(USER_ONE, "Bola Ade", "Bola Ade is based in Yaba, Lagos.")}),
        FakeGateway(),
        emit=lines.append,
    ).run(dry_run=True)

    assert report.facts_total == 1
    assert "  + Bola Ade is based in Yaba, Lagos." in lines


async def test_every_fact_goes_to_that_users_own_namespace(tmp_path, monkeypatch):
    _enable(monkeypatch)
    state_path = tmp_path / "state.json"
    gateway = FakeGateway()
    history = FakeHistory(
        {
            USER_ONE: _history(USER_ONE, "Bola Ade", "Bola Ade is based in Yaba, Lagos."),
            USER_TWO: _history(USER_TWO, "Kemi Bello", "Kemi Bello is based in Ikeja, Lagos."),
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
        FakeHistory({USER_ONE: _history(USER_ONE, "Bola Ade", "Bola Ade is based in Yaba, Lagos.")}),
        FakeGateway(),
    ).run(dry_run=False)

    payload = json.loads(state_path.read_text())
    assert payload["namespace_prefix"] == PREFIX
    assert payload["version"] == 1
    assert payload["users"][str(USER_ONE)]["completed"] is True
    assert list(payload["users"][str(USER_ONE)]["facts"].values()) == [
        "Bola Ade is based in Yaba, Lagos."
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
    state.record(USER_ONE, "key-1", "Bola Ade is based in Yaba, Lagos.")
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
            USER_ONE, "Bola Ade", "Bola Ade is based in Yaba, Lagos.", "Bola Ade has sent 3 messages."
        )
    }
    await _service(state_path, FakeHistory(histories), FakeGateway()).run(dry_run=False)

    # A sentence that changed gets a new key, so a second review sees one
    # recorded fact and one that would be written.
    histories[USER_ONE] = _history(
        USER_ONE,
        "Bola Ade",
        "Bola Ade is based in Yaba, Lagos.",
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
    writes = memory.plan(USER_ONE, ["A is based in Yaba.", "A is based in Yaba."])
    assert len(writes) == 1
    assert writes[0].idempotency_key == memory.plan(
        USER_ONE, ["A is based in Yaba."]
    )[0].idempotency_key


def test_a_fact_identity_does_not_depend_on_the_run(monkeypatch):
    """The key is derived from the sentence, so two processes agree on it."""
    memory = FactMemoryService(gateway=None)
    first = memory.plan(USER_ONE, ["Bola Ade is based in Yaba, Lagos."])[0]
    second = FactMemoryService(gateway=None).plan(
        USER_ONE, ["Bola Ade is based in Yaba, Lagos."]
    )[0]
    assert (first.key, first.idempotency_key) == (
        second.key,
        second.idempotency_key,
    )
    # And a different user's identical sentence is a different relayer write.
    other = memory.plan(USER_TWO, ["Bola Ade is based in Yaba, Lagos."])[0]
    assert other.idempotency_key != first.idempotency_key


FACT = "Bola Ade is based in Yaba, Lagos."


class ServerErrorGateway:
    """A relayer that answers 500 after it may already have stored the write.

    ``stored`` is what the namespace already holds, which is what a 500 after a
    successful persist looks like from this side. ``errors`` is how many writes
    fail before one is acknowledged.
    """

    configured = True

    def __init__(self, stored=(), errors=1, verifiable=True):
        self.stored = list(stored)
        self.errors = errors
        self.verifiable = verifiable
        self.calls = []
        self.recall_calls = []

    async def remember(self, text, namespace, idempotency_key=None):
        self.calls.append(
            {"text": text, "namespace": namespace, "idempotency_key": idempotency_key}
        )
        if self.errors:
            self.errors -= 1
            raise DependencyUnavailableError(
                "walrus-memory",
                "remember failed: HTTPStatusError: Server error '500 Internal Server Error'",
            )
        self.stored.append(text)
        return "job-1"

    async def recall(self, query, namespace, limit):
        self.recall_calls.append(
            {"query": query, "namespace": namespace, "limit": limit}
        )
        if not self.verifiable:
            raise DependencyUnavailableError("walrus-memory", "recall failed")
        return tuple(
            RecalledMemory(text=text, score=None, created_at=None)
            for text in self.stored
        )


async def test_a_500_whose_fact_already_landed_is_not_written_again():
    """A server error does not prove the write was lost; the relayer may have
    stored the fact and then failed the response. Recalling the exact text in
    the user's namespace must stop the second write."""
    gateway = ServerErrorGateway(stored=[FACT])
    writer = FactMemoryService(gateway=gateway)
    write = writer.plan(USER_ONE, [FACT])[0]

    result = await writer.write(USER_ONE, write)

    assert result == ALREADY_STORED
    assert [call["text"] for call in gateway.calls] == [FACT]
    assert gateway.recall_calls == [
        {
            "query": FACT,
            "namespace": f"{PREFIX}-{USER_ONE}",
            "limit": VERIFY_RECALL_LIMIT,
        }
    ]


async def test_a_500_whose_fact_is_absent_is_written_again_with_the_same_key():
    """Only a recall that proves absence may lead to a second write, and that
    write must reuse the namespace-scoped idempotency key."""
    gateway = ServerErrorGateway()
    writer = FactMemoryService(gateway=gateway)
    write = writer.plan(USER_ONE, [FACT])[0]

    result = await writer.write(USER_ONE, write)

    assert result == "job-1"
    assert [call["text"] for call in gateway.calls] == [FACT, FACT]
    assert [call["idempotency_key"] for call in gateway.calls] == [
        write.idempotency_key,
        write.idempotency_key,
    ]
    assert gateway.stored == [FACT]


async def test_a_500_that_cannot_be_verified_is_not_written_again():
    """An unanswerable recall is not evidence of absence: writing again on it is
    how a duplicate is made, so the original failure is reported instead."""
    gateway = ServerErrorGateway(verifiable=False)
    writer = FactMemoryService(gateway=gateway)
    write = writer.plan(USER_ONE, [FACT])[0]

    with pytest.raises(DependencyUnavailableError):
        await writer.write(USER_ONE, write)

    assert [call["text"] for call in gateway.calls] == [FACT]
