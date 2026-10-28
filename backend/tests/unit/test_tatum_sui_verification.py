"""Unit tests for advisory Sui verification of a Walrus memory reference.

No network and no database: the gRPC stub is faked and the boundary is built
with a short policy. Every test asserts that a Sui problem stays advisory, that
the Tatum key never reaches a URL, a repr or a log line, and that the answer
names a gRPC timeout apart from a transport failure.
"""

from __future__ import annotations

import asyncio
import logging
import uuid

import grpclib.client
from grpclib.const import Status
from grpclib.exceptions import GRPCError

import pysui.sui.sui_grpc.suimsgs.google.protobuf as gp
import pysui.sui.sui_grpc.suimsgs.sui.rpc.v2 as sui_v2
from pysui.sui.sui_grpc.suimsgs.sui.rpc.v2 import (
    GetObjectResponse,
    Object,
    Owner,
    OwnerOwnerKind,
)

from app.core.config import Settings, settings
from app.core.gateways.tatum_sui_gateway import (
    READ_MASK_PATHS,
    TatumSuiGateway,
)
from app.core.resilience import Boundary, ResiliencePolicy, StructuredLogMetricSink
from app.services.memory_verification_service import (
    REASON_BLOB_ID_UNRESOLVED,
    REASON_CERTIFIED,
    REASON_FEATURE_DISABLED,
    REASON_GRPC_TIMEOUT,
    REASON_GRPC_TRANSPORT,
    REASON_NOT_A_BLOB,
    REASON_NOT_CERTIFIED,
    REASON_NOT_CONFIGURED,
    REASON_NOT_FOUND,
    REASON_RPC_ERROR,
    REASON_UNRECOGNISED,
    MemoryVerificationService,
)

SUI_GRPC = "https://sui-mainnet-grpc.gateway.tatum.io"
SUI_KEY = "tatum-sui-key-789"
OBJECT_ID = "0x" + "ab" * 32
OTHER_OBJECT_ID = "0x" + "cd" * 32
BLOB_ID = "M4hsZGQ1oCktdzegB6HnI6Mi28S2nqOPHxK-W7_4BUk"
USER_ID = uuid.UUID("11111111-1111-1111-1111-111111111111")
BLOB_TYPE = "0x1234::blob::Blob"
MEMWAL_ACCOUNT_TYPE = (
    "0xe7c16fbe00000000000000000000000000000000000000000000000000000000"
    "::account::MemWalAccount"
)
OBJECT_VERSION = 1051062203


def make_boundary(
    timeout: float = 0.5, failure_threshold: int = 2
) -> Boundary:
    return Boundary(
        ResiliencePolicy(
            dependency="tatum-sui-grpc",
            timeout_seconds=timeout,
            failure_threshold=failure_threshold,
            reset_timeout_seconds=30.0,
            max_attempts=1,
            max_concurrency=1,
        ),
        StructuredLogMetricSink("tatum-sui-test"),
    )


def _to_value(item: object) -> gp.Value:
    """Build the google.protobuf.Value the Sui node sends for Move contents."""
    if isinstance(item, dict):
        return gp.Value(
            struct_value=gp.Struct(
                fields={key: _to_value(value) for key, value in item.items()}
            )
        )
    if isinstance(item, list):
        return gp.Value(
            list_value=gp.ListValue(values=[_to_value(value) for value in item])
        )
    if isinstance(item, bool):
        return gp.Value(bool_value=item)
    if isinstance(item, str):
        return gp.Value(string_value=item)
    if isinstance(item, (int, float)):
        return gp.Value(number_value=float(item))
    return gp.Value(null_value=gp.NullValue.NULL_VALUE)


