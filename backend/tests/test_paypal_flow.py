"""End-to-end PayPal escrow flow through the real API + database.

PayPal itself is replaced by an in-memory fake that behaves like the sandbox
(an order must be *approved* before it can be captured, captures can be refunded,
payouts get batch ids). Everything else — routes, auth, ORM, ledger — is real.
"""
from __future__ import annotations

import itertools
import uuid
from decimal import Decimal

import pytest
from sqlalchemy import text

from conftest import RUN_ID, auth_headers, register_user
from app.core.config import settings
from app.core.database import engine
from app.services import paypal_client as pp
from app.services import paypal_escrow


# Shared across tests: the DB outlives each test, so ids must not repeat within a run
# (a per-instance counter made two tests' orders collide on `paypal_order_id`).
_IDS = itertools.count(1)


class FakePayPal:
    """Just enough of PayPal's REST behaviour for the escrow lifecycle."""

    def __init__(self) -> None:
        self._ids = _IDS
        self.orders: dict[str, dict] = {}
        self.captures: dict[str, dict] = {}
        self.refunds: list[dict] = []
        self.payouts: list[dict] = []

    # -- the surface paypal_escrow uses -------------------------------------
    async def create_order(self, *, amount, currency, reference_id, description,
                           return_url, cancel_url, request_id, custom_id=None):
        oid = f"ORD-{RUN_ID}-{next(self._ids)}"
        self.orders[oid] = {
            "id": oid, "status": "PAYER_ACTION_REQUIRED", "amount": Decimal(str(amount)),
            "currency": currency, "custom_id": custom_id or reference_id,
            "return_url": return_url, "captures": [],
        }
        return self._view(oid)

    async def get_order(self, order_id):
        if order_id not in self.orders:
            raise pp.PayPalError("not found", status_code=404, name="RESOURCE_NOT_FOUND")
        return self._view(order_id)

    async def capture_order(self, order_id, *, request_id):
        order = self.orders.get(order_id)
        if not order:
            raise pp.PayPalError("not found", status_code=404, name="RESOURCE_NOT_FOUND")
        if order["status"] == "COMPLETED":
            raise pp.PayPalError("dup", status_code=422, details=[{"issue": "ORDER_ALREADY_CAPTURED"}])
        if order["status"] != "APPROVED":
            raise pp.PayPalError("not approved", status_code=422, details=[{"issue": "ORDER_NOT_APPROVED"}])
        cap_id = f"CAP-{RUN_ID}-{next(self._ids)}"
        self.captures[cap_id] = {"amount": order["amount"], "refunded": Decimal("0")}
        order["captures"] = [cap_id]
        order["status"] = "COMPLETED"
        return self._view(order_id)

    async def refund_capture(self, capture_id, *, request_id, amount=None, currency=None,
                             note=None, invoice_id=None):
        cap = self.captures[capture_id]
        value = Decimal(str(amount)) if amount is not None else cap["amount"] - cap["refunded"]
        assert cap["refunded"] + value <= cap["amount"], "refund exceeds capture"
        cap["refunded"] += value
        ref = {"id": f"REF-{RUN_ID}-{next(self._ids)}", "status": "COMPLETED", "amount": value,
               "capture_id": capture_id}
        self.refunds.append(ref)
        return {"id": ref["id"], "status": "COMPLETED"}

    async def create_payout(self, *, receiver_email, amount, currency, sender_batch_id,
                            sender_item_id, note, email_subject=""):
        assert all(p["sender_batch_id"] != sender_batch_id for p in self.payouts), "duplicate batch id"
        batch = {"sender_batch_id": sender_batch_id, "receiver": receiver_email,
                 "amount": Decimal(str(amount)), "id": f"PAYOUT-{RUN_ID}-{next(self._ids)}"}
        self.payouts.append(batch)
        return {"batch_header": {"payout_batch_id": batch["id"], "batch_status": "PENDING"}}

    async def verify_webhook(self, headers, event):
        return headers.get("paypal-transmission-id") == "valid"

    # -- helpers -------------------------------------------------------------
    def approve(self, order_id: str) -> None:
        self.orders[order_id]["status"] = "APPROVED"

    def _view(self, order_id: str) -> dict:
        o = self.orders[order_id]
        view = {
            "id": o["id"], "status": o["status"],
            "links": [{"rel": "payer-action", "href": f"https://paypal.test/approve/{o['id']}"}],
            "purchase_units": [{"custom_id": o["custom_id"]}],
        }
        if o["captures"]:
            cid = o["captures"][0]
            view["purchase_units"][0]["payments"] = {"captures": [{
                "id": cid, "status": "COMPLETED",
                "amount": {"value": f"{self.captures[cid]['amount']:.2f}", "currency_code": o["currency"]},
            }]}
        return view


