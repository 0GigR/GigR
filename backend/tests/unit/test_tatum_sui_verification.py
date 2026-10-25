"""Unit tests for advisory Sui verification of a Walrus memory reference.

No network and no database: the HTTP client is faked and the boundary is built
with a short policy. Every test asserts that a Sui problem stays advisory and
that the Tatum key never reaches a URL, a repr or a log line.
"""

from __future__ import annotations

import asyncio
import logging
import uuid

from app.core.config import settings
from app.core.gateways.tatum_sui_gateway import TatumSuiGateway
from app.core.resilience import Boundary, ResiliencePolicy, StructuredLogMetricSink
from app.services.memory_verification_service import (
    REASON_BLOB_ID_UNRESOLVED,
    REASON_CERTIFIED,
    REASON_FEATURE_DISABLED,
    REASON_NOT_A_BLOB,
    REASON_NOT_CERTIFIED,
    REASON_NOT_CONFIGURED,
    REASON_NOT_FOUND,
    REASON_UNAVAILABLE,
    REASON_UNRECOGNISED,
    MemoryVerificationService,
)

SUI_RPC = "https://sui-testnet.gateway.tatum.io"
SUI_KEY = "tatum-sui-key-789"
OBJECT_ID = "0x" + "ab" * 32
OTHER_OBJECT_ID = "0x" + "cd" * 32
BLOB_ID = "M4hsZGQ1oCktdzegB6HnI6Mi28S2nqOPHxK-W7_4BUk"
USER_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")


def make_boundary(timeout: float = 0.5) -> Boundary:
    return Boundary(
        ResiliencePolicy(
            dependency="tatum-sui-rpc",
            timeout_seconds=timeout,
            failure_threshold=2,
            reset_timeout_seconds=30.0,
            max_attempts=1,
            max_concurrency=1,
        ),
        StructuredLogMetricSink("tatum-sui-test"),
    )


class FakeResponse:
    def __init__(self, body: dict, status_code: int = 200) -> None:
        self._body = body
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self) -> dict:
        return self._body


class FakeHttpClient:
    """The one method the gateway calls, recording how it was called."""

    def __init__(
        self,
        body: dict | None = None,
        error: BaseException | None = None,
        delay: float = 0.0,
        status_code: int = 200,
    ) -> None:
        self.body = body or {}
        self.error = error
        self.delay = delay
        self.status_code = status_code
        self.calls: list[dict] = []

    async def post(self, url, json=None, headers=None):
        self.calls.append({"url": url, "json": json, "headers": headers})
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return FakeResponse(self.body, self.status_code)


def gateway_with(http: FakeHttpClient, boundary: Boundary | None = None) -> TatumSuiGateway:
    return TatumSuiGateway(
        boundary=boundary or make_boundary(),
        rpc_url=SUI_RPC,
        api_key=SUI_KEY,
        client=http,
    )


def enable_sui(monkeypatch) -> None:
    monkeypatch.setattr(settings, "FEATURE_TATUM_SUI", True)
    monkeypatch.setattr(settings, "TATUM_SUI_RPC_URL", SUI_RPC)
    monkeypatch.setattr(settings, "TATUM_SUI_NETWORK", "testnet")
    monkeypatch.setattr(settings, "TATUM_API_KEY_TESTNET", SUI_KEY)
    monkeypatch.setattr(settings, "TATUM_API_KEY_MAINNET", "tatum-mainnet-key-000")


def disable_sui(monkeypatch) -> None:
    monkeypatch.setattr(settings, "FEATURE_TATUM_SUI", False)
    monkeypatch.setattr(settings, "TATUM_SUI_RPC_URL", "")
    monkeypatch.setattr(settings, "TATUM_API_KEY_TESTNET", "")
    monkeypatch.setattr(settings, "TATUM_API_KEY_MAINNET", "")


def blob_object_body(
    object_id: str = OBJECT_ID,
    certified_epoch: object = "34",
    end_epoch: object = "35",
    deletable: bool = False,
    object_type: str = "0x1234::blob::Blob",
) -> dict:
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "data": {
                "objectId": object_id,
                "version": "11",
                "digest": "digest",
                "type": object_type,
                "content": {
                    "dataType": "moveObject",
                    "type": object_type,
                    "hasPublicTransfer": False,
                    "fields": {
                        "id": {"id": object_id},
                        "registered_epoch": "34",
                        "blob_id": "123",
                        "size": "17",
                        "certified_epoch": certified_epoch,
                        "storage": {
                            "type": "0x1234::storage_resource::Storage",
                            "fields": {
                                "start_epoch": "34",
                                "end_epoch": end_epoch,
                                "storage_size": "1",
                            },
                        },
                        "deletable": deletable,
                    },
                },
            }
        },
    }


async def test_flag_off_reports_unavailable_without_any_rpc_call(monkeypatch):
    """With the flag off a configured gateway must not be contacted at all."""
    disable_sui(monkeypatch)
    http = FakeHttpClient(body=blob_object_body())

    result = await MemoryVerificationService(gateway_with(http)).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.available is False
    assert result.checked is False
    assert result.verified is False
    assert result.reason == REASON_FEATURE_DISABLED
    assert http.calls == []
    assert result.as_response()["advisory"] is True


