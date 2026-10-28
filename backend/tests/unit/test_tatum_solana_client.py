"""Unit tests for the Tatum Solana split: Tatum serves reads, never writes.

No network: the solana AsyncClient is replaced by a fake that records how it was
constructed and which endpoint answered. The boundary is built here with a short
policy so the failover can be exercised without waiting on the production
timeout.

The property these tests exist for is structural: get_account_info and
get_latest_blockhash may reach the gateway, send_transaction may not, and a
gateway failure must fall back to SOLANA_RPC_URL exactly once.
"""

from __future__ import annotations

import asyncio
import logging
import types

from app.core.config import Settings, settings
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


def install_fake_client(
    monkeypatch,
    tatum_failure: BaseException | None = None,
    tatum_delay: float = 0.0,
):
    """Replace the SDK client and return every instance it constructs.

    Every answer carries the endpoint that produced it, so a test can tell which
    RPC actually served a call instead of trusting the code under test.
    """
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
            self.calls: list[str] = []
            created.append(self)

        @property
        def is_tatum(self) -> bool:
            return self.endpoint == TATUM_RPC

        async def _maybe_fail(self) -> None:
            if self.is_tatum and tatum_delay:
                await asyncio.sleep(tatum_delay)
            if self.is_tatum and tatum_failure is not None:
                raise tatum_failure

        async def get_account_info(self, pubkey):
            self.calls.append("get_account_info")
            await self._maybe_fail()
            return types.SimpleNamespace(
                value=types.SimpleNamespace(endpoint=self.endpoint, pubkey=pubkey)
            )

        async def get_latest_blockhash(self):
            self.calls.append("get_latest_blockhash")
            await self._maybe_fail()
            return types.SimpleNamespace(
                value=types.SimpleNamespace(blockhash=f"hash-from-{self.endpoint}")
            )

        async def send_transaction(self, tx, opts=None):
            self.calls.append("send_transaction")
            await self._maybe_fail()
            return types.SimpleNamespace(value=f"sig@{self.endpoint}")

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


def routed(primary, boundary=None) -> solana_client.RoutedRpcClient:
    return solana_client.RoutedRpcClient(
        "unit-test", primary, boundary=boundary or make_boundary()
    )


# -- Config defaults: Tatum reads with no .env change -------------------------


def test_reads_are_on_by_default_and_point_at_the_devnet_gateway():
    """No new environment variable is needed for Tatum reads.

    The default of the field is what a deployment without a FEATURE_TATUM_RPC
    or TATUM_SOLANA_RPC_URL entry gets, which is the whole point of the change.
    """
    assert Settings.model_fields["FEATURE_TATUM_RPC"].default is True
    assert (
        Settings.model_fields["TATUM_SOLANA_RPC_URL"].default
        == "https://solana-devnet.gateway.tatum.io"
    )
    assert Settings.model_fields["FEATURE_TATUM_SUI"].default is False


# -- Writes never go to Tatum -------------------------------------------------


def test_open_write_client_is_the_primary_even_with_tatum_enabled(monkeypatch):
    """The escrow provider's client. It must not depend on the Tatum flag."""
    enable_tatum(monkeypatch)
    created = install_fake_client(monkeypatch)

    client = solana_client.open_write_client("load_program")

    assert client.endpoint == PRIMARY_RPC
    assert client.timeout == 60
    assert client.extra_headers is None
    assert [fake.endpoint for fake in created] == [PRIMARY_RPC]


async def test_send_transaction_never_reaches_tatum_even_when_a_read_does(
    monkeypatch,
):
    """The decisive test: Tatum is provably live for reads, and the send still
    goes to SOLANA_RPC_URL.

    A read first, so the test cannot pass vacuously by Tatum being disabled: the
    Tatum client has to exist and answer before the send is made. Then the send
    must leave on the primary and construct no new client at all.
    """
    enable_tatum(monkeypatch)
    created = install_fake_client(monkeypatch)
    primary = solana_client.open_write_client("unit-test")
    client = routed(primary)

    info = await client.get_account_info("account")
    assert info.value.endpoint == TATUM_RPC
    assert any(fake.endpoint == TATUM_RPC for fake in created)

    before = len(created)
    sent = await client.send_transaction("tx", opts=None)

    assert sent.value == f"sig@{PRIMARY_RPC}"
    assert len(created) == before
    assert [call for call in primary.calls] == ["send_transaction"]
    assert not any(fake.is_tatum and "send_transaction" in fake.calls for fake in created)


# -- Reads: Tatum first, one fallback -----------------------------------------