@pytest.fixture
def fake_paypal(monkeypatch) -> FakePayPal:
    fake = FakePayPal()
    for name in ("create_order", "get_order", "capture_order", "refund_capture",
                 "create_payout", "verify_webhook"):
        monkeypatch.setattr(pp, name, getattr(fake, name))

    async def rate():
        return 1600.0

    monkeypatch.setattr(paypal_escrow, "get_ngn_usd_rate", rate)
    monkeypatch.setattr(settings, "PAYMENT_RAIL", "paypal")
    monkeypatch.setattr(settings, "PLATFORM_FEE_PERCENT", 0.0)
    return fake


async def _assigned_job(client, price: int = 16000):
    """A client + provider with a job in `assigned` state. Returns (job_id, client, provider, headers...)."""
    c = await register_user(client, role="client")
    p = await register_user(client, role="provider")
    ch, ph = auth_headers(c["token"]), auth_headers(p["token"])
    created = await client.post("/api/v1/jobs/", headers=ch, json={
        "title": f"PayPal smoke {RUN_ID}-{uuid.uuid4().hex[:5]}", "description": "Fix the sink",
        "price": price, "latitude": 6.5244, "longitude": 3.3792,
    })
    assert created.status_code == 201, created.text
    job_id = created.json()["id"]
    await client.post("/api/v1/applications/", headers=ph, json={"job_id": job_id, "message": "On it"})
    assigned = await client.post(f"/api/v1/jobs/{job_id}/assign", headers=ch, json={"provider_id": p["user_id"]})
    assert assigned.status_code == 200, assigned.text
    return job_id, c, p, ch, ph


async def _link_paypal(client, provider, headers) -> str:
    email = f"payout-{uuid.uuid4().hex[:8]}@smoke.gigr.dev"
    r = await client.patch("/api/v1/users/me", headers=headers, json={"paypal_email": email})
    assert r.status_code == 200, r.text
    assert r.json()["paypal_email"] == email
    return email


# ── config ───────────────────────────────────────────────────────────────────
async def test_public_config_reports_the_rail(client, fake_paypal):
    r = await client.get("/api/v1/config/public")
    assert r.status_code == 200
    body = r.json()
    assert body["payment_rail"] == "paypal"
    assert body["features"] == {"wallet": False, "onchain_vouches": False, "paypal_checkout": True}


async def test_wallet_endpoints_are_hidden_on_paypal_rail(client, fake_paypal):
    u = await register_user(client, role="client")
    h = auth_headers(u["token"])
    assert (await client.get("/api/v1/users/me/wallet", headers=h)).json() == {"wallet_public_key": None}
    assert (await client.get("/api/v1/users/me/balance", headers=h)).status_code == 404


