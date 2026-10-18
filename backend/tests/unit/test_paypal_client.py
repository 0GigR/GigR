"""PayPal REST client: OAuth caching, idempotency headers, error mapping, webhook verify."""
import json
from decimal import Decimal

import httpx
import pytest
import respx

from app.core.config import settings
from app.services import paypal_client as pp

BASE = "https://api-m.sandbox.paypal.com"


@pytest.fixture(autouse=True)
def _configured(monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_CLIENT_ID", "cid")
    monkeypatch.setattr(settings, "PAYPAL_CLIENT_SECRET", "secret")
    monkeypatch.setattr(settings, "PAYPAL_ENV", "sandbox")
    monkeypatch.setattr(settings, "PAYPAL_WEBHOOK_ID", "WH-123")
    pp.reset_token_cache()
    yield
    pp.reset_token_cache()


def _token_route(router):
    return router.post(f"{BASE}/v1/oauth2/token").mock(
        return_value=httpx.Response(200, json={"access_token": "tok", "expires_in": 3600})
    )


def test_money_formats_two_decimals():
    assert pp.money(Decimal("10")) == "10.00"
    assert pp.money("3.456") == "3.46"
    assert pp.money(0.1 + 0.2) == "0.30"


async def test_not_configured_raises(monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_CLIENT_ID", "")
    with pytest.raises(pp.PayPalNotConfigured):
        await pp.get_order("X")


@respx.mock
async def test_create_order_payload_idempotency_and_token_cache():
    token = _token_route(respx)
    order_route = respx.post(f"{BASE}/v2/checkout/orders").mock(
        return_value=httpx.Response(201, json={
            "id": "ORD1", "status": "PAYER_ACTION_REQUIRED",
            "links": [{"rel": "payer-action", "href": "https://paypal.test/approve"}],
        })
    )
    order = await pp.create_order(
        amount=Decimal("12.5"), currency="USD", reference_id="job-1", description="Fix sink",
        return_url="https://app/return", cancel_url="https://app/cancel", request_id="req-1",
    )
    assert order["id"] == "ORD1"
    assert pp.approval_url(order) == "https://paypal.test/approve"

    sent = order_route.calls.last.request
    assert sent.headers["PayPal-Request-Id"] == "req-1"
    assert sent.headers["Authorization"] == "Bearer tok"
    body = json.loads(sent.content)
    assert body["intent"] == "CAPTURE"
    assert body["purchase_units"][0]["amount"] == {"currency_code": "USD", "value": "12.50"}
    assert body["purchase_units"][0]["custom_id"] == "job-1"
    ctx = body["payment_source"]["paypal"]["experience_context"]
    assert ctx["return_url"] == "https://app/return" and ctx["user_action"] == "PAY_NOW"

    # A second call reuses the cached OAuth token.
    await pp.create_order(
        amount=Decimal("1"), currency="USD", reference_id="job-2", description="x",
        return_url="r", cancel_url="c", request_id="req-2",
    )
    assert token.call_count == 1


@respx.mock
async def test_error_is_mapped_with_issue_codes():
    _token_route(respx)
    respx.post(f"{BASE}/v2/checkout/orders/ORD1/capture").mock(
        return_value=httpx.Response(422, json={
            "name": "UNPROCESSABLE_ENTITY", "message": "Order already captured",
            "debug_id": "dbg1", "details": [{"issue": "ORDER_ALREADY_CAPTURED"}],
        })
    )
    with pytest.raises(pp.PayPalError) as ei:
        await pp.capture_order("ORD1", request_id="cap-1")
    err = ei.value
    assert err.status_code == 422 and err.debug_id == "dbg1"
    assert "ORDER_ALREADY_CAPTURED" in err.issues


@respx.mock
async def test_retries_transient_5xx_then_succeeds():
    _token_route(respx)
    route = respx.get(f"{BASE}/v2/checkout/orders/ORD9").mock(
        side_effect=[httpx.Response(503, json={}), httpx.Response(200, json={"id": "ORD9"})]
    )
    assert (await pp.get_order("ORD9"))["id"] == "ORD9"
    assert route.call_count == 2


@respx.mock
async def test_refund_full_has_empty_body_and_partial_has_amount():
    _token_route(respx)
    route = respx.post(f"{BASE}/v2/payments/captures/CAP1/refund").mock(
        return_value=httpx.Response(201, json={"id": "REF1", "status": "COMPLETED"})
    )
    await pp.refund_capture("CAP1", request_id="r-full")
    assert json.loads(route.calls.last.request.content) == {}
    await pp.refund_capture("CAP1", request_id="r-part", amount=Decimal("4"), currency="USD", note="n")
    body = json.loads(route.calls.last.request.content)
    assert body["amount"] == {"value": "4.00", "currency_code": "USD"}


@respx.mock
async def test_payout_payload():
    _token_route(respx)
    route = respx.post(f"{BASE}/v1/payments/payouts").mock(
        return_value=httpx.Response(201, json={"batch_header": {"payout_batch_id": "B1", "batch_status": "PENDING"}})
    )
    res = await pp.create_payout(
        receiver_email="pro@example.com", amount=Decimal("9.5"), currency="USD",
        sender_batch_id="batch-1", sender_item_id="item-1", note="paid",
    )
    assert res["batch_header"]["payout_batch_id"] == "B1"
    body = json.loads(route.calls.last.request.content)
    assert body["sender_batch_header"]["sender_batch_id"] == "batch-1"
    assert body["items"][0] == {
        "recipient_type": "EMAIL", "receiver": "pro@example.com",
        "amount": {"value": "9.50", "currency": "USD"}, "note": "paid", "sender_item_id": "item-1",
    }


@respx.mock
async def test_webhook_verification():
    _token_route(respx)
    route = respx.post(f"{BASE}/v1/notifications/verify-webhook-signature").mock(
        return_value=httpx.Response(200, json={"verification_status": "SUCCESS"})
    )
    headers = {
        "PAYPAL-AUTH-ALGO": "SHA256withRSA", "PAYPAL-CERT-URL": "https://c", "PAYPAL-TRANSMISSION-ID": "t",
        "PAYPAL-TRANSMISSION-SIG": "s", "PAYPAL-TRANSMISSION-TIME": "now",
    }
    assert await pp.verify_webhook(headers, {"id": "WH-EVT"}) is True
    assert json.loads(route.calls.last.request.content)["webhook_id"] == "WH-123"

    # Missing signature headers → not authentic, and PayPal is never asked.
    assert await pp.verify_webhook({}, {"id": "x"}) is False


@respx.mock
async def test_webhook_rejected_when_paypal_says_failure():
    _token_route(respx)
    respx.post(f"{BASE}/v1/notifications/verify-webhook-signature").mock(
        return_value=httpx.Response(200, json={"verification_status": "FAILURE"})
    )
    headers = {k: "v" for k in (
        "paypal-auth-algo", "paypal-cert-url", "paypal-transmission-id",
        "paypal-transmission-sig", "paypal-transmission-time",
    )}
    assert await pp.verify_webhook(headers, {}) is False
