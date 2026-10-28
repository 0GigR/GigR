"""Check the Tatum Sui gRPC gateway: configuration, service info, one object.

    cd backend
    python scripts/check_tatum_sui.py
    python scripts/check_tatum_sui.py 0x<walrus-blob-object-id>

Sui is served by Tatum over gRPC only. The JSON-RPC hosts
(sui-mainnet.gateway.tatum.io) answer 404 on every path for this account; the
host this script uses is sui-mainnet-grpc.gateway.tatum.io. The key travels in
the x-api-key gRPC metadata and is never printed.

Exit codes: 0 the gateway answered, 1 configuration is incomplete, 2 the call
failed.
"""

from __future__ import annotations

import asyncio
import sys

# Allow running from the backend/ directory directly.
sys.path.insert(0, ".")

from app.core.config import settings  # noqa: E402
from app.core.gateways.tatum_sui_gateway import (  # noqa: E402
    READ_MASK_PATHS,
    WALRUS_BLOB_TYPE_SUFFIX,
    grpc_endpoint,
)

REQUEST_TIMEOUT_SECONDS = 15.0

try:
    from grpclib.client import Channel
    from grpclib.exceptions import GRPCError
    from pysui.sui.sui_grpc.suimsgs.google.protobuf import FieldMask
    from pysui.sui.sui_grpc.suimsgs.sui.rpc.v2 import (
        GetObjectRequest,
        GetServiceInfoRequest,
        LedgerServiceStub,
    )
except ImportError as exc:  # pragma: no cover - the diagnostic still prints
    print(f"[FAIL] the gRPC client is not installed: {type(exc).__name__}")
    print("      Run: venv/bin/python -m pip install -r requirements.txt")
    raise SystemExit(2)


def _ok(message: str) -> None:
    print(f"[OK] {message}")


def _fail(message: str) -> None:
    print(f"[FAIL] {message}")


def _info(message: str) -> None:
    print(f"      {message}")


def _redact(text: str, key: str) -> str:
    """Return text without the API key, even when it appears in an error."""
    if key and text and key in text:
        return text.replace(key, "[redacted]")
    return text


def _key_variable() -> str:
    """The environment variable the selected network reads its key from."""
    if settings.TATUM_SUI_NETWORK == "mainnet":
        return "TATUM_API_KEY_MAINNET"
    return "TATUM_API_KEY_TESTNET"


def _owner_kind_name(kind: object) -> str:
    """The owner kind enum as the word the API reports, or ``(unset)``."""
    name = getattr(kind, "name", None)
    return name if isinstance(name, str) else "(unset)"


def _status_name(status: object) -> str:
    name = getattr(status, "name", None)
    return name if isinstance(name, str) else str(status)


def _grpc_message(error: GRPCError) -> str:
    """The human part of a GRPCError, whichever attribute this version uses."""
    message = getattr(error, "message", None)
    return message if isinstance(message, str) and message else str(error)


def _explain_grpc_error(status: object, detail: str, key: str) -> None:
    """Print the one next action for each gRPC status the gateway returns."""
    name = _status_name(status)
    detail = _redact(detail, key)
    if name == "UNAUTHENTICATED":
        _fail("gRPC UNAUTHENTICATED: Tatum rejected the API key.")
        _info(f"Check {_key_variable()}: it must be the API key from the Tatum")
        _info("dashboard, not the dashboard account ID. Create a fresh key if unsure.")
    elif name == "PERMISSION_DENIED":
        _fail("gRPC PERMISSION_DENIED: the key may not use Sui on this plan.")
        _info("Open the Tatum dashboard and confirm Sui is enabled.")
    elif name == "NOT_FOUND":
        _fail("gRPC NOT_FOUND: the object does not exist on this network.")
        _info("Check the object id and the network. This is not a transport failure.")
    elif name == "DEADLINE_EXCEEDED":
        _fail(f"gRPC DEADLINE_EXCEEDED after {REQUEST_TIMEOUT_SECONDS:.0f}s.")
        _info("The gateway is reachable but slow; try again or raise the timeout.")
    elif name == "UNAVAILABLE":
        _fail("gRPC UNAVAILABLE: the gateway did not answer (or rate-limited us).")
        _info("Check the host and port, and whether a key is being sent.")
        _info(f"Detail: {detail[:300]}")
    elif name == "INVALID_ARGUMENT":
        _fail("gRPC INVALID_ARGUMENT: the gateway rejected the request shape.")
        _info(f"Detail: {detail[:300]}")
    else:
        _fail(f"gRPC {name}: {detail[:300]}")


