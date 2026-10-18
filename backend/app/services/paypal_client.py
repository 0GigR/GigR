"""Thin async client for the PayPal REST APIs Gigr's escrow is built on.

  * Orders v2     – create the checkout the client approves, then capture it
  * Payments v2   – refund a capture (full or partial)
  * Payouts v1    – pay the provider's PayPal account when escrow is released
  * Webhooks v1   – verify that an incoming event really came from PayPal

Every state-changing call carries an idempotency key (``PayPal-Request-Id`` for
Orders/Payments, ``sender_batch_id`` for Payouts) so a retried request — a
network blip, a double click, a webhook racing the browser — can never move
money twice.
"""
from __future__ import annotations

import asyncio
import base64
import logging
import time
from decimal import Decimal
from typing import Any, Dict, List, Optional

import httpx

from ..core.config import settings

logger = logging.getLogger(__name__)

_TIMEOUT = httpx.Timeout(30.0, connect=10.0)
_RETRY_STATUS = {500, 502, 503, 504}


class PayPalError(Exception):
    """A PayPal API call failed. ``name`` is PayPal's machine-readable error."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int = 0,
        name: str = "",
        debug_id: str = "",
        details: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.name = name
        self.debug_id = debug_id
        self.details = details or []

    @property
    def issues(self) -> List[str]:
        """PayPal's fine-grained issue codes (e.g. ``ORDER_ALREADY_CAPTURED``)."""
        return [str(d.get("issue", "")) for d in self.details if d.get("issue")]

    def __str__(self) -> str:  # pragma: no cover - cosmetic
        bits = [self.message]
        if self.name:
            bits.append(f"[{self.name}]")
        if self.issues:
            bits.append("issues=" + ",".join(self.issues))
        if self.debug_id:
            bits.append(f"debug_id={self.debug_id}")
        return " ".join(bits)


class PayPalNotConfigured(PayPalError):
    """PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are missing."""


def money(value: Decimal | float | str) -> str:
    """PayPal wants amounts as strings with exactly two decimals."""
    return f"{Decimal(str(value)).quantize(Decimal('0.01')):.2f}"


# ── OAuth ────────────────────────────────────────────────────────────────────
_token: Dict[str, Any] = {}
_token_lock = asyncio.Lock()


async def _get_access_token(client: httpx.AsyncClient) -> str:
    if not settings.paypal_enabled:
        raise PayPalNotConfigured(
            "PayPal is not configured (set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET).",
            status_code=503,
            name="NOT_CONFIGURED",
        )
    async with _token_lock:
        # Refresh a minute early so a token never expires mid-request.
        if _token.get("value") and _token.get("expires_at", 0) > time.time() + 60:
            return _token["value"]
        creds = f"{settings.PAYPAL_CLIENT_ID}:{settings.PAYPAL_CLIENT_SECRET}"
        basic = base64.b64encode(creds.encode()).decode()
        resp = await client.post(
            f"{settings.paypal_base_url}/v1/oauth2/token",
            headers={"Authorization": f"Basic {basic}"},
            data={"grant_type": "client_credentials"},
        )
        if resp.status_code != 200:
            raise PayPalError(
                "PayPal authentication failed — check PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET "
                f"and that PAYPAL_ENV={settings.PAYPAL_ENV} matches the app's mode.",
                status_code=resp.status_code,
                name="AUTH_FAILED",
            )
        body = resp.json()
        _token["value"] = body["access_token"]
        _token["expires_at"] = time.time() + int(body.get("expires_in", 300))
        return _token["value"]


def reset_token_cache() -> None:
    """Forget the cached OAuth token (tests; credential rotation)."""
    _token.clear()


# ── Transport ────────────────────────────────────────────────────────────────
async def _request(
    method: str,
    path: str,
    *,
    json_body: Any = None,
    request_id: Optional[str] = None,
    prefer_representation: bool = True,
) -> Any:
    headers: Dict[str, str] = {}
    if request_id:
        headers["PayPal-Request-Id"] = request_id
    if prefer_representation:
        headers["Prefer"] = "return=representation"

    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        attempts = 3
        for attempt in range(1, attempts + 1):
            token = await _get_access_token(client)
            try:
                resp = await client.request(
                    method,
                    f"{settings.paypal_base_url}{path}",
                    json=json_body,
                    headers={**headers, "Authorization": f"Bearer {token}"},
                )
            except httpx.TransportError as exc:
                if attempt == attempts:
                    raise PayPalError(
                        f"Could not reach PayPal: {exc}", status_code=503, name="NETWORK"
                    ) from exc
                await asyncio.sleep(0.5 * attempt)
                continue

            if resp.status_code == 401 and attempt < attempts:
                reset_token_cache()  # token revoked/expired early — fetch a new one
                continue
            if resp.status_code in _RETRY_STATUS and attempt < attempts:
                await asyncio.sleep(0.5 * attempt)
                continue
            break

    if resp.status_code >= 400:
        try:
            err = resp.json()
        except ValueError:
            err = {}
        raise PayPalError(
            err.get("message") or f"PayPal returned HTTP {resp.status_code}",
            status_code=resp.status_code,
            name=err.get("name", ""),
            debug_id=err.get("debug_id") or resp.headers.get("paypal-debug-id", ""),
            details=err.get("details") or [],
        )
    if resp.status_code == 204 or not resp.content:
        return {}
    return resp.json()


