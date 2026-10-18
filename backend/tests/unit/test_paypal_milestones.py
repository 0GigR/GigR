"""Staged (milestone) escrow on PayPal, with PayPal and the database faked out.

The money rules under test: every milestone is its own order → capture → payout,
a refund only returns what is still held, a payout can never be sent twice, and
the whole-job and milestone ways of paying never mix on one job.
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import pytest
from fastapi import HTTPException

from app.core.config import settings
from app.models.job import Job
from app.models.milestone import JobMilestone
from app.models.user import User
from app.services import paypal_client as pp
from app.services import paypal_escrow as esc


class _Rows:
    def __init__(self, rows):
        self.rows = rows

    def scalars(self):
        return self

    def all(self):
        return list(self.rows)

    def first(self):
        return self.rows[0] if self.rows else None

    def scalar_one_or_none(self):
        return self.rows[0] if self.rows else None

    def scalar(self):
        return self.rows[0] if self.rows else None


class FakeDB:
    """Answers just the queries paypal_escrow makes about one job and its milestones."""

    def __init__(self, job, milestones):
        self.job, self.milestones = job, milestones
        self.added, self.commits = [], 0

    def add(self, obj):
        self.added.append(obj)

    async def flush(self):
        pass

    async def commit(self):
        self.commits += 1

    async def execute(self, stmt):
        text = str(stmt).lower()
        values = list(stmt.compile().params.values())
        if "count(" in text:
            return _Rows([0])
        if "from job_milestones" in text:
            rows = self.milestones
            if "paypal_capture_id is not null" in text:
                rows = [m for m in rows if m.paypal_capture_id]
            elif "order by" not in text:  # a lookup by id / order id / payout batch id
                rows = [m for m in rows if {m.id, m.paypal_order_id, m.paypal_payout_batch_id} & set(values)]
            return _Rows(rows)
        if "from jobs" in text:
            keys = {self.job.id, self.job.paypal_order_id, self.job.paypal_payout_batch_id} - {None}
            return _Rows([self.job] if keys & set(values) else [])
        return _Rows([])

    def events(self, kind=None):
        evs = [o for o in self.added if o.__class__.__name__ == "PaymentEvent"]
        return [e for e in evs if kind is None or e.kind == kind]


class FakePayPal:
    def __init__(self):
        self.orders, self.refunds, self.payouts, self.captures = {}, [], [], {}

    async def create_order(self, *, amount, currency, reference_id, description, return_url,
                           cancel_url, request_id, custom_id=None):
        oid = f"ORD-{len(self.orders) + 1}"
        self.orders[oid] = {"amount": amount, "custom_id": custom_id, "status": "PAYER_ACTION_REQUIRED"}
        return {"id": oid, "status": "PAYER_ACTION_REQUIRED",
                "links": [{"rel": "payer-action", "href": f"https://paypal.test/{oid}"}]}

    async def get_order(self, order_id):
        o = self.orders[order_id]
        return {"id": order_id, "status": o["status"],
                "links": [{"rel": "payer-action", "href": f"https://paypal.test/{order_id}"}]}

    async def capture_order(self, order_id, *, request_id):
        o = self.orders[order_id]
        if o["status"] != "APPROVED":
            raise pp.PayPalError("not approved", status_code=422, details=[{"issue": "ORDER_NOT_APPROVED"}])
        cap = f"CAP-{order_id}"
        self.captures[cap] = o["amount"]
        o["status"] = "COMPLETED"
        return {"id": order_id, "status": "COMPLETED", "purchase_units": [{"payments": {"captures": [
            {"id": cap, "status": "COMPLETED", "amount": {"value": f"{o['amount']:.2f}", "currency_code": "USD"}}
        ]}}]}

    async def refund_capture(self, capture_id, *, request_id, amount=None, currency=None, note=None,
                             invoice_id=None):
        self.refunds.append({"capture": capture_id, "amount": amount, "request_id": request_id})
        return {"id": f"REF-{len(self.refunds)}", "status": "COMPLETED"}

    async def create_payout(self, *, receiver_email, amount, currency, sender_batch_id, sender_item_id,
                            note, email_subject=""):
        assert all(p["batch"] != sender_batch_id for p in self.payouts), "duplicate sender_batch_id"
        self.payouts.append({"batch": sender_batch_id, "amount": amount, "to": receiver_email})
        return {"batch_header": {"payout_batch_id": f"PB-{len(self.payouts)}", "batch_status": "PENDING"}}

    def approve(self, order_id):
        self.orders[order_id]["status"] = "APPROVED"


@pytest.fixture
def world(monkeypatch):
    """A funded-ready staged job: two milestones (₦8,000 and ₦16,000 @ ₦1,600/$ → $5 and $10)."""
    fake = FakePayPal()
    for name in ("create_order", "get_order", "capture_order", "refund_capture", "create_payout"):
        monkeypatch.setattr(pp, name, getattr(fake, name))

    async def rate():
        return 1600.0

    notes = []

    async def notify(db, **kw):
        notes.append(kw)

    job = Job(id=uuid.uuid4(), client_id=uuid.uuid4(), provider_id=uuid.uuid4(), title="Renovate kitchen",
              description="d", price=Decimal("24000"), status="assigned")
    provider = User(id=job.provider_id, email="p@x.io", display_name="Pro", paypal_email="pro@example.com")

    async def get_user(db, uid):
        return provider

    monkeypatch.setattr(esc, "get_ngn_usd_rate", rate)
    monkeypatch.setattr(esc, "create_notification", notify)
    monkeypatch.setattr(esc, "get_user_by_id", get_user)
    monkeypatch.setattr(settings, "PLATFORM_FEE_PERCENT", 0.0)

    stages = [
        JobMilestone(id=uuid.uuid4(), job_id=job.id, milestone_index=i + 1, title=t, amount=Decimal(a),
                     status="pending", contract_milestone_id=f"0x{i}")
        for i, (t, a) in enumerate([("Deposit", "8000"), ("Final", "16000")])
    ]
    db = FakeDB(job, stages)

    class W:
        pass

    w = W()
    w.fake, w.job, w.provider, w.stages, w.db, w.notes = fake, job, provider, stages, db, notes
    return w


async def fund(w, ms):
    co = await esc.start_milestone_checkout(
        w.db, w.job, ms, w.provider, client_id=w.job.client_id, return_url="r", cancel_url="c"
    )
    w.fake.approve(co["order_id"])
    await esc.capture_milestone_checkout(w.db, w.job, ms, co["order_id"], actor_id=w.job.client_id)
    return co


async def test_milestone_checkout_quotes_usd_and_tags_the_order(world):
    ms = world.stages[0]
    co = await esc.start_milestone_checkout(
        world.db, world.job, ms, world.provider, client_id=world.job.client_id, return_url="r", cancel_url="c"
    )
    assert co["amount"] == 5.0 and co["currency"] == "USD" and co["milestone_id"] == str(ms.id)
    assert world.fake.orders[co["order_id"]]["custom_id"] == f"ms:{ms.id}"
    assert ms.paypal_order_id == co["order_id"] and ms.paypal_amount == Decimal("5.00")
    assert ms.status == "pending" and not ms.paypal_capture_id  # nothing is charged until approval

    again = await esc.start_milestone_checkout(
        world.db, world.job, ms, world.provider, client_id=world.job.client_id, return_url="r", cancel_url="c"
    )
    assert again["order_id"] == co["order_id"] and len(world.fake.orders) == 1  # double click reuses


async def test_checkout_refused_without_provider_paypal(world):
    world.provider.paypal_email = None
    with pytest.raises(HTTPException) as e:
        await esc.start_milestone_checkout(
            world.db, world.job, world.stages[0], world.provider,
            client_id=world.job.client_id, return_url="r", cancel_url="c",
        )
    assert e.value.status_code == 409 and not world.fake.orders


async def test_capture_requires_approval_then_funds_only_that_milestone(world):
    ms = world.stages[0]
    co = await esc.start_milestone_checkout(
        world.db, world.job, ms, world.provider, client_id=world.job.client_id, return_url="r", cancel_url="c"
    )
    with pytest.raises(HTTPException) as e:
        await esc.capture_milestone_checkout(world.db, world.job, ms, co["order_id"])
    assert e.value.status_code == 409 and ms.status == "pending"

    world.fake.approve(co["order_id"])
    await esc.capture_milestone_checkout(world.db, world.job, ms, co["order_id"])
    assert ms.status == "funded" and ms.paypal_capture_id == f"CAP-{co['order_id']}"
    assert world.stages[1].status == "pending"
    assert world.job.status == "funded"  # the provider can start

    # Capturing again is a no-op: one capture, one ledger row.
    await esc.capture_milestone_checkout(world.db, world.job, ms, co["order_id"])
    assert len(world.db.events("captured")) == 1


async def test_wrong_order_cannot_fund_a_milestone(world):
    ms = world.stages[0]
    await esc.start_milestone_checkout(
        world.db, world.job, ms, world.provider, client_id=world.job.client_id, return_url="r", cancel_url="c"
    )
    with pytest.raises(HTTPException) as e:
        await esc.capture_milestone_checkout(world.db, world.job, ms, "SOMEONE-ELSES-ORDER")
    assert e.value.status_code == 400


async def test_funding_a_new_stage_cancels_the_pending_auto_release(world):
    await fund(world, world.stages[0])
    world.job.status = "in_progress"  # provider submitted stage 1
    world.job.work_submitted_at = datetime.now(timezone.utc)
    world.job.auto_release_at = datetime.now(timezone.utc)

    await fund(world, world.stages[1])
    assert world.job.status == "funded"
    assert world.job.auto_release_at is None and world.job.work_submitted_at is None


async def test_release_pays_one_milestone_once_and_completes_the_job_at_the_end(world):
    first, last = world.stages
    await fund(world, first)
    await fund(world, last)

    await esc.release_milestone(world.db, world.job, first)
    assert first.status == "released" and first.paypal_payout_batch_id == "PB-1"
    assert world.fake.payouts[0]["amount"] == Decimal("5.00") and world.job.status != "completed"

    await esc.release_milestone(world.db, world.job, first)  # double click
    assert len(world.fake.payouts) == 1

    await esc.release_milestone(world.db, world.job, last)
    assert world.job.status == "completed"
    assert len({p["batch"] for p in world.fake.payouts}) == 2  # distinct sender_batch_ids
    assert last.status == "released" and world.fake.payouts[1]["amount"] == Decimal("10.00")


async def test_platform_fee_is_taken_per_milestone(world, monkeypatch):
    monkeypatch.setattr(settings, "PLATFORM_FEE_PERCENT", 10.0)
    await fund(world, world.stages[1])  # $10.00
    await esc.release_milestone(world.db, world.job, world.stages[1])
    assert world.fake.payouts[0]["amount"] == Decimal("9.00")


async def test_cannot_release_an_unfunded_milestone(world):
    with pytest.raises(HTTPException) as e:
        await esc.release_milestone(world.db, world.job, world.stages[0])
    assert e.value.status_code == 400 and not world.fake.payouts


async def test_whole_job_checkout_is_blocked_once_a_milestone_is_funded(world):
    await fund(world, world.stages[0])
    world.job.status = "assigned"
    with pytest.raises(HTTPException) as e:
        await esc.start_checkout(
            world.db, world.job, world.provider, client_id=world.job.client_id, return_url="r", cancel_url="c"
        )
    assert e.value.status_code == 409 and "stages" in e.value.detail


async def test_milestone_checkout_is_blocked_on_a_fully_funded_job(world):
    world.job.paypal_capture_id = "CAP-WHOLE"
    with pytest.raises(HTTPException) as e:
        await esc.start_milestone_checkout(
            world.db, world.job, world.stages[0], world.provider,
            client_id=world.job.client_id, return_url="r", cancel_url="c",
        )
    assert e.value.status_code == 409


async def test_cancel_refunds_only_what_is_still_held(world):
    first, last = world.stages
    await fund(world, first)
    await fund(world, last)
    await esc.release_milestone(world.db, world.job, first)  # stage 1 already paid out

    await esc.refund_to_client(world.db, world.job, reason="cancelled_by_client")
    assert [r["capture"] for r in world.fake.refunds] == [last.paypal_capture_id]
    assert last.status == "refunded" and first.status == "released"
    assert world.job.status == "cancelled"

    await esc.refund_to_client(world.db, world.job, reason="again")  # retry: nothing left to refund
    assert len(world.fake.refunds) == 1


async def test_dispute_for_provider_releases_every_held_milestone(world):
    first, last = world.stages
    await fund(world, first)
    await fund(world, last)
    await esc.release_to_provider(world.db, world.job, reason="dispute_resolved_for_provider")
    assert sorted(p["amount"] for p in world.fake.payouts) == [Decimal("5.00"), Decimal("10.00")]
    assert first.status == last.status == "released" and world.job.status == "completed"

    await esc.release_to_provider(world.db, world.job)  # idempotent
    assert len(world.fake.payouts) == 2


async def test_dispute_split_divides_each_held_milestone(world):
    first, last = world.stages
    await fund(world, first)
    await fund(world, last)
    await esc.split_escrow(world.db, world.job, 60)  # provider 60%, client 40%
    assert sorted(r["amount"] for r in world.fake.refunds) == [Decimal("2.00"), Decimal("4.00")]
    assert sorted(p["amount"] for p in world.fake.payouts) == [Decimal("3.00"), Decimal("6.00")]
    assert world.job.status == "completed"
    # Refunds never exceed what each capture holds.
    for r in world.fake.refunds:
        assert r["amount"] <= world.fake.captures[r["capture"]]


async def test_split_with_nothing_held_is_refused(world):
    with pytest.raises(HTTPException):
        await esc.split_escrow(world.db, world.job, 50)  # no milestone escrow → falls to whole-job path


async def test_webhook_funds_a_milestone_the_browser_never_reported(world):
    ms = world.stages[0]
    co = await esc.start_milestone_checkout(
        world.db, world.job, ms, world.provider, client_id=world.job.client_id, return_url="r", cancel_url="c"
    )
    event = {
        "id": "WH-1", "event_type": "PAYMENT.CAPTURE.COMPLETED",
        "resource": {"id": "CAP-X", "custom_id": f"ms:{ms.id}", "amount": {"value": "5.00"}},
    }
    outcome = await esc.handle_webhook_event(world.db, event)
    assert outcome == "milestone_funded"
    assert ms.status == "funded" and ms.paypal_capture_id == "CAP-X" and co["order_id"] == ms.paypal_order_id
    assert world.job.status == "funded"


async def test_payout_webhook_updates_the_milestone(world):
    ms = world.stages[0]
    await fund(world, ms)
    await esc.release_milestone(world.db, world.job, ms)
    event = {
        "id": "WH-2", "event_type": "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
        "resource": {"payout_batch_id": ms.paypal_payout_batch_id},
    }
    outcome = await esc.handle_webhook_event(world.db, event)
    assert outcome == "payout_succeeded" and ms.paypal_payout_status == "SUCCEEDED"