def blob_fields(
    certified_epoch: object = 25.0,
    end_epoch: object = 77.0,
    deletable: bool = True,
) -> dict:
    """The Move contents of a real Walrus Blob as the gRPC json field renders it.

    google.protobuf.Value carries every JSON number as a double, so epochs are
    floats here (25.0), and a nested Move struct is a plain dict, not the
    JSON-RPC ``{"type": ..., "fields": ...}`` wrapper.
    """
    return {
        "id": {"id": OBJECT_ID},
        "registered_epoch": 25.0,
        "blob_id": "112348369824897870980032644416957088131665536048862184864742112918046513378294",
        "size": "122973456",
        "encoding_type": 1.0,
        "certified_epoch": certified_epoch,
        "storage": {
            "id": "0x36ff78b3b29a3d7252792a0466c0caa5852b28834b9c529634cc4bd1d9ba4eae",
            "start_epoch": 25.0,
            "end_epoch": end_epoch,
            "storage_size": "616584000",
        },
        "deletable": deletable,
    }


def make_response(
    object_type: str = BLOB_TYPE,
    fields: dict | None = None,
    version: int = OBJECT_VERSION,
    owner_kind: OwnerOwnerKind = OwnerOwnerKind.SHARED,
    object_id: str = OBJECT_ID,
) -> GetObjectResponse:
    """A GetObjectResponse shaped like the one Tatum returns for a Blob."""
    contents = None if fields is None else _to_value(fields)
    return GetObjectResponse(
        object=Object(
            object_id=object_id,
            version=version,
            object_type=object_type,
            owner=Owner(kind=owner_kind),
            json=contents,
        )
    )


class FakeStub:
    """The one stub method the gateway calls, recording how it was called."""

    def __init__(
        self,
        response: GetObjectResponse | None = None,
        error: BaseException | None = None,
        delay: float = 0.0,
    ) -> None:
        self.response = response
        self.error = error
        self.delay = delay
        self.requests: list[object] = []
        self.timeouts: list[float | None] = []

    async def get_object(self, request, *, timeout=None):
        self.requests.append(request)
        self.timeouts.append(timeout)
        if self.delay:
            await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return self.response


class FakeChannel:
    """A channel that records whether it was closed."""

    def __init__(self, host: str, port: int, ssl: bool = False) -> None:
        self.host = host
        self.port = port
        self.ssl = ssl
        self.closed = False

    def close(self) -> None:
        self.closed = True


class RecordingStub:
    """A stub built by the production path, recording its channel and metadata."""

    def __init__(self, channel, metadata=None) -> None:
        self.channel = channel
        self.metadata = metadata
        self.requests: list[object] = []
        self.timeouts: list[float | None] = []

    async def get_object(self, request, *, timeout=None):
        self.requests.append(request)
        self.timeouts.append(timeout)
        return make_response(fields=blob_fields())


def gateway_with(
    stub: FakeStub,
    boundary: Boundary | None = None,
    grpc_url: str = SUI_GRPC,
) -> TatumSuiGateway:
    return TatumSuiGateway(
        boundary=boundary or make_boundary(),
        grpc_url=grpc_url,
        api_key=SUI_KEY,
        stub=stub,
    )


def enable_sui(monkeypatch) -> None:
    monkeypatch.setattr(settings, "FEATURE_TATUM_SUI", True)
    monkeypatch.setattr(settings, "TATUM_SUI_GRPC_URL", SUI_GRPC)
    monkeypatch.setattr(settings, "TATUM_SUI_NETWORK", "mainnet")
    monkeypatch.setattr(settings, "TATUM_API_KEY_TESTNET", SUI_KEY)
    monkeypatch.setattr(settings, "TATUM_API_KEY_MAINNET", SUI_KEY)


def disable_sui(monkeypatch) -> None:
    monkeypatch.setattr(settings, "FEATURE_TATUM_SUI", False)
    monkeypatch.setattr(settings, "TATUM_SUI_GRPC_URL", "")
    monkeypatch.setattr(settings, "TATUM_API_KEY_TESTNET", "")
    monkeypatch.setattr(settings, "TATUM_API_KEY_MAINNET", "")


async def test_flag_off_reports_unavailable_without_any_grpc_call(monkeypatch):
    """With the flag off a configured gateway must not be contacted at all."""
    disable_sui(monkeypatch)
    stub = FakeStub(response=make_response(fields=blob_fields()))

    result = await MemoryVerificationService(gateway_with(stub)).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.available is False
    assert result.checked is False
    assert result.verified is False
    assert result.reason == REASON_FEATURE_DISABLED
    assert stub.requests == []
    assert result.as_response()["advisory"] is True