# ── Orders v2 ────────────────────────────────────────────────────────────────
def approval_url(order: Dict[str, Any]) -> Optional[str]:
    """The link the payer opens to approve the order."""
    for link in order.get("links") or []:
        if link.get("rel") in ("payer-action", "approve"):
            return link.get("href")
    return None


async def create_order(
    *,
    amount: Decimal,
    currency: str,
    reference_id: str,
    description: str,
    return_url: str,
    cancel_url: str,
    request_id: str,
    custom_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Create an order that captures immediately once the payer approves it."""
    body = {
        "intent": "CAPTURE",
        "purchase_units": [
            {
                "reference_id": reference_id[:256],
                "custom_id": (custom_id or reference_id)[:127],
                "description": description[:127],
                "amount": {"currency_code": currency, "value": money(amount)},
            }
        ],
        "payment_source": {
            "paypal": {
                "experience_context": {
                    "brand_name": "Gigr Escrow",
                    "user_action": "PAY_NOW",
                    "shipping_preference": "NO_SHIPPING",
                    "landing_page": "LOGIN",
                    "return_url": return_url,
                    "cancel_url": cancel_url,
                }
            }
        },
    }
    return await _request("POST", "/v2/checkout/orders", json_body=body, request_id=request_id)


async def get_order(order_id: str) -> Dict[str, Any]:
    return await _request("GET", f"/v2/checkout/orders/{order_id}", prefer_representation=False)


async def capture_order(order_id: str, *, request_id: str) -> Dict[str, Any]:
    return await _request(
        "POST", f"/v2/checkout/orders/{order_id}/capture", json_body={}, request_id=request_id
    )


def capture_from_order(order: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Pull the (first) capture object out of an order/capture response."""
    for unit in order.get("purchase_units") or []:
        captures = ((unit.get("payments") or {}).get("captures")) or []
        if captures:
            return captures[0]
    return None


# ── Payments v2 ──────────────────────────────────────────────────────────────
async def refund_capture(
    capture_id: str,
    *,
    request_id: str,
    amount: Optional[Decimal] = None,
    currency: Optional[str] = None,
    note: Optional[str] = None,
    invoice_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Refund a capture. Omit ``amount`` for a full refund."""
    body: Dict[str, Any] = {}
    if amount is not None:
        body["amount"] = {"value": money(amount), "currency_code": currency or "USD"}
    if note:
        body["note_to_payer"] = note[:255]
    if invoice_id:
        body["invoice_id"] = invoice_id[:127]
    return await _request(
        "POST", f"/v2/payments/captures/{capture_id}/refund", json_body=body, request_id=request_id
    )


# ── Payouts v1 ───────────────────────────────────────────────────────────────
async def create_payout(
    *,
    receiver_email: str,
    amount: Decimal,
    currency: str,
    sender_batch_id: str,
    sender_item_id: str,
    note: str,
    email_subject: str = "You've been paid on Gigr",
) -> Dict[str, Any]:
    """Send money to a PayPal account. ``sender_batch_id`` must be unique per attempt."""
    body = {
        "sender_batch_header": {
            "sender_batch_id": sender_batch_id,
            "email_subject": email_subject[:255],
            "email_message": note[:1000],
        },
        "items": [
            {
                "recipient_type": "EMAIL",
                "receiver": receiver_email,
                "amount": {"value": money(amount), "currency": currency},
                "note": note[:4000],
                "sender_item_id": sender_item_id[:30],
            }
        ],
    }
    return await _request(
        "POST", "/v1/payments/payouts", json_body=body, prefer_representation=False
    )


async def get_payout(batch_id: str) -> Dict[str, Any]:
    return await _request("GET", f"/v1/payments/payouts/{batch_id}", prefer_representation=False)


# ── Webhooks ─────────────────────────────────────────────────────────────────
async def verify_webhook(headers: Dict[str, str], event: Dict[str, Any]) -> bool:
    """Ask PayPal whether this webhook delivery is authentic."""
    if not settings.PAYPAL_WEBHOOK_ID:
        logger.warning("[paypal] PAYPAL_WEBHOOK_ID not set — cannot verify webhook signatures")
        return False
    h = {k.lower(): v for k, v in headers.items()}
    try:
        body = {
            "auth_algo": h["paypal-auth-algo"],
            "cert_url": h["paypal-cert-url"],
            "transmission_id": h["paypal-transmission-id"],
            "transmission_sig": h["paypal-transmission-sig"],
            "transmission_time": h["paypal-transmission-time"],
            "webhook_id": settings.PAYPAL_WEBHOOK_ID,
            "webhook_event": event,
        }
    except KeyError:
        return False
    result = await _request(
        "POST",
        "/v1/notifications/verify-webhook-signature",
        json_body=body,
        prefer_representation=False,
    )
    return result.get("verification_status") == "SUCCESS"
