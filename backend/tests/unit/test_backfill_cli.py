"""The CLI is the mode a person reviews first, so its promises are tested.

The database is replaced with a fake session and the fact source with fixed rows;
what is real is the flag check, the state file handling, the dry-run path and the
exit codes.
"""

import importlib.util
from pathlib import Path
from uuid import UUID

import pytest

from app.core.config import settings
from app.services.user_history_service import UserHistory

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "backfill_walrus_memory.py"

USER_ONE = UUID("11111111-1111-4111-8111-111111111111")
PREFIX = "gigr-user"


class FakeGateway:
    configured = True

    def __init__(self):
        self.calls = []

    async def remember(self, text, namespace, idempotency_key=None):
        self.calls.append(
            {"text": text, "namespace": namespace, "idempotency_key": idempotency_key}
        )
        return "job-1"


class FakeHistory:
    def __init__(self, histories):
        self._histories = histories
        self.read = []

    async def user_ids(self):
        return list(self._histories)

    async def history(self, user_id):
        self.read.append(user_id)
        return self._histories[user_id]


class FakeSession:
    async def __aenter__(self):
        return None

    async def __aexit__(self, *exc_info):
        return False


def _load_cli(monkeypatch, *, gateway, histories):
    """Import the script and replace the database behind it."""
    spec = importlib.util.spec_from_file_location("backfill_cli_under_test", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    from app.services.fact_memory_service import FactMemoryService

    monkeypatch.setattr(module, "async_session", lambda: FakeSession())
    monkeypatch.setattr(module, "UserHistoryService", lambda db: FakeHistory(histories))
    monkeypatch.setattr(
        module, "build_fact_memory_service", lambda: FactMemoryService(gateway=gateway)
    )
    return module


def _history(*facts):
    return UserHistory(
        user_id=USER_ONE,
        display_name="Bola Ade",
        sides=("client",),
        as_client=1,
        as_provider=0,
        active_listings=0,
        facts=tuple(facts),
    )


async def test_a_dry_run_prints_the_sentences_and_writes_nothing(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", False)
    gateway = FakeGateway()
    histories = {
        USER_ONE: _history(
            "Bola Ade is a client on Gigr.",
            "Bola Ade has 2 message conversations on Gigr.",
        )
    }
    cli = _load_cli(monkeypatch, gateway=gateway, histories=histories)
    state_path = tmp_path / "state.json"

    exit_code = await cli.run(["--state-file", str(state_path)])
    printed = capsys.readouterr().out

    assert exit_code == 0
    assert gateway.calls == []
    assert not state_path.exists()
    assert "mode: DRY RUN" in printed
    assert "  + Bola Ade is a client on Gigr." in printed
    assert "  + Bola Ade has 2 message conversations on Gigr." in printed
    assert "TOTAL: 1 user, 2 facts: 0 already recorded, 2 would be written" in printed
    assert "Nothing was written" in printed


async def test_apply_refuses_to_start_with_the_flag_off(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", False)
    gateway = FakeGateway()
    cli = _load_cli(
        monkeypatch,
        gateway=gateway,
        histories={USER_ONE: _history("Bola Ade is a client on Gigr.")},
    )
    state_path = tmp_path / "state.json"

    exit_code = await cli.run(["--apply", "--state-file", str(state_path)])
    printed = capsys.readouterr().out

    assert exit_code == 2
    assert "FEATURE_AGENT_WALRUS_MEMORY" in printed
    assert gateway.calls == []
    assert not state_path.exists()


async def test_apply_writes_and_a_second_run_writes_nothing_new(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)
    gateway = FakeGateway()
    histories = {USER_ONE: _history("Bola Ade is a client on Gigr.")}
    cli = _load_cli(monkeypatch, gateway=gateway, histories=histories)
    state_path = tmp_path / "state.json"

    assert await cli.run(["--apply", "--state-file", str(state_path)]) == 0
    first = capsys.readouterr().out
    assert len(gateway.calls) == 1
    assert "0 already recorded, 1 written, 0 already complete" in first

    assert await cli.run(["--apply", "--state-file", str(state_path)]) == 0
    second = capsys.readouterr().out
    assert len(gateway.calls) == 1
    assert "0 already recorded, 0 written, 1 already complete" in second


async def test_a_corrupt_state_file_stops_the_run_before_anything_is_written(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)
    gateway = FakeGateway()
    cli = _load_cli(
        monkeypatch,
        gateway=gateway,
        histories={USER_ONE: _history("Bola Ade is a client on Gigr.")},
    )
    state_path = tmp_path / "state.json"
    state_path.write_text("{not json")

    exit_code = await cli.run(["--apply", "--state-file", str(state_path)])
    printed = capsys.readouterr().out

    assert exit_code == 2
    assert "move it aside" in printed
    assert gateway.calls == []


async def test_a_pace_above_the_safe_limit_is_refused_before_the_database_opens(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)
    cli = _load_cli(monkeypatch, gateway=FakeGateway(), histories={})

    with pytest.raises(SystemExit) as raised:
        await cli.run(
            ["--apply", "--requests-per-minute", "60", "--state-file", str(tmp_path / "s")]
        )
    # argparse exits 2 for a rejected argument.
    assert raised.value.code == 2


async def test_a_write_failure_reports_where_it_stopped_and_resumes(
    tmp_path, monkeypatch, capsys
):
    monkeypatch.setattr(settings, "FEATURE_AGENT_WALRUS_MEMORY", True)

    class BrokenGateway(FakeGateway):
        async def remember(self, text, namespace, idempotency_key=None):
            await super().remember(text, namespace, idempotency_key)
            raise RuntimeError("relayer unreachable")

    cli = _load_cli(
        monkeypatch,
        gateway=BrokenGateway(),
        histories={USER_ONE: _history("Bola Ade is a client on Gigr.")},
    )
    state_path = tmp_path / "state.json"

    exit_code = await cli.run(["--apply", "--state-file", str(state_path)])
    printed = capsys.readouterr().out

    assert exit_code == 1
    assert "relayer unreachable" in printed
    assert "run the same command again" in printed
    # Nothing was accepted, so nothing was recorded and no state file exists to
    # resume from: the next run starts at the first fact, and its idempotency
    # key is the one the failed attempt used.
    assert not state_path.exists()
    assert "no progress file was written yet" in printed