async def test_unconfigured_gateway_reports_unavailable_without_a_call(monkeypatch):
    """The flag alone is not enough; a missing URL or key means no badge."""
    enable_sui(monkeypatch)
    stub = FakeStub(response=make_response(fields=blob_fields()))
    gateway = TatumSuiGateway(make_boundary(), grpc_url="", api_key=SUI_KEY, stub=stub)

    result = await MemoryVerificationService(gateway).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.available is False
    assert result.checked is False
    assert result.reason == REASON_NOT_CONFIGURED
    assert stub.requests == []


async def test_certified_walrus_blob_is_verified_with_concrete_object_facts(
    monkeypatch,
):
    """The read must use the mask and report the version, owner kind and type."""
    enable_sui(monkeypatch)
    stub = FakeStub(response=make_response(fields=blob_fields()))

    result = await MemoryVerificationService(gateway_with(stub)).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.verified is True
    assert result.checked is True
    assert result.reason == REASON_CERTIFIED
    assert result.object_id == OBJECT_ID
    assert result.object_type == BLOB_TYPE
    assert result.object_version == OBJECT_VERSION
    assert result.owner_kind == "shared"
    assert result.certified_epoch == 25
    assert result.end_epoch == 77
    assert result.deletable is True

    response = result.as_response()
    assert response["object_version"] == OBJECT_VERSION
    assert response["owner_kind"] == "shared"

    request = stub.requests[0]
    assert request.object_id == OBJECT_ID
    assert list(request.read_mask.paths) == list(READ_MASK_PATHS)
    assert "object_type" in request.read_mask.paths
    assert "owner" in request.read_mask.paths
    assert "json" in request.read_mask.paths
    assert stub.timeouts == [0.5]


async def test_a_mem_wal_account_is_reported_as_not_a_blob_with_its_facts(
    monkeypatch,
):
    """A MemWalAccount is a real Sui object but not the blob worth verifying."""
    enable_sui(monkeypatch)
    stub = FakeStub(
        response=make_response(
            object_type=MEMWAL_ACCOUNT_TYPE,
            fields={"id": {"id": OBJECT_ID}},
            owner_kind=OwnerOwnerKind.ADDRESS,
        )
    )

    result = await MemoryVerificationService(gateway_with(stub)).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.available is True
    assert result.checked is True
    assert result.verified is False
    assert result.reason == REASON_NOT_A_BLOB
    assert result.object_type == MEMWAL_ACCOUNT_TYPE
    assert result.object_version == OBJECT_VERSION
    assert result.owner_kind == "address"


async def test_a_type_that_merely_contains_blob_is_not_a_walrus_blob(monkeypatch):
    """The blob marker is a suffix: a BlobWrapper is a different Move type."""
    enable_sui(monkeypatch)
    stub = FakeStub(
        response=make_response(
            object_type="0x1234::blob::BlobWrapper", fields=blob_fields()
        )
    )

    result = await MemoryVerificationService(gateway_with(stub)).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.verified is False
    assert result.reason == REASON_NOT_A_BLOB


async def test_a_missing_object_is_unverified_and_does_not_trip_the_breaker(
    monkeypatch,
):
    """Sui's "not found" answer is a legitimate result, not a dependency failure."""
    enable_sui(monkeypatch)
    stub = FakeStub(
        error=GRPCError(Status.NOT_FOUND, "object not found")
    )
    gateway = gateway_with(stub, make_boundary(failure_threshold=1))

    first = await MemoryVerificationService(gateway).verify_reference(
        USER_ID, OTHER_OBJECT_ID
    )
    second = await MemoryVerificationService(gateway).verify_reference(
        USER_ID, OTHER_OBJECT_ID
    )

    assert first.available is True
    assert first.checked is True
    assert first.verified is False
    assert first.reason == REASON_NOT_FOUND
    assert second.reason == REASON_NOT_FOUND
    assert len(stub.requests) == 2


