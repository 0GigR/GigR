"""Escrow domain logic with PayPal and the database faked out.

What matters here is the money: right amounts, idempotency, and that a job is
never marked funded/released unless PayPal actually did it.
"""
import uuid
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.models.job import Job
from app.models.user import User
from app.services import paypal_client as pp
from app.services import paypal_escrow as esc


class _Result:
    def __init__(self, value=None):
        self.value = value

    def scalar(self):
        return self.value

    def first(self):
        return self.value

    def scalar_one_or_none(self):
        return self.value


class FakeDB:
    def __init__(self, scalar=0, lookup=None):
        self.added, self.commits = [], 0
        self._scalar, self._lookup = scalar, lookup

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        pass

    async def commit(self):
        self.commits += 1

    async def execute(self, stmt):
        text = str(stmt).lower()
        if "count(" in text:
            return _Result(self._scalar)
        return _Result(self._lookup)

    def events(self, kind=None):
        evs = [o for o in self.added if o.__class__.__name__ == "PaymentEvent"]
        return [e for e in evs if kind is None or e.kind == kind]


@pytest.fixture
def notes(monkeypatch):
    sent = []

    async def fake_notify(db, **kw):
        sent.append(kw)

    monkeypatch.setattr(esc, "create_notification", fake_notify)
    return sent


@pytest.fixture(autouse=True)
def _rate(monkeypatch):
    async def rate():
        return 1600.0

    monkeypatch.setattr(esc, "get_ngn_usd_rate", rate)
    monkeypatch.setattr(settings, "PLATFORM_FEE_PERCENT", 0.0)


def make_job(**kw) -> Job:
    base = dict(
        id=uuid.uuid4(), client_id=uuid.uuid4(), provider_id=uuid.uuid4(),
        title="Fix kitchen sink", description="d", price=Decimal("16000"), status="assigned",
    )
    base.update(kw)
    return Job(**base)


def make_provider(job: Job, email="pro@example.com") -> User:
    return User(id=job.provider_id, email="p@x.io", display_name="Pro", paypal_email=email)


# ── rail resolution ──────────────────────────────────────────────────────────
def test_rail_for_job(monkeypatch):
    from app.core import rail
    monkeypatch.setattr(settings, "PAYPAL_CLIENT_ID", "id")
    monkeypatch.setattr(settings, "PAYPAL_CLIENT_SECRET", "secret")
    for name in ("GIGR_PROGRAM_ID", "SOLANA_RPC_URL", "PLATFORM_KEYPAIR",
                 "WALLET_ENCRYPTION_KEY", "USDC_MINT_DEVNET"):
        monkeypatch.setattr(settings, name, "x")
    token = rail.set_request_rail("paypal")  # what the frontend's X-Payment-Rail does
    assert esc.rail_for_job(make_job()) == "paypal"
    assert esc.rail_for_job(make_job(payment_rail="solana")) == "solana"
    # funded on-chain before the column existed → stays on Solana even after the switch
    assert esc.rail_for_job(make_job(escrow_address="9xQe...pda")) == "solana"
    assert esc.rail_for_job(make_job(escrow_address="paypal:CAP1")) == "paypal"
    rail.reset_request_rail(token)
    token = rail.set_request_rail("solana")
    assert esc.rail_for_job(make_job()) == "solana"
    rail.reset_request_rail(token)


async def test_quote_amount_converts_naira_to_usd_cents():
    assert await esc.quote_amount(make_job(price=Decimal("16000"))) == Decimal("10.00")
    assert await esc.quote_amount(make_job(price=Decimal("5000"))) == Decimal("3.13")  # 3.125 → half-up
    with pytest.raises(HTTPException):
        await esc.quote_amount(make_job(price=Decimal("1")))  # < 1 cent


def test_platform_fee(monkeypatch):
    assert esc.platform_fee(Decimal("10.00")) == Decimal("0.00")
    monkeypatch.setattr(settings, "PLATFORM_FEE_PERCENT", 5.0)
    assert esc.platform_fee(Decimal("10.00")) == Decimal("0.50")
    assert esc.platform_fee(Decimal("0.99")) == Decimal("0.05")


