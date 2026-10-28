"""Tatum Sui gateway: the only place Sui is spoken to.

Tatum does not serve Sui over JSON-RPC for this account: every path on
``sui-mainnet.gateway.tatum.io`` answers 404, and the ``api.tatum.io`` REST
routes do not know Sui either. The host that does answer is the gRPC one,
``sui-mainnet-grpc.gateway.tatum.io``, which speaks the Sui v2 LedgerService.
This gateway therefore uses ``grpclib`` and the generated Sui v2 stubs that
ship inside ``pysui``, so no proto compilation is needed.

The API key travels as the ``x-api-key`` gRPC metadata pair, never in a URL,
and is filtered out of every error message before the boundary can log it.
``repr`` does not render it.

Every call crosses the injected :class:`Boundary`: timeout, circuit breaker,
bulkhead and a bounded retry for this idempotent read. No write is ever sent
from here, so there is no write retry to guard against. A channel is opened for
one call and closed in the same call, because nothing in the request lifecycle
owns a long-lived channel and an unclosed one leaks a connection.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

from grpclib.const import Status
from grpclib.exceptions import GRPCError

from ..errors import DependencyUnavailableError
from ..resilience import Boundary, failure_fallback


DEPENDENCY = "tatum-sui-grpc"

# The object type a Walrus blob registration carries. ``endswith`` rather than
# a substring: any other module's ``BlobWrapper`` is not a Walrus blob.
WALRUS_BLOB_TYPE_SUFFIX = "::blob::Blob"

# Object fields worth asking for. Without a mask Sui returns the id, version
# and digest only: ``object_type`` and ``owner`` come back empty, and ``json``
# carries the Move contents that say whether the blob is certified.
READ_MASK_PATHS = ("object_id", "object_type", "owner", "version", "json")

# A sentinel for "the node says this object id does not exist". It is a normal
# answer, not a dependency failure, so it must not count toward the breaker.
_NOT_FOUND = object()

_OWNER_KIND_UNKNOWN = "OWNER_KIND_UNKNOWN"


@dataclass(frozen=True)
class SuiObjectResult:
    """One Sui object lookup, as far as it got.

    ``error`` is set when the call completed but the object could not be read
    (``object_not_found``, ``rpc_error``, ``malformed_response``). Transport
    failures never reach here: the gateway raises a typed error the advisory
    caller catches.
    """

    object_id: str
    object_type: str | None = None
    fields: dict[str, Any] = field(default_factory=dict)
    version: int | None = None
    owner_kind: str | None = None
    error: str | None = None


class SuiRpcError(RuntimeError):
    """A Sui gRPC failure whose message is already safe to log.

    The boundary reports a failed call's reason to its metric sink, which is a
    log line. The dependency's exception is converted here so the sink only ever
    sees the redacted message.
    """


class SuiGrpcError(DependencyUnavailableError):
    """The Sui gateway could not answer at all."""

    def __init__(self, message: str) -> None:
        super().__init__(DEPENDENCY, message)


class SuiGrpcTimeoutError(SuiGrpcError):
    """The Sui gateway did not answer inside the boundary's deadline."""


class SuiGrpcTransportError(SuiGrpcError):
    """The Sui gateway failed before it could answer: transport, auth, breaker."""


def _redact(secret: str, text: str) -> str:
    """Remove ``secret`` from error text before it can be logged or raised."""
    if secret and text and secret in text:
        return text.replace(secret, "[redacted]")
    return text


def grpc_endpoint(grpc_url: str) -> tuple[str, int, bool]:
    """Split a gateway URL into the host, port and TLS flag grpclib needs."""
    candidate = grpc_url.strip()
    if "//" not in candidate:
        candidate = "//" + candidate
    parts = urlsplit(candidate)
    if not parts.hostname:
        raise ValueError("invalid Tatum Sui gRPC URL (operation=get_object)")
    secure = parts.scheme != "http"
    return parts.hostname, parts.port or (443 if secure else 80), secure


def _open_channel(grpc_url: str) -> Any:
    """Open one TLS channel to the gRPC host.

    The import is lazy so a process with FEATURE_TATUM_SUI off never loads the
    gRPC stack. The caller closes the channel.
    """
    from grpclib.client import Channel

    host, port, secure = grpc_endpoint(grpc_url)
    return Channel(host, port, ssl=secure)


def _build_stub(channel: Any, api_key: str) -> Any:
    """Build the LedgerService stub with the key as metadata, never a URL."""
    from pysui.sui.sui_grpc.suimsgs.sui.rpc.v2 import LedgerServiceStub

    return LedgerServiceStub(channel, metadata=(("x-api-key", api_key),))


def _get_object_request(object_id: str) -> Any:
    """The documented GetObject request, with the mask that makes it useful."""
    from pysui.sui.sui_grpc.suimsgs.google.protobuf import FieldMask
    from pysui.sui.sui_grpc.suimsgs.sui.rpc.v2 import GetObjectRequest

    return GetObjectRequest(
        object_id=object_id,
        read_mask=FieldMask(paths=list(READ_MASK_PATHS)),
    )


def _value_to_python(value: Any) -> Any:
    """Convert a google.protobuf.Value tree into plain Python containers."""
    if value is None:
        return None
    if value.struct_value is not None:
        return {
            key: _value_to_python(item)
            for key, item in (value.struct_value.fields or {}).items()
        }
    if value.list_value is not None:
        return [_value_to_python(item) for item in (value.list_value.values or [])]
    for attribute in ("string_value", "number_value", "bool_value"):
        item = getattr(value, attribute, None)
        if item is not None:
            return item
    return None