async def _check() -> int:
    print("== Tatum Sui configuration (gRPC)")
    print(f"  FEATURE_TATUM_SUI   = {settings.FEATURE_TATUM_SUI}")
    print(f"  TATUM_SUI_NETWORK   = {settings.TATUM_SUI_NETWORK}")
    print(f"  TATUM_SUI_GRPC_URL  = {settings.TATUM_SUI_GRPC_URL or '(unset)'}")
    key = settings.tatum_sui_api_key
    key_state = f"set, {len(key)} chars" if key else "(unset)"
    print(f"  {_key_variable():<19} = {key_state}")

    if not settings.FEATURE_TATUM_SUI:
        _fail("FEATURE_TATUM_SUI is off, so the verification endpoint reports")
        _info("feature_disabled and never calls Tatum. Turn the flag on first.")
        return 1
    if not settings.TATUM_SUI_GRPC_URL:
        _fail("TATUM_SUI_GRPC_URL is unset. Use the gRPC host:")
        _info("https://sui-mainnet-grpc.gateway.tatum.io")
        return 1
    if not key:
        _fail(f"{_key_variable()} is unset for network {settings.TATUM_SUI_NETWORK}.")
        return 1

    channel = None
    try:
        host, port, secure = grpc_endpoint(settings.TATUM_SUI_GRPC_URL)
        channel = Channel(host, port, ssl=secure)
        stub = LedgerServiceStub(channel, metadata=(("x-api-key", key),))

        print("\n== Service info")
        try:
            info = await stub.get_service_info(
                GetServiceInfoRequest(), timeout=REQUEST_TIMEOUT_SECONDS
            )
        except GRPCError as exc:
            _explain_grpc_error(exc.status, _grpc_message(exc), key)
            return 2
        _ok(f"Authenticated and reachable: chain={info.chain}")
        _info(f"epoch: {info.epoch}")
        _info(f"checkpoint height: {info.checkpoint_height}")

        object_id = sys.argv[1].strip() if len(sys.argv) > 1 else ""
        if not object_id:
            _info("Pass an object id to test the exact read the app makes:")
            _info("python scripts/check_tatum_sui.py 0x<walrus-blob-object-id>")
            return 0

        print("\n== Object read (the call the app makes)")
        request = GetObjectRequest(
            object_id=object_id,
            read_mask=FieldMask(paths=list(READ_MASK_PATHS)),
        )
        try:
            response = await stub.get_object(request, timeout=REQUEST_TIMEOUT_SECONDS)
        except GRPCError as exc:
            _explain_grpc_error(exc.status, _grpc_message(exc), key)
            return 2

        obj = response.object
        if obj is None:
            _fail("The gateway returned no object.")
            return 2
        object_type = obj.object_type or "(unknown)"
        _ok(f"Object type: {object_type}")
        _info(f"version: {obj.version}")
        _info(f"owner kind: {_owner_kind_name(getattr(obj.owner, 'kind', None))}")
        if object_type.lower().endswith(WALRUS_BLOB_TYPE_SUFFIX.lower()):
            _info("This is a Walrus blob; the app verifies its certified_epoch.")
        else:
            _info("This is not a Walrus blob; the app reports not_a_walrus_blob.")
        return 0
    except TimeoutError:
        _fail(f"The gRPC call timed out after {REQUEST_TIMEOUT_SECONDS:.0f}s.")
        return 2
    except ValueError as exc:
        _fail(f"Invalid TATUM_SUI_GRPC_URL: {_redact(str(exc), key)}")
        return 1
    except OSError as exc:
        _fail(f"Transport error: {type(exc).__name__}: {_redact(str(exc), key)}")
        return 2
    finally:
        if channel is not None:
            channel.close()


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_check()))