# ── fund ─────────────────────────────────────────────────────────────────────
async def test_checkout_refuses_when_provider_has_no_paypal(monkeypatch):
    job = make_job()
    called = []

    async def boom(**kw):
        called.append(kw)

    monkeypatch.setattr(esc.paypal, "create_order", boom)
    with pytest.raises(HTTPException) as ei:
        await esc.start_checkout(
            FakeDB(), job, make_provider(job, email=None),
            client_id=job.client_id, return_url="r", cancel_url="c",
        )
    assert ei.value.status_code == 409
    assert not called, "must never create a charge for a provider we cannot pay"


async def test_checkout_creates_order_and_records_it(monkeypatch):
    job, db = make_job(), FakeDB()
    seen = {}

    async def create_order(**kw):
        seen.update(kw)
        return {"id": "ORD1", "status": "PAYER_ACTION_REQUIRED",
                "links": [{"rel": "payer-action", "href": "https://pp/approve"}]}

    monkeypatch.setattr(esc.paypal, "create_order", create_order)
    out = await esc.start_checkout(
        db, job, make_provider(job), client_id=job.client_id, return_url="r", cancel_url="c",
    )
    assert out["approval_url"] == "https://pp/approve" and out["amount"] == 10.0
    assert seen["amount"] == Decimal("10.00") and seen["custom_id"] == str(job.id)
    assert (job.payment_rail, job.paypal_order_id, job.paypal_amount) == ("paypal", "ORD1", Decimal("10.00"))
    assert [e.kind for e in db.events()] == ["order_created"]


async def test_checkout_reuses_open_order(monkeypatch):
    job = make_job(paypal_order_id="ORD1", paypal_amount=Decimal("10.00"))

    async def get_order(oid):
        return {"id": oid, "status": "PAYER_ACTION_REQUIRED",
                "links": [{"rel": "payer-action", "href": "https://pp/again"}]}

    async def no_create(**kw):
        raise AssertionError("should reuse the open order")

    monkeypatch.setattr(esc.paypal, "get_order", get_order)
    monkeypatch.setattr(esc.paypal, "create_order", no_create)
    out = await esc.start_checkout(
        FakeDB(), job, make_provider(job), client_id=job.client_id, return_url="r", cancel_url="c",
    )
    assert out["approval_url"] == "https://pp/again"


def _capture_payload(status="COMPLETED", value="10.00", cap_id="CAP1"):
    return {"id": "ORD1", "status": "COMPLETED", "purchase_units": [{
        "payments": {"captures": [{"id": cap_id, "status": status, "amount": {"value": value, "currency_code": "USD"}}]}
    }]}


async def test_capture_marks_funded_and_notifies_provider(monkeypatch, notes):
    job = make_job(paypal_order_id="ORD1", paypal_amount=Decimal("10.00"))
    db = FakeDB()

    async def capture(oid, request_id):
        assert request_id == "gigr-capture-ORD1"
        return _capture_payload()

    monkeypatch.setattr(esc.paypal, "capture_order", capture)
    await esc.capture_checkout(db, job, "ORD1", actor_id=job.client_id)
    assert job.status == "funded" and job.paypal_capture_id == "CAP1"
    assert job.escrow_address == "paypal:CAP1"
    assert [e.kind for e in db.events()] == ["captured"]
    assert notes[0]["user_id"] == job.provider_id and notes[0]["title"] == "Escrow Funded"


async def test_capture_rejects_order_from_another_job(monkeypatch):
    job = make_job(paypal_order_id="ORD1", paypal_amount=Decimal("10.00"))
    with pytest.raises(HTTPException) as ei:
        await esc.capture_checkout(FakeDB(), job, "SOMEONE-ELSES-ORDER")
    assert ei.value.status_code == 400


async def test_capture_is_idempotent_when_paypal_says_already_captured(monkeypatch, notes):
    job = make_job(paypal_order_id="ORD1", paypal_amount=Decimal("10.00"))

    async def capture(oid, request_id):
        raise pp.PayPalError("dup", status_code=422, details=[{"issue": "ORDER_ALREADY_CAPTURED"}])

    async def get_order(oid):
        return _capture_payload()

    monkeypatch.setattr(esc.paypal, "capture_order", capture)
    monkeypatch.setattr(esc.paypal, "get_order", get_order)
    await esc.capture_checkout(FakeDB(), job, "ORD1")
    assert job.status == "funded" and job.paypal_capture_id == "CAP1"