def _boundary_failure_kind(failure: list[str]) -> str:
    """Which typed failure the boundary recorded, as ``timeout`` or ``transport``.

    The operation records its own kind before raising. When the boundary itself
    cancels the call (its deadline) no exception is observed, so the fallback
    reason, ``timeout after Ns``, is the only evidence. A breaker-open call
    records ``circuit_open`` and is a transport failure, not a slow node.
    """
    if not failure:
        return "timeout"
    first = failure[0]
    if first in ("timeout", "transport"):
        return first
    if first == "circuit_open":
        return "transport"
    if first.startswith("timeout after"):
        return "timeout"
    return "transport"


def _owner_kind_name(kind: Any) -> str | None:
    """The owner kind in the words a client can show, or None when unset."""
    name = getattr(kind, "name", None)
    if not isinstance(name, str) or name == _OWNER_KIND_UNKNOWN:
        return None
    return name.lower()


def _parse_object(object_id: str, response: Any) -> SuiObjectResult:
    """Normalise a Sui GetObjectResponse into a result."""
    obj = getattr(response, "object", None)
    if obj is None:
        return SuiObjectResult(object_id=object_id, error="malformed_response")

    contents = _value_to_python(getattr(obj, "json", None))
    fields = contents if isinstance(contents, dict) else {}

    version = getattr(obj, "version", None)
    return SuiObjectResult(
        object_id=str(getattr(obj, "object_id", None) or object_id),
        object_type=getattr(obj, "object_type", None) or None,
        fields=fields,
        version=version if isinstance(version, int) else None,
        owner_kind=_owner_kind_name(getattr(getattr(obj, "owner", None), "kind", None)),
    )


class TatumSuiGateway:
    """Async wrapper around the Tatum Sui gRPC endpoint."""

    def __init__(
        self,
        boundary: Boundary,
        grpc_url: str,
        api_key: str,
        stub: Any | None = None,
    ) -> None:
        self._boundary = boundary
        self._grpc_url = grpc_url
        self._api_key = api_key
        self._stub = stub

    @property
    def configured(self) -> bool:
        """True when both the gRPC endpoint and the network's key are present."""
        return bool(self._grpc_url and self._api_key)

    def __repr__(self) -> str:
        return (
            f"TatumSuiGateway(grpc_url={self._grpc_url!r}, "
            f"configured={self.configured})"
        )

    def __str__(self) -> str:
        return self.__repr__()

    async def _call(self, request: Any) -> Any:
        """Send one GetObject request and close whatever channel it opened."""
        timeout = self._boundary.policy.timeout_seconds
        if self._stub is not None:
            return await self._stub.get_object(request, timeout=timeout)

        channel = _open_channel(self._grpc_url)
        try:
            stub = _build_stub(channel, self._api_key)
            return await stub.get_object(request, timeout=timeout)
        finally:
            channel.close()

    async def get_object(self, object_id: str) -> SuiObjectResult:
        """Read one Sui object, or report why it could not be read.

        Returns a result with ``error`` set when the node answered that the
        object does not exist or sent something unreadable. Raises
        :class:`SuiGrpcTimeoutError` or :class:`SuiGrpcTransportError` when the
        gateway could not answer at all. The advisory caller catches both and
        reports the reference as unverified.
        """
        if not object_id:
            raise ValueError("get_object requires an object id (operation=get_object)")

        request = _get_object_request(object_id)
        # The failure kind is recorded where the exception is still typed. The
        # boundary flattens every exception to a string, so this list is what
        # keeps a deadline distinguishable from a transport failure after it.
        failure: list[str] = []

        async def fallback(reason: str):
            failure.append(reason)
            return await failure_fallback(DEPENDENCY, "sui_get_object_failed")(reason)

        async def operation() -> Any:
            try:
                return await self._call(request)
            except GRPCError as exc:
                if exc.status is Status.NOT_FOUND:
                    return _NOT_FOUND
                failure.append(
                    "timeout" if exc.status is Status.DEADLINE_EXCEEDED else "transport"
                )
                raise SuiRpcError(
                    _redact(self._api_key, f"GRPCError {exc.status.name}: {exc.message}")
                ) from None
            except asyncio.TimeoutError:
                failure.append("timeout")
                raise SuiRpcError(
                    _redact(self._api_key, "TimeoutError: Deadline exceeded")
                ) from None
            except Exception as exc:  # noqa: BLE001 - redact before the boundary logs it
                failure.append("transport")
                raise SuiRpcError(
                    _redact(self._api_key, f"{type(exc).__name__}: {exc}")
                ) from None

        outcome = await self._boundary.call(
            operation,
            fallback,
            idempotent=True,
        )
        if not outcome.ok:
            error = _redact(self._api_key, outcome.error or "no response")
            if _boundary_failure_kind(failure) == "timeout":
                raise SuiGrpcTimeoutError(
                    f"{DEPENDENCY}: get_object timed out against {self._grpc_url}: "
                    f"{error}"
                )
            raise SuiGrpcTransportError(
                f"{DEPENDENCY}: get_object failed against {self._grpc_url}: {error}"
            )

        if outcome.value is _NOT_FOUND:
            return SuiObjectResult(object_id=object_id, error="object_not_found")
        return _parse_object(object_id, outcome.value)