async def test_an_uncertified_blob_is_not_verified(monkeypatch):
    enable_sui(monkeypatch)
    stub = FakeStub(
        response=make_response(
            fields=blob_fields(certified_epoch=None)
        )
    )

    result = await MemoryVerificationService(gateway_with(stub)).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.verified is False
    assert result.reason == REASON_NOT_CERTIFIED
    assert result.certified_epoch is None
    assert result.object_version == OBJECT_VERSION


async def test_a_grpc_transport_failure_is_advisory_and_never_leaks_the_key(
    monkeypatch, caplog
):
    """A broken gateway must answer, not raise, and must redact the key."""
    caplog.set_level(logging.DEBUG)
    enable_sui(monkeypatch)
    stub = FakeStub(
        error=GRPCError(Status.UNAVAILABLE, f"connection refused for key {SUI_KEY}")
    )

    result = await MemoryVerificationService(gateway_with(stub)).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.available is True
    assert result.checked is True
    assert result.verified is False
    assert result.reason == REASON_GRPC_TRANSPORT
    assert SUI_KEY not in caplog.text
    assert SUI_KEY not in str(result)


async def test_a_grpc_timeout_is_advisory_and_named_apart_from_transport(
    monkeypatch,
):
    enable_sui(monkeypatch)
    stub = FakeStub(response=make_response(fields=blob_fields()), delay=5)

    started = asyncio.get_running_loop().time()
    result = await MemoryVerificationService(
        gateway_with(stub, make_boundary(timeout=0.05))
    ).verify_reference(USER_ID, OBJECT_ID)
    elapsed = asyncio.get_running_loop().time() - started

    assert result.verified is False
    assert result.reason == REASON_GRPC_TIMEOUT
    assert elapsed < 1.5


async def test_a_server_deadline_status_is_reported_as_a_timeout(monkeypatch):
    """A DEADLINE_EXCEEDED status is a timeout, not a transport failure."""
    enable_sui(monkeypatch)
    stub = FakeStub(error=GRPCError(Status.DEADLINE_EXCEEDED, "deadline exceeded"))

    result = await MemoryVerificationService(gateway_with(stub)).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.verified is False
    assert result.reason == REASON_GRPC_TIMEOUT


async def test_an_open_breaker_is_reported_as_a_transport_failure(monkeypatch):
    """A breaker-open call is an unavailable gateway, never a slow one."""
    enable_sui(monkeypatch)
    stub = FakeStub(error=GRPCError(Status.UNAVAILABLE, "no route to host"))
    gateway = gateway_with(stub, make_boundary(failure_threshold=1))

    first = await MemoryVerificationService(gateway).verify_reference(
        USER_ID, OBJECT_ID
    )
    second = await MemoryVerificationService(gateway).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert first.reason == REASON_GRPC_TRANSPORT
    assert second.reason == REASON_GRPC_TRANSPORT
    assert len(stub.requests) == 1


async def test_an_unreadable_response_is_an_rpc_error(monkeypatch):
    enable_sui(monkeypatch)
    stub = FakeStub(response=GetObjectResponse())

    result = await MemoryVerificationService(gateway_with(stub)).verify_reference(
        USER_ID, OBJECT_ID
    )

    assert result.checked is True
    assert result.verified is False
    assert result.reason == REASON_RPC_ERROR


async def test_a_walrus_blob_id_is_reported_unresolvable_instead_of_guessed(
    monkeypatch,
):
    """A bare blob id needs the Walrus indexer; the advisory answer says so."""
    enable_sui(monkeypatch)
    stub = FakeStub(response=make_response(fields=blob_fields()))

    result = await MemoryVerificationService(gateway_with(stub)).verify_reference(
        USER_ID, BLOB_ID
    )

    assert result.available is True
    assert result.checked is False
    assert result.verified is False
    assert result.reason == REASON_BLOB_ID_UNRESOLVED
    assert stub.requests == []