async def test_unconfigured_gateway_reports_unavailable_without_a_call(monkeypatch):
    """The flag alone is not enough; a missing URL or key means no badge."""
    enable_sui(monkeypatch)
    http = FakeHttpClient(body=blob_object_body())
    gateway = TatumSuiGateway(make_boundary(), rpc_url="", api_key=SUI_KEY, client=http)

    result = await MemoryVerificationService(gateway).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.available is False
    assert result.checked is False
    assert result.reason == REASON_NOT_CONFIGURED
    assert http.calls == []


async def test_certified_walrus_blob_object_is_verified_on_sui(monkeypatch):
    """The read must use the documented method and carry the key in the header."""
    enable_sui(monkeypatch)
    http = FakeHttpClient(body=blob_object_body())

    result = await MemoryVerificationService(gateway_with(http)).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.verified is True
    assert result.checked is True
    assert result.reason == REASON_CERTIFIED
    assert result.object_id == OBJECT_ID
    assert result.object_type == "0x1234::blob::Blob"
    assert result.certified_epoch == 34
    assert result.end_epoch == 35
    assert result.deletable is False

    call = http.calls[0]
    assert call["url"] == SUI_RPC
    assert SUI_KEY not in call["url"]
    assert call["headers"]["x-api-key"] == SUI_KEY
    assert call["json"]["method"] == "sui_getObject"
    assert call["json"]["params"] == [
        OBJECT_ID,
        {"showContent": True, "showType": True},
    ]


async def test_the_key_never_appears_in_the_gateway_repr(monkeypatch):
    enable_sui(monkeypatch)
    gateway = gateway_with(FakeHttpClient(body=blob_object_body()))

    assert SUI_KEY not in repr(gateway)
    assert SUI_KEY not in str(gateway)


async def test_a_missing_object_is_unverified_not_an_error(monkeypatch):
    """Sui's "not found" answer is a legitimate result, not a dependency failure."""
    enable_sui(monkeypatch)
    http = FakeHttpClient(
        body={
            "jsonrpc": "2.0",
            "id": 1,
            "error": {"code": -32000, "message": "Could not find the referenced object"},
        }
    )

    result = await MemoryVerificationService(gateway_with(http)).verify_reference(
        USER_ID, OTHER_OBJECT_ID
    )

    assert result.available is True
    assert result.checked is True
    assert result.verified is False
    assert result.reason == REASON_NOT_FOUND


async def test_an_object_that_is_not_a_walrus_blob_is_not_verified(monkeypatch):
    enable_sui(monkeypatch)
    http = FakeHttpClient(
        body=blob_object_body(object_type="0x2::coin::Coin<0x2::sui::SUI>")
    )

    result = await MemoryVerificationService(gateway_with(http)).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.verified is False
    assert result.reason == REASON_NOT_A_BLOB


async def test_an_uncertified_blob_is_not_verified(monkeypatch):
    enable_sui(monkeypatch)
    http = FakeHttpClient(
        body=blob_object_body(
            certified_epoch={"type": "0x1::option::Option<u32>", "fields": {"vec": []}}
        )
    )

    result = await MemoryVerificationService(gateway_with(http)).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.verified is False
    assert result.reason == REASON_NOT_CERTIFIED
    assert result.certified_epoch is None


async def test_a_transport_failure_is_advisory_and_never_leaks_the_key(
    monkeypatch, caplog
):
    """A broken gateway must answer, not raise, and must redact the key."""
    caplog.set_level(logging.DEBUG)
    enable_sui(monkeypatch)
    http = FakeHttpClient(error=RuntimeError(f"proxy echoed x-api-key={SUI_KEY}"))

    result = await MemoryVerificationService(gateway_with(http)).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.available is True
    assert result.checked is True
    assert result.verified is False
    assert result.reason == REASON_UNAVAILABLE
    assert SUI_KEY not in caplog.text
    assert SUI_KEY not in str(result)


async def test_a_timeout_is_advisory_and_bounded(monkeypatch):
    enable_sui(monkeypatch)
    http = FakeHttpClient(body=blob_object_body(), delay=5)

    started = asyncio.get_running_loop().time()
    result = await MemoryVerificationService(
        gateway_with(http, make_boundary(timeout=0.05))
    ).verify_reference(USER_ID, OBJECT_ID)
    elapsed = asyncio.get_running_loop().time() - started

    assert result.verified is False
    assert result.reason == REASON_UNAVAILABLE
    assert elapsed < 1.5


async def test_a_walrus_blob_id_is_reported_unresolvable_instead_of_guessed(
    monkeypatch,
):
    """A bare blob id needs the Walrus indexer; the advisory answer says so."""
    enable_sui(monkeypatch)
    http = FakeHttpClient(body=blob_object_body())

    result = await MemoryVerificationService(gateway_with(http)).verify_reference(
        USER_ID, BLOB_ID
    )

    assert result.available is True
    assert result.checked is False
    assert result.verified is False
    assert result.reason == REASON_BLOB_ID_UNRESOLVED
    assert http.calls == []


async def test_an_unrecognised_reference_is_reported_without_a_call(monkeypatch):
    enable_sui(monkeypatch)
    http = FakeHttpClient(body=blob_object_body())

    result = await MemoryVerificationService(gateway_with(http)).verify_reference(
        USER_ID, "not-a-chain-reference"
    )

    assert result.checked is False
    assert result.verified is False
    assert result.reason == REASON_UNRECOGNISED
    assert http.calls == []