async def test_get_account_info_uses_tatum_with_the_key_in_the_header(monkeypatch):
    enable_tatum(monkeypatch)
    created = install_fake_client(monkeypatch)

    info = await routed(solana_client.open_write_client("unit-test")).get_account_info(
        "account"
    )

    assert info.value.endpoint == TATUM_RPC
    gateways = [fake for fake in created if fake.is_tatum]
    assert len(gateways) == 1
    gateway = gateways[0]
    assert gateway.endpoint == TATUM_RPC
    assert gateway.extra_headers == {"x-api-key": TESTNET_KEY}
    assert gateway.timeout == settings.TATUM_RPC_TIMEOUT_SECONDS
    assert gateway.closed is True
    assert TESTNET_KEY not in TATUM_RPC


async def test_get_latest_blockhash_uses_tatum_with_the_key_in_the_header(monkeypatch):
    enable_tatum(monkeypatch)
    created = install_fake_client(monkeypatch)

    blockhash = await routed(
        solana_client.open_write_client("unit-test")
    ).get_latest_blockhash()

    assert blockhash.value.blockhash == f"hash-from-{TATUM_RPC}"
    gateway = next(fake for fake in created if fake.is_tatum)
    assert gateway.extra_headers == {"x-api-key": TESTNET_KEY}
    assert gateway.closed is True


async def test_mainnet_network_pairs_the_mainnet_key(monkeypatch):
    """The network decides the key; the URL is never used to guess it."""
    enable_tatum(monkeypatch, network="mainnet")
    created = install_fake_client(monkeypatch)

    await routed(solana_client.open_write_client("unit-test")).get_account_info("a")

    gateway = next(fake for fake in created if fake.is_tatum)
    assert gateway.extra_headers == {"x-api-key": MAINNET_KEY}


async def test_flag_off_sends_every_read_to_the_primary_rpc(monkeypatch):
    disable_tatum(monkeypatch)
    created = install_fake_client(monkeypatch)
    primary = solana_client.open_write_client("unit-test")

    info = await routed(primary).get_account_info("account")
    blockhash = await routed(primary).get_latest_blockhash()

    assert info.value.endpoint == PRIMARY_RPC
    assert blockhash.value.blockhash == f"hash-from-{PRIMARY_RPC}"
    assert [fake.endpoint for fake in created] == [PRIMARY_RPC]
    assert primary.calls == ["get_account_info", "get_latest_blockhash"]


async def test_a_failed_tatum_read_falls_back_to_the_primary_exactly_once(
    monkeypatch, caplog
):
    """A gateway failure must not fail the action, and must not retry it twice."""
    caplog.set_level(logging.DEBUG)
    enable_tatum(monkeypatch)
    created = install_fake_client(monkeypatch, tatum_failure=RuntimeError("gateway down"))
    primary = solana_client.open_write_client("unit-test")

    info = await routed(primary).get_account_info("account")

    assert info.value.endpoint == PRIMARY_RPC
    gateways = [fake for fake in created if fake.is_tatum]
    assert len(gateways) == 1
    assert gateways[0].calls == ["get_account_info"]
    assert gateways[0].closed is True
    assert primary.calls == ["get_account_info"]
    assert "fell back to SOLANA_RPC_URL" in caplog.text


async def test_a_timed_out_tatum_read_falls_back_within_the_short_window(monkeypatch):
    """A hanging gateway is abandoned at the configured short timeout."""
    enable_tatum(monkeypatch)
    install_fake_client(monkeypatch, tatum_delay=5)
    primary = solana_client.open_write_client("unit-test")

    started = asyncio.get_running_loop().time()
    blockhash = await routed(primary, make_boundary(timeout=0.05)).get_latest_blockhash()
    elapsed = asyncio.get_running_loop().time() - started

    assert blockhash.value.blockhash == f"hash-from-{PRIMARY_RPC}"
    assert elapsed < 1.5


async def test_fallback_log_never_contains_the_api_key(monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    enable_tatum(monkeypatch)
    install_fake_client(
        monkeypatch, tatum_failure=RuntimeError(f"rejected header x-api-key={TESTNET_KEY}")
    )

    await routed(solana_client.open_write_client("unit-test")).get_account_info("a")

    assert TESTNET_KEY not in caplog.text
    assert "[redacted]" in caplog.text


async def test_close_closes_the_primary_client(monkeypatch):
    """The routed facade owns exactly one long-lived client, and closes it."""
    enable_tatum(monkeypatch)
    created = install_fake_client(monkeypatch)
    primary = solana_client.open_write_client("unit-test")

    await routed(primary).close()

    assert primary.closed is True
    assert created == [primary]