# ── happy path ───────────────────────────────────────────────────────────────
async def test_full_escrow_lifecycle_fund_release_vouch(client, fake_paypal):
    job_id, c, p, ch, ph = await _assigned_job(client)

    # No PayPal linked → the client cannot fund; nothing is created at PayPal.
    blocked = await client.post(f"/api/v1/jobs/{job_id}/paypal/checkout", headers=ch)
    assert blocked.status_code == 409, blocked.text
    assert "PayPal" in blocked.json()["detail"]
    assert not fake_paypal.orders

    # The legacy single-call fund endpoint redirects callers to PayPal checkout.
    legacy = await client.post(f"/api/v1/jobs/{job_id}/fund", headers=ch)
    assert legacy.status_code == 409 and "paypal" in legacy.json()["detail"].lower()

    # Provider links PayPal → checkout works. 16,000 NGN @1600 = $10.00
    email = await _link_paypal(client, p, ph)
    co = await client.post(f"/api/v1/jobs/{job_id}/paypal/checkout", headers=ch)
    assert co.status_code == 200, co.text
    checkout = co.json()
    assert checkout["amount"] == 10.0 and checkout["currency"] == "USD"
    assert checkout["approval_url"].startswith("https://paypal.test/approve/")

    # Double-clicking reuses the same open order.
    again = await client.post(f"/api/v1/jobs/{job_id}/paypal/checkout", headers=ch)
    assert again.json()["order_id"] == checkout["order_id"]
    assert len(fake_paypal.orders) == 1

    # Only the client may capture.
    forbidden = await client.post(f"/api/v1/jobs/{job_id}/paypal/capture", headers=ph,
                                  json={"order_id": checkout["order_id"]})
    assert forbidden.status_code == 403

    # Capturing before the human approved must not fund anything.
    early = await client.post(f"/api/v1/jobs/{job_id}/paypal/capture", headers=ch,
                              json={"order_id": checkout["order_id"]})
    assert early.status_code == 409, early.text
    pay = (await client.get(f"/api/v1/jobs/{job_id}/payment", headers=ch)).json()
    assert pay["state"] == "awaiting_approval"

    # Human approves in PayPal → capture funds the escrow.
    fake_paypal.approve(checkout["order_id"])
    funded = await client.post(f"/api/v1/jobs/{job_id}/paypal/capture", headers=ch,
                               json={"order_id": checkout["order_id"]})
    assert funded.status_code == 200, funded.text
    job = funded.json()
    assert job["status"] == "funded"
    assert job["payment_rail"] == "paypal" and job["payment_state"] == "escrowed"
    assert float(job["paypal_amount"]) == 10.0

    # Capture is idempotent (browser refresh / webhook race).
    replay = await client.post(f"/api/v1/jobs/{job_id}/paypal/capture", headers=ch,
                               json={"order_id": checkout["order_id"]})
    assert replay.status_code == 200 and replay.json()["status"] == "funded"
    assert len(fake_paypal.captures) == 1

    # Provider is told; submits work; client releases.
    submitted = await client.post(f"/api/v1/jobs/{job_id}/submit-work", headers=ph)
    assert submitted.status_code == 200, submitted.text
    released = await client.post(f"/api/v1/jobs/{job_id}/release", headers=ch)
    assert released.status_code == 200, released.text
    done = released.json()
    assert done["status"] == "completed" and done["payment_state"] == "released"

    # Exactly one payout, of the full amount, to the linked PayPal email.
    assert len(fake_paypal.payouts) == 1
    assert fake_paypal.payouts[0]["receiver"] == email
    assert fake_paypal.payouts[0]["amount"] == Decimal("10.00")

    # Releasing again does not pay twice.
    await client.post(f"/api/v1/jobs/{job_id}/release", headers=ch)
    assert len(fake_paypal.payouts) == 1

    # The ledger tells the whole story, in order.
    ledger = (await client.get(f"/api/v1/jobs/{job_id}/payment", headers=ph)).json()
    assert ledger["state"] == "released"
    assert [e["kind"] for e in ledger["events"]] == ["order_created", "captured", "payout_sent"]

    # A vouch on the PayPal rail is anchored to the real payout, with no NFT mint.
    vouch = await client.post("/api/v1/vouches/", headers=ch, json={"job_id": job_id})
    assert vouch.status_code == 201, vouch.text
    assert vouch.json()["cnf_nft_id"] == f"paypal:{ledger['payout_batch_id']}"

    # …and the user's own payments ledger lists the same steps.
    mine = (await client.get("/api/v1/payments/mine", headers=ch)).json()
    assert {"order_created", "captured", "payout_sent"} <= {e["kind"] for e in mine}


# ── cancel / refund ──────────────────────────────────────────────────────────
async def test_cancel_after_funding_refunds_the_client(client, fake_paypal):
    job_id, c, p, ch, ph = await _assigned_job(client, price=8000)  # $5.00
    await _link_paypal(client, p, ph)
    order = (await client.post(f"/api/v1/jobs/{job_id}/paypal/checkout", headers=ch)).json()
    fake_paypal.approve(order["order_id"])
    await client.post(f"/api/v1/jobs/{job_id}/paypal/capture", headers=ch, json={"order_id": order["order_id"]})

    # The provider cannot cancel (and so cannot get paid) after funding.
    no = await client.post(f"/api/v1/jobs/{job_id}/cancel", headers=ph)
    assert no.status_code == 400

    cancelled = await client.post(f"/api/v1/jobs/{job_id}/cancel", headers=ch)
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"
    assert cancelled.json()["payment_state"] == "refunded"
    assert [r["amount"] for r in fake_paypal.refunds] == [Decimal("5.00")]
    assert not fake_paypal.payouts


