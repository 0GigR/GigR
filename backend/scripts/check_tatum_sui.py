"""Check the Tatum Sui gateway: configuration, authentication, and one call.

    cd backend
    python scripts/check_tatum_sui.py
    python scripts/check_tatum_sui.py 0x<walrus-blob-object-id>

The hosted Tatum gateway answers 404 when no usable API key reaches it and 401
when a key is rejected, so a 404 usually means the request was unauthenticated
rather than that the endpoint is wrong. A 415 means a JSON request was sent to
the gRPC host instead of the JSON-RPC host. This script says which of those
happened and never prints the key.

Exit codes: 0 the gateway answered, 1 configuration is incomplete, 2 the call
failed.
"""

from __future__ import annotations

import asyncio
import sys

import httpx

# Allow running from the backend/ directory directly.
sys.path.insert(0, ".")

from app.core.config import settings  # noqa: E402

CHECKPOINT_METHOD = "sui_getLatestCheckpointSequenceNumber"
OBJECT_METHOD = "sui_getObject"
WALRUS_JSON_RPC = "https://sui-mainnet.gateway.tatum.io"


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


def _payload(method: str, params: list) -> dict:
    return {"jsonrpc": "2.0", "id": 1, "method": method, "params": params}


def _explain(status: int, body: str, key: str) -> None:
    """Print the one next action for each status the gateway is known to return."""
    body = _redact(body, key)
    if status == 401:
        _fail("HTTP 401: Tatum rejected the API key.")
        _info(f"Check {_key_variable()}: it must be the API key from the Tatum")
        _info("dashboard, not the dashboard account ID. Create a fresh key if unsure.")
    elif status == 403:
        _fail("HTTP 403: the key is valid but this network or plan is not allowed.")
        _info("Open the Tatum dashboard and confirm Sui is enabled for the plan.")
    elif status == 404:
        _fail("HTTP 404: no API key reached Tatum.")
        _info("The endpoint is correct; Tatum returns 404 to unauthenticated calls.")
        _info(f"Confirm {_key_variable()} is set for the selected network and has")
        _info("no surrounding whitespace (the app trims it, an empty value stays empty).")
    elif status == 415:
        _fail("HTTP 415: this host speaks gRPC, not JSON.")
        _info(f"Set TATUM_SUI_RPC_URL={WALRUS_JSON_RPC} (the JSON-RPC host).")
    else:
        _fail(f"HTTP {status}: {body[:300]}")


async def main() -> int:
    print("== Tatum Sui configuration")
    print(f"  FEATURE_TATUM_SUI   = {settings.FEATURE_TATUM_SUI}")
    print(f"  TATUM_SUI_NETWORK   = {settings.TATUM_SUI_NETWORK}")
    print(f"  TATUM_SUI_RPC_URL   = {settings.TATUM_SUI_RPC_URL or '(unset)'}")
    key = settings.tatum_sui_api_key
    print(f"  {_key_variable():<19} = {'set, ' + str(len(key)) + ' chars' if key else '(unset)'}")

    if not settings.FEATURE_TATUM_SUI:
        _fail("FEATURE_TATUM_SUI is off, so the verification endpoint reports")
        _info("feature_disabled and never calls Tatum. Turn the flag on first.")
        return 1
    if not settings.TATUM_SUI_RPC_URL:
        _fail("TATUM_SUI_RPC_URL is unset. Use the JSON-RPC host:")
        _info(WALRUS_JSON_RPC)
        return 1
    if not key:
        _fail(f"{_key_variable()} is unset for network {settings.TATUM_SUI_NETWORK}.")
        return 1

    headers = {
        "x-api-key": key,
        "content-type": "application/json",
        "accept": "application/json",
    }

    print("\n== Checkpoint call")
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                settings.TATUM_SUI_RPC_URL,
                json=_payload(CHECKPOINT_METHOD, []),
                headers=headers,
            )
            body = response.text
    except Exception as exc:  # noqa: BLE001 - a diagnostic prints, it does not raise
        _fail(f"Transport error: {type(exc).__name__}: {_redact(str(exc), key)}")
        return 2

    print(f"  {CHECKPOINT_METHOD} -> HTTP {response.status_code}")
    if response.status_code != 200:
        _explain(response.status_code, body, key)
        return 2
    try:
        result = response.json().get("result")
    except ValueError:
        _fail(f"HTTP 200 but the body is not JSON: {_redact(body, key)[:200]}")
        return 2
    _ok(f"Authenticated and reachable. Latest checkpoint: {result}")

    object_id = sys.argv[1].strip() if len(sys.argv) > 1 else ""
    if not object_id:
        _info("Pass an object id to test the exact read the app makes:")
        _info("python scripts/check_tatum_sui.py 0x<walrus-blob-object-id>")
        return 0

    print("\n== Object read (the call the app makes)")
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                settings.TATUM_SUI_RPC_URL,
                json=_payload(OBJECT_METHOD, [object_id, {"showContent": True, "showType": True}]),
                headers=headers,
            )
    except Exception as exc:  # noqa: BLE001 - a diagnostic prints, it does not raise
        _fail(f"Transport error: {type(exc).__name__}: {_redact(str(exc), key)}")
        return 2

    print(f"  {OBJECT_METHOD} -> HTTP {response.status_code}")
    if response.status_code != 200:
        _explain(response.status_code, response.text, key)
        return 2
    try:
        payload = response.json()
    except ValueError:
        _fail("HTTP 200 but the body is not JSON.")
        return 2
    if payload.get("error"):
        _fail(f"Sui answered with an RPC error: {payload.get('error')}")
        return 2
    data = (payload.get("result") or {}).get("data") or {}
    object_type = data.get("type") or ((data.get("content") or {}).get("type")) or "(unknown)"
    _ok(f"Object type: {object_type}")
    if "blob" in str(object_type).lower():
        _info("This is a Walrus blob; the app can verify its certified_epoch.")
    else:
        _info("This is not a Walrus blob; the app reports 'not_a_walrus_blob'.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