async def test_an_unrecognised_reference_is_reported_without_a_call(monkeypatch):
    enable_sui(monkeypatch)
    stub = FakeStub(response=make_response(fields=blob_fields()))

    result = await MemoryVerificationService(gateway_with(stub)).verify_reference(
        USER_ID, "not-a-chain-reference"
    )

    assert result.checked is False
    assert result.verified is False
    assert result.reason == REASON_UNRECOGNISED
    assert stub.requests == []


async def test_the_gateway_opens_a_tls_channel_with_the_key_and_closes_it(
    monkeypatch,
):
    """Production path: metadata tuple, policy timeout, and a closed channel."""
    enable_sui(monkeypatch)
    channel = FakeChannel("sui-mainnet-grpc.gateway.tatum.io", 443, ssl=True)
    built: list[RecordingStub] = []

    def build(channel_arg, metadata=None):
        stub = RecordingStub(channel_arg, metadata=metadata)
        built.append(stub)
        return stub

    monkeypatch.setattr(
        grpclib.client, "Channel", lambda host, port, ssl=False: channel
    )
    monkeypatch.setattr(sui_v2, "LedgerServiceStub", build)

    result = await TatumSuiGateway(
        make_boundary(), grpc_url=SUI_GRPC, api_key=SUI_KEY
    ).get_object(OBJECT_ID)

    assert result.object_type == BLOB_TYPE
    assert channel.host == "sui-mainnet-grpc.gateway.tatum.io"
    assert channel.port == 443
    assert channel.ssl is True
    assert channel.closed is True
    assert built[0].metadata == (("x-api-key", SUI_KEY),)
    assert built[0].timeouts == [0.5]


def test_the_key_never_appears_in_the_gateway_repr():
    gateway = TatumSuiGateway(make_boundary(), grpc_url=SUI_GRPC, api_key=SUI_KEY)

    assert SUI_KEY not in repr(gateway)
    assert SUI_KEY not in str(gateway)


def test_tatum_values_are_trimmed_before_use(monkeypatch):
    """A pasted key often carries a newline; the gRPC host rejects it."""
    monkeypatch.setenv("FEATURE_TATUM_SUI", "true")
    monkeypatch.setenv("TATUM_SUI_NETWORK", "mainnet")
    monkeypatch.setenv(
        "TATUM_SUI_GRPC_URL", "  https://sui-mainnet-grpc.gateway.tatum.io \n"
    )
    monkeypatch.setenv("TATUM_API_KEY_MAINNET", "  tatum-key-value  \n")

    startup = Settings(_env_file=None)

    assert startup.TATUM_SUI_GRPC_URL == "https://sui-mainnet-grpc.gateway.tatum.io"
    assert startup.TATUM_API_KEY_MAINNET == "tatum-key-value"
    assert startup.tatum_sui_api_key == "tatum-key-value"
    assert startup.tatum_sui_enabled is True


def test_the_grpc_url_defaults_to_the_proven_tatum_host(monkeypatch):
    monkeypatch.delenv("TATUM_SUI_GRPC_URL", raising=False)

    startup = Settings(_env_file=None)

    assert startup.TATUM_SUI_GRPC_URL == "https://sui-mainnet-grpc.gateway.tatum.io"


def test_sui_verification_needs_the_grpc_url_not_the_obsolete_json_rpc_url(monkeypatch):
    """The obsolete TATUM_SUI_RPC_URL must not be what enables the gateway."""
    monkeypatch.setenv("FEATURE_TATUM_SUI", "true")
    monkeypatch.setenv("TATUM_SUI_NETWORK", "mainnet")
    monkeypatch.setenv("TATUM_API_KEY_MAINNET", "tatum-key-value")
    monkeypatch.setenv("TATUM_SUI_GRPC_URL", "")
    monkeypatch.setenv("TATUM_SUI_RPC_URL", "https://sui-mainnet.gateway.tatum.io")

    startup = Settings(_env_file=None)

    assert startup.TATUM_SUI_RPC_URL == "https://sui-mainnet.gateway.tatum.io"
    assert startup.tatum_sui_enabled is False
