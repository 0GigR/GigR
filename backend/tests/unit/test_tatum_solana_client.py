"""Unit tests for the Tatum Solana failover in solana_client.

No network: the solana AsyncClient is replaced by a fake that records how it was
constructed. The boundary is built here with a short policy so the failover can
be exercised without waiting on the production timeout.
"""

from __future__ import annotations

import asyncio
import logging
import types

from app.core.config import settings
from app.core.resilience import Boundary, ResiliencePolicy, StructuredLogMetricSink
from app.services import solana_client

PRIMARY_RPC = "https://primary-rpc.invalid"
TATUM_RPC = "https://solana-devnet.gateway.tatum.io"
TESTNET_KEY = "tatum-testnet-key-123"
MAINNET_KEY = "tatum-mainnet-key-456"


def make_boundary(timeout: float = 0.5, attempts: int = 1) -> Boundary:
    return Boundary(
        ResiliencePolicy(
            dependency="tatum-solana-rpc",
            timeout_seconds=timeout,
            failure_threshold=2,
            reset_timeout_seconds=30.0,
            max_attempts=attempts,
            max_concurrency=1,
        ),
        StructuredLogMetricSink("tatum-solana-test"),
    )


def install_fake_client(monkeypatch, failure: BaseException | None = None, delay: float = 0.0):
    """Replace the SDK client and return every instance it constructs."""
    created: list = []

    class FakeAsyncClient:
        def __init__(
            self,
            endpoint=None,
            commitment=None,
            timeout=10.0,
            extra_headers=None,
            proxy=None,
        ):
            self.endpoint = endpoint
            self.timeout = timeout
            self.extra_headers = extra_headers
            self.closed = False
            self.slot_calls = 0
            created.append(self)

        async def get_slot(self):
            self.slot_calls += 1
            if delay:
                await asyncio.sleep(delay)
            if failure is not None:
                raise failure
            return types.SimpleNamespace(value=42)

        async def close(self):
            self.closed = True

    monkeypatch.setattr(solana_client, "AsyncClient", FakeAsyncClient)
    return created


def enable_tatum(monkeypatch, network: str = "devnet"):
    monkeypatch.setattr(settings, "FEATURE_TATUM_RPC", True)
    monkeypatch.setattr(settings, "TATUM_SOLANA_RPC_URL", TATUM_RPC)
    monkeypatch.setattr(settings, "TATUM_SOLANA_NETWORK", network)
    monkeypatch.setattr(settings, "TATUM_API_KEY_TESTNET", TESTNET_KEY)
    monkeypatch.setattr(settings, "TATUM_API_KEY_MAINNET", MAINNET_KEY)
    monkeypatch.setattr(settings, "SOLANA_RPC_URL", PRIMARY_RPC)


def disable_tatum(monkeypatch):
    monkeypatch.setattr(settings, "FEATURE_TATUM_RPC", False)
    monkeypatch.setattr(settings, "TATUM_SOLANA_RPC_URL", "")
    monkeypatch.setattr(settings, "TATUM_API_KEY_TESTNET", "")
    monkeypatch.setattr(settings, "TATUM_API_KEY_MAINNET", "")
    monkeypatch.setattr(settings, "SOLANA_RPC_URL", PRIMARY_RPC)


async def test_flag_off_builds_todays_client_and_never_probes(monkeypatch):
    """With the flag off nothing about the primary client may change."""
    disable_tatum(monkeypatch)
    created = install_fake_client(monkeypatch)

    connection = await solana_client.open_rpc_client("unit-test")

    assert connection.endpoint == PRIMARY_RPC
    assert connection.is_tatum is False
    assert len(created) == 1
    assert created[0].endpoint == PRIMARY_RPC
    assert created[0].timeout == 60
    assert created[0].extra_headers is None
    assert created[0].slot_calls == 0


async def test_flag_on_uses_the_tatum_url_and_puts_the_key_in_the_header(monkeypatch):
    """The key must travel in x-api-key, never in the endpoint."""
    enable_tatum(monkeypatch)
    created = install_fake_client(monkeypatch)

    connection = await solana_client.open_rpc_client("unit-test", boundary=make_boundary())

    assert connection.is_tatum is True
    assert connection.endpoint == TATUM_RPC
    assert TESTNET_KEY not in connection.endpoint

    probe, real = created
    assert probe.endpoint == TATUM_RPC
    assert probe.extra_headers == {"x-api-key": TESTNET_KEY}
    assert probe.timeout == settings.TATUM_RPC_TIMEOUT_SECONDS
    assert probe.slot_calls == 1
    assert probe.closed is True
    assert real.endpoint == TATUM_RPC
    assert real.extra_headers == {"x-api-key": TESTNET_KEY}
    assert real.timeout == 60
    assert TESTNET_KEY not in repr(connection)


async def test_mainnet_network_pairs_the_mainnet_key(monkeypatch):
    """The network decides the key; the URL is never used to guess it."""
    enable_tatum(monkeypatch, network="mainnet")
    created = install_fake_client(monkeypatch)

    await solana_client.open_rpc_client("unit-test", boundary=make_boundary())

    assert created[0].extra_headers == {"x-api-key": MAINNET_KEY}


async def test_a_failed_tatum_probe_falls_back_to_the_primary_rpc_once(
    monkeypatch, caplog
):
    """Any failure must produce exactly one primary client and one fallback log."""
    caplog.set_level(logging.DEBUG)
    enable_tatum(monkeypatch)
    created = install_fake_client(monkeypatch, failure=RuntimeError("gateway down"))

    connection = await solana_client.open_rpc_client("unit-test", boundary=make_boundary())

    assert connection.is_tatum is False
    assert connection.endpoint == PRIMARY_RPC
    assert [client.endpoint for client in created] == [TATUM_RPC, PRIMARY_RPC]
    assert created[0].slot_calls == 1
    assert created[0].closed is True
    assert created[1].timeout == 60
    assert created[1].extra_headers is None
    assert "fell back to SOLANA_RPC_URL" in caplog.text


async def test_a_timed_out_tatum_probe_falls_back_within_the_short_window(monkeypatch):
    """A hanging gateway must be abandoned at the configured short timeout."""
    enable_tatum(monkeypatch)
    install_fake_client(monkeypatch, delay=5)
    boundary = make_boundary(timeout=0.05)

    started = asyncio.get_running_loop().time()
    connection = await solana_client.open_rpc_client("unit-test", boundary=boundary)
    elapsed = asyncio.get_running_loop().time() - started

    assert connection.is_tatum is False
    assert connection.endpoint == PRIMARY_RPC
    assert elapsed < 1.5


async def test_fallback_log_never_contains_the_api_key(monkeypatch, caplog):
    """An error that echoes the key must be redacted before it is logged."""
    caplog.set_level(logging.DEBUG)
    enable_tatum(monkeypatch)
    install_fake_client(
        monkeypatch, failure=RuntimeError(f"rejected header x-api-key={TESTNET_KEY}")
    )

    await solana_client.open_rpc_client("unit-test", boundary=make_boundary())

    assert TESTNET_KEY not in caplog.text
    assert "[redacted]" in caplog.text
