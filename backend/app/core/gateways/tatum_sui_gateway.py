"""Tatum Sui gateway: the only place the Sui JSON-RPC is touched.

The gateway makes one documented call, ``sui_getObject``, against the Tatum Sui
gateway endpoint. The API key travels in the ``x-api-key`` request header, never
in the URL, and is filtered out of every error message before it can reach a
log line or an exception. ``repr`` does not render it.

Every call crosses the injected :class:`Boundary`: timeout, circuit breaker,
bulkhead and a bounded retry for this idempotent read. No write is ever sent
from here, so there is no write retry to guard against.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any

from ..errors import DependencyUnavailableError
from ..resilience import Boundary, failure_fallback

logger = logging.getLogger(__name__)

DEPENDENCY = "tatum-sui-rpc"
GET_OBJECT_METHOD = "sui_getObject"

# Sui reports a missing object as a JSON-RPC error rather than an HTTP error.
# It is a legitimate answer ("not there"), not a dependency failure, so it must
# not count toward the circuit breaker.
OBJECT_NOT_FOUND_CODE = -32000
_OBJECT_NOT_FOUND_MARKERS = ("could not find the referenced object",)


@dataclass(frozen=True)
class SuiObjectResult:
    """One Sui object lookup, as far as it got.

    ``error`` is set when the call completed but the object could not be read
    (``object_not_found``, ``rpc_error``, ``malformed_response``). Transport
    failures never reach here: the boundary reports them as an outcome and the
    gateway raises a typed error the advisory caller catches.
    """

    object_id: str
    object_type: str | None = None
    fields: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


def _redact(secret: str, text: str) -> str:
    """Remove ``secret`` from error text before it can be logged or raised."""
    if secret and text and secret in text:
        return text.replace(secret, "[redacted]")
    return text


class SuiRpcError(RuntimeError):
    """A Sui RPC failure whose message is already safe to log.

    The boundary reports a failed call's reason to its metric sink, which is a
    log line. The dependency's exception is converted here so the sink only ever
    sees the redacted message.
    """


def _object_payload(object_id: str) -> dict[str, Any]:
    """The documented JSON-RPC body for a Sui object read."""
    return {
        "jsonrpc": "2.0",
        "id": 1,
        "method": GET_OBJECT_METHOD,
        "params": [object_id, {"showContent": True, "showType": True}],
    }


def _parse_object(object_id: str, body: Any) -> SuiObjectResult:
    """Normalise a Sui ``sui_getObject`` response into a result.

    Handles the two shapes Sui uses: ``result.data`` for an object and an
    ``error`` member for a missing object or a rejected request.
    """
    if not isinstance(body, dict):
        return SuiObjectResult(object_id=object_id, error="malformed_response")

    error = body.get("error")
    if error:
        message = ""
        code = None
        if isinstance(error, dict):
            code = error.get("code")
            message = str(error.get("message") or "")
        if code == OBJECT_NOT_FOUND_CODE or any(
            marker in message.lower() for marker in _OBJECT_NOT_FOUND_MARKERS
        ):
            return SuiObjectResult(object_id=object_id, error="object_not_found")
        return SuiObjectResult(object_id=object_id, error="rpc_error")

    result = body.get("result")
    if not isinstance(result, dict):
        return SuiObjectResult(object_id=object_id, error="malformed_response")

    data = result.get("data")
    if not isinstance(data, dict):
        return SuiObjectResult(object_id=object_id, error="object_not_found")

    content = data.get("content")
    fields: dict[str, Any] = {}
    content_type = None
    if isinstance(content, dict):
        content_fields = content.get("fields")
        if isinstance(content_fields, dict):
            fields = content_fields
        content_type = content.get("type")

    object_type = data.get("type") or content_type
    return SuiObjectResult(
        object_id=str(data.get("objectId") or object_id),
        object_type=object_type if isinstance(object_type, str) else None,
        fields=fields,
    )


class TatumSuiGateway:
    """Async wrapper around the Tatum Sui gateway's JSON-RPC endpoint."""

    def __init__(
        self,
        boundary: Boundary,
        rpc_url: str,
        api_key: str,
        client: Any | None = None,
    ) -> None:
        self._boundary = boundary
        self._rpc_url = rpc_url
        self._api_key = api_key
        self._client = client

    @property
    def configured(self) -> bool:
        """True when both the endpoint and the network's key are present."""
        return bool(self._rpc_url and self._api_key)

    def __repr__(self) -> str:
        return (
            f"TatumSuiGateway(rpc_url={self._rpc_url!r}, "
            f"configured={self.configured})"
        )

    def __str__(self) -> str:
        return self.__repr__()

    def _http(self) -> Any:
        """The HTTP client, built on first use from the injected or own config."""
        if self._client is None:
            import httpx

            self._client = httpx.AsyncClient(
                timeout=self._boundary.policy.timeout_seconds
            )
        return self._client

    async def get_object(self, object_id: str) -> SuiObjectResult:
        """Read one Sui object, or report why it could not be read.

        Raises :class:`DependencyUnavailableError` when the gateway could not
        answer at all (timeout, transport error, breaker open). The advisory
        caller catches it and reports the reference as unverified.
        """
        if not object_id:
            raise ValueError("get_object requires an object id (operation=get_object)")

        payload = _object_payload(object_id)
        headers = {"x-api-key": self._api_key, "content-type": "application/json"}

        async def operation() -> Any:
            try:
                response = await self._http().post(
                    self._rpc_url, json=payload, headers=headers
                )
                response.raise_for_status()
                return response.json()
            except Exception as exc:  # noqa: BLE001 - redact before the boundary logs it
                raise SuiRpcError(
                    _redact(self._api_key, f"{type(exc).__name__}: {exc}")
                ) from None

        outcome = await self._boundary.call(
            operation,
            failure_fallback(DEPENDENCY, "sui_get_object_failed"),
            idempotent=True,
        )
        if not outcome.ok:
            raise DependencyUnavailableError(
                DEPENDENCY,
                f"{DEPENDENCY}: get_object failed against {self._rpc_url}: "
                f"{_redact(self._api_key, outcome.error or 'no response')}",
            )
        return _parse_object(object_id, outcome.value)