async def test_pending_capture_does_not_fund(monkeypatch):
    job = make_job(paypal_order_id="ORD1", paypal_amount=Decimal("10.00"))

    async def capture(oid, request_id):
        return _capture_payload(status="PENDING")

    monkeypatch.setattr(esc.paypal, "capture_order", capture)
    with pytest.raises(HTTPException) as ei:
        await esc.capture_checkout(FakeDB(), job, "ORD1")
    assert ei.value.status_code == 409
    assert job.status == "assigned" and job.paypal_capture_id is None


async def test_amount_mismatch_does_not_fund(monkeypatch):
    job = make_job(paypal_order_id="ORD1", paypal_amount=Decimal("10.00"))

    async def capture(oid, request_id):
        return _capture_payload(value="9.00")

    monkeypatch.setattr(esc.paypal, "capture_order", capture)
    with pytest.raises(HTTPException):
        await esc.capture_checkout(FakeDB(), job, "ORD1")
    assert job.status == "assigned"


# ── release ──────────────────────────────────────────────────────────────────
def funded_job(**kw) -> Job:
    return make_job(
        status="funded", payment_rail="paypal", paypal_order_id="ORD1", paypal_capture_id="CAP1",
        paypal_amount=Decimal("10.00"), paypal_currency="USD", escrow_address="paypal:CAP1", **kw,
    )


@pytest.fixture
def provider_lookup(monkeypatch):
    async def lookup(db, user_id):
        return db._provider

    monkeypatch.setattr(esc, "get_user_by_id", lookup)


async def test_release_pays_provider_net_of_fee_and_completes(monkeypatch, notes, provider_lookup):
    monkeypatch.setattr(settings, "PLATFORM_FEE_PERCENT", 10.0)
    job = funded_job()
    db = FakeDB()
    db._provider = make_provider(job)
    sent = {}

    async def payout(**kw):
        sent.update(kw)
        return {"batch_header": {"payout_batch_id": "BATCH1", "batch_status": "PENDING"}}

    monkeypatch.setattr(esc.paypal, "create_payout", payout)
    summary = await esc.release_to_provider(db, job)

    assert sent["amount"] == Decimal("9.00")  # 10.00 less 10% fee
    assert sent["receiver_email"] == "pro@example.com"
    assert sent["sender_batch_id"].startswith("gigr-rel-") and sent["sender_batch_id"].endswith("-0")
    assert job.status == "completed" and job.paypal_payout_batch_id == "BATCH1"
    assert summary["state"] == "released"
    assert [e.kind for e in db.events()] == ["payout_sent"]


async def test_release_is_idempotent(monkeypatch, provider_lookup):
    job = funded_job()
    job.paypal_payout_batch_id = "BATCH1"

    async def never(**kw):
        raise AssertionError("must not pay twice")

    monkeypatch.setattr(esc.paypal, "create_payout", never)
    summary = await esc.release_to_provider(FakeDB(), job)
    assert summary["payout_batch_id"] == "BATCH1"


async def test_failed_payout_leaves_job_funded_and_logs(monkeypatch, provider_lookup):
    job = funded_job()
    db = FakeDB()
    db._provider = make_provider(job)

    async def payout(**kw):
        raise pp.PayPalError("insufficient funds", status_code=400, name="INSUFFICIENT_FUNDS")

    monkeypatch.setattr(esc.paypal, "create_payout", payout)
    with pytest.raises(HTTPException) as ei:
        await esc.release_to_provider(db, job)
    assert ei.value.status_code == 502
    assert job.status == "funded" and job.paypal_payout_batch_id is None
    assert [e.kind for e in db.events()] == ["failed"] and db.commits == 1


async def test_retry_after_failure_uses_a_fresh_batch_id(monkeypatch, provider_lookup):
    job = funded_job()
    db = FakeDB(scalar=1)  # one earlier attempt recorded
    db._provider = make_provider(job)
    sent = {}

    async def payout(**kw):
        sent.update(kw)
        return {"batch_header": {"payout_batch_id": "B2", "batch_status": "SUCCESS"}}

    monkeypatch.setattr(esc.paypal, "create_payout", payout)
    await esc.release_to_provider(db, job)
    assert sent["sender_batch_id"].endswith("-1")


async def test_cannot_release_without_capture(provider_lookup):
    job = make_job(status="assigned")
    with pytest.raises(HTTPException) as ei:
        await esc.release_to_provider(FakeDB(), job)
    assert ei.value.status_code == 400