# ── disputes: split ──────────────────────────────────────────────────────────
async def test_dispute_split_refunds_and_pays_proportionally(client, fake_paypal):
    job_id, c, p, ch, ph = await _assigned_job(client, price=16000)  # $10.00
    await _link_paypal(client, p, ph)
    order = (await client.post(f"/api/v1/jobs/{job_id}/paypal/checkout", headers=ch)).json()
    fake_paypal.approve(order["order_id"])
    await client.post(f"/api/v1/jobs/{job_id}/paypal/capture", headers=ch, json={"order_id": order["order_id"]})

    raised = await client.post("/api/v1/disputes/", headers=ch,
                               json={"job_id": job_id, "reason": "Work only half done"})
    assert raised.status_code == 201, raised.text
    dispute_id = raised.json()["id"]

    admin = {"x-admin-secret": settings.ADMIN_SECRET}
    # An extreme "split" must be rejected, not silently coerced.
    bad = await client.post(f"/api/v1/disputes/{dispute_id}/resolve", headers=admin,
                            json={"resolution": "split", "provider_percent": 100})
    assert bad.status_code == 400

    ok = await client.post(f"/api/v1/disputes/{dispute_id}/resolve", headers=admin,
                           json={"resolution": "split", "provider_percent": 70})
    assert ok.status_code == 200, ok.text
    assert [r["amount"] for r in fake_paypal.refunds] == [Decimal("3.00")]
    assert [x["amount"] for x in fake_paypal.payouts] == [Decimal("7.00")]
    assert (await client.get(f"/api/v1/jobs/{job_id}", headers=ch)).json()["status"] == "completed"


# ── webhooks ─────────────────────────────────────────────────────────────────
async def test_webhook_rejects_unsigned_and_captures_on_approval(client, fake_paypal):
    job_id, c, p, ch, ph = await _assigned_job(client)
    await _link_paypal(client, p, ph)
    order = (await client.post(f"/api/v1/jobs/{job_id}/paypal/checkout", headers=ch)).json()
    event = {"id": f"WH-{uuid.uuid4().hex}", "event_type": "CHECKOUT.ORDER.APPROVED",
             "resource": {"id": order["order_id"]}}

    forged = await client.post("/api/v1/payments/paypal/webhook", json=event)
    assert forged.status_code == 400
    assert (await client.get(f"/api/v1/jobs/{job_id}", headers=ch)).json()["status"] == "assigned"

    # PayPal-signed delivery: the human approved on their phone and never came back.
    fake_paypal.approve(order["order_id"])
    signed = await client.post("/api/v1/payments/paypal/webhook", json=event,
                               headers={"paypal-transmission-id": "valid"})
    assert signed.status_code == 200, signed.text
    assert signed.json()["outcome"] == "captured"
    assert (await client.get(f"/api/v1/jobs/{job_id}", headers=ch)).json()["status"] == "funded"

    # Redelivery of the same event is a no-op.
    dup = await client.post("/api/v1/payments/paypal/webhook", json=event,
                            headers={"paypal-transmission-id": "valid"})
    assert dup.json()["outcome"] == "duplicate"
    assert len(fake_paypal.captures) == 1


async def test_admin_ledger_requires_admin_and_returns_totals(client, fake_paypal):
    u = await register_user(client, role="client")
    assert (await client.get("/api/v1/payments/admin/ledger", headers=auth_headers(u["token"]))).status_code == 403
    r = await client.get("/api/v1/payments/admin/ledger", headers={"x-admin-secret": settings.ADMIN_SECRET})
    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body["totals"]) >= {"captured", "paid_out", "refunded", "held_in_escrow", "currency"}
    assert isinstance(body["events"], list)


@pytest.fixture(scope="module", autouse=True)
async def _paypal_columns_exist(db_ready):
    """init_db must have auto-migrated the new PayPal columns/table (fresh or old DB)."""
    async with engine.connect() as conn:
        cols = {r[0] for r in (await conn.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name='jobs'"))).all()}
        assert {"payment_rail", "paypal_order_id", "paypal_capture_id", "paypal_amount",
                "paypal_payout_batch_id", "paypal_payout_status"} <= cols
        ucols = {r[0] for r in (await conn.execute(text(
            "SELECT column_name FROM information_schema.columns WHERE table_name='users'"))).all()}
        assert "paypal_email" in ucols
        tables = {r[0] for r in (await conn.execute(text(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"))).all()}
        assert "payment_events" in tables
    yield