# ── refund / split ───────────────────────────────────────────────────────────
async def test_refund_returns_full_capture_and_cancels(monkeypatch, notes):
    job = funded_job()
    db = FakeDB()
    seen = {}

    async def refund(capture_id, **kw):
        seen.update(capture_id=capture_id, **kw)
        return {"id": "REF1", "status": "COMPLETED"}

    monkeypatch.setattr(esc.paypal, "refund_capture", refund)
    await esc.refund_to_client(db, job, reason="cancelled")
    assert seen["capture_id"] == "CAP1" and seen["amount"] is None
    assert job.status == "cancelled"
    assert db.events("refunded")[0].amount == Decimal("10.00")
    assert notes[0]["user_id"] == job.client_id


async def test_cannot_refund_after_payout(provider_lookup):
    job = funded_job()
    job.paypal_payout_batch_id = "BATCH1"
    with pytest.raises(HTTPException) as ei:
        await esc.refund_to_client(FakeDB(), job)
    assert ei.value.status_code == 409


async def test_split_divides_escrow(monkeypatch, notes, provider_lookup):
    job = funded_job()
    db = FakeDB()
    db._provider = make_provider(job)
    refunds, payouts = [], []

    async def refund(capture_id, **kw):
        refunds.append(kw["amount"])
        return {"id": "R", "status": "COMPLETED"}

    async def payout(**kw):
        payouts.append(kw["amount"])
        return {"batch_header": {"payout_batch_id": "B", "batch_status": "SUCCESS"}}

    monkeypatch.setattr(esc.paypal, "refund_capture", refund)
    monkeypatch.setattr(esc.paypal, "create_payout", payout)
    await esc.split_escrow(db, job, 70)
    assert refunds == [Decimal("3.00")] and payouts == [Decimal("7.00")]
    assert refunds[0] + payouts[0] == job.paypal_amount  # not a cent lost
    assert job.status == "completed"


async def test_split_rejects_extremes():
    for pct in (0, 100, -5, 150):
        with pytest.raises(HTTPException):
            await esc.split_escrow(FakeDB(), funded_job(), pct)


async def test_amendment_refund_clears_funding_state(monkeypatch):
    job = funded_job()

    async def refund(capture_id, **kw):
        return {"id": "R", "status": "COMPLETED"}

    monkeypatch.setattr(esc.paypal, "refund_capture", refund)
    await esc.refund_for_amendment(FakeDB(), job)
    assert job.paypal_capture_id is None and job.paypal_order_id is None and job.escrow_address is None


# ── webhooks ─────────────────────────────────────────────────────────────────
async def test_webhook_duplicate_event_is_ignored():
    db = FakeDB(lookup=("existing-row",))
    out = await esc.handle_webhook_event(db, {"id": "EVT1", "event_type": "PAYMENT.CAPTURE.COMPLETED", "resource": {}})
    assert out == "duplicate" and not db.added


async def test_webhook_order_approved_captures_the_job(monkeypatch, notes):
    job = make_job(paypal_order_id="ORD1", paypal_amount=Decimal("10.00"))

    class DB(FakeDB):
        async def execute(self, stmt):
            if "payment_events" in str(stmt).lower():
                return _Result(None)  # not seen before
            return _Result(job)

    async def capture(oid, request_id):
        return _capture_payload()

    monkeypatch.setattr(esc.paypal, "capture_order", capture)
    db = DB()
    out = await esc.handle_webhook_event(
        db, {"id": "EVT2", "event_type": "CHECKOUT.ORDER.APPROVED", "resource": {"id": "ORD1"}}
    )
    assert out == "captured" and job.status == "funded"
    assert db.events("webhook")[0].paypal_event_id == "EVT2"


async def test_webhook_payout_failure_notifies_provider(notes):
    job = funded_job()
    job.paypal_payout_batch_id = "BATCH1"

    class DB(FakeDB):
        async def execute(self, stmt):
            if "payment_events" in str(stmt).lower():
                return _Result(None)
            return _Result(job)

    out = await esc.handle_webhook_event(
        DB(), {"id": "EVT3", "event_type": "PAYMENT.PAYOUTS-ITEM.FAILED", "resource": {"payout_batch_id": "BATCH1"}}
    )
    assert out == "payout_failed" and job.paypal_payout_status == "FAILED"
    assert notes and notes[0]["user_id"] == job.provider_id
