"""The paid agent brief: payment verification, replay protection, real briefs.

The first property this file exists for is the security check the last attempt
shipped without: a payment in a token that is not the configured USDC mint must
be refused, with its own reason, and must never be reported as paid. Settlement
success, recipient, mint and amount are four separate facts; each has a test
that breaks if its check is removed.

Nothing here touches the network or the database. The verification gateway and
the crud functions the service imports are replaced at the service's own seam,
and the router tests replace the builder the composition root exposes, so every
assertion is on the value the code under test produced, not on a mock's shape.
"""

from __future__ import annotations

import base64
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

import app.core.gateways.tatum_solana_transaction_gateway as gateway_module
from app.crud.agent_brief_payment import claim_signature
from app.api.v1.endpoints import agent_brief as router_module
from app.core.config import Settings, settings
from app.core.dependencies import get_db
from app.core.gateways.tatum_solana_transaction_gateway import (
    SolanaTransaction,
    SolanaTransactionError,
    TatumSolanaTransactionGateway,
    TokenBalanceDelta,
    parse_transaction,
)
from app.core.resilience import Boundary, ResiliencePolicy, StructuredLogMetricSink
from app.models.job import Job
from app.services import agent_brief_service as brief_module
from app.services.agent_brief_service import (
    AgentBriefService,
    BriefPaymentPolicy,
    BriefStatus,
)
from app.schemas.agent_brief import decode_payment_header

CLIENT_ID = UUID("0b7f9a52-1c4d-4e88-9f31-2a1c5d6e7f80")
PROVIDER_ID = UUID("9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f")
CATEGORY_ID = UUID("7f3a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c")
JOB_ID = UUID("c4d5e6f7-0a1b-4c2d-8e3f-4a5b6c7d8e9f")

USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"
OTHER_MINT = "So11111111111111111111111111111111111111112"
PAY_TO = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"
PAYER = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"
SIGNATURE = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW"
SECOND_SIGNATURE = "4hXTCkRzt9WyecNzV1XPgCDfGAZzQKNxLXgynz5QDuBrXahySZgP91k8d2r2rC7Za2jXU2vUs8W5uQn4qYp1k2Ab"

PAID_ATOMIC = 10000
NETWORK = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"
EXPIRES_SECONDS = 300
RESOURCE = f"https://api.gigr.app/api/v1/agent/brief?job_id={JOB_ID}"
FIXED_NOW = datetime(2026, 10, 29, 12, 0, tzinfo=timezone.utc)

_MISSING = object()


class FakeTransactionGateway:
    """The Tatum read seam: one recorded lookup per signature."""

    def __init__(
        self,
        transactions: dict | None = None,
        error: BaseException | None = None,
    ):
        self.transactions = transactions or {}
        self.error = error
        self.calls: list[str] = []

    async def get_transaction(self, signature: str):
        self.calls.append(signature)
        if self.error is not None:
            raise self.error
        return self.transactions[signature]


def make_transaction(
    *,
    signature: str = SIGNATURE,
    movements: list[tuple[str, str, int]] | None = None,
    succeeded: bool = True,
    error_kind: str | None = None,
) -> SolanaTransaction:
    """A transaction whose token movements are exactly the ones named."""
    if movements is None:
        movements = [(USDC_MINT, PAY_TO, PAID_ATOMIC)]
    return SolanaTransaction(
        signature=signature,
        slot=123,
        succeeded=succeeded,
        error=None if succeeded else "InstructionError",
        token_deltas=tuple(
            TokenBalanceDelta(mint=mint, owner=owner, delta_atomic=amount)
            for mint, owner, amount in movements
        ),
        error_kind=error_kind,
    )


def make_job(**overrides) -> Job:
    job = Job(
        id=JOB_ID,
        client_id=CLIENT_ID,
        provider_id=PROVIDER_ID,
        category_id=CATEGORY_ID,
        title="Fix the leaking kitchen sink",
        description="Water under the cabinet after every use.",
        status="open",
        price=Decimal("120.00"),
    )
    for key, value in overrides.items():
        setattr(job, key, value)
    return job


def make_policy() -> BriefPaymentPolicy:
    return BriefPaymentPolicy(
        mint=USDC_MINT,
        pay_to=PAY_TO,
        amount_atomic=PAID_ATOMIC,
        network=NETWORK,
        expires_seconds=EXPIRES_SECONDS,
    )


def install_rows(
    monkeypatch,
    *,
    job=_MISSING,
    ratings=(4, 5),
    completed_jobs: int = 3,
    comparable: dict | None = None,
    dispute_totals=(2, 1, 1),
    claim_results=(True,),
):
    """Replace the service's crud seam with rows shaped like the real columns.

    Returns the list of signatures the ledger claim attempted, so a test can
    assert the payment was (or was not) spent without inspecting a mock call.
    """
    claims: list[str] = []
    results = list(claim_results)

    async def fake_get_job(db, job_id):
        if job is None:
            return None
        return make_job() if job is _MISSING else job

    async def fake_ratings(db, ratee_id):
        distribution: dict[int, int] = {}
        for score in ratings:
            distribution[score] = distribution.get(score, 0) + 1
        average = sum(ratings) / len(ratings) if ratings else None
        return brief_module.ReceivedRatings(
            count=len(ratings), average=average, distribution=distribution
        )

    async def fake_completed(db, provider_id):
        return completed_jobs

    async def fake_prices(db, category_id, exclude_job_id):
        summary = comparable or {
            "count": 0,
            "minimum": None,
            "maximum": None,
            "average": None,
        }
        return brief_module.CompletedJobPrices(
            count=summary["count"],
            minimum=summary["minimum"],
            maximum=summary["maximum"],
            average=summary["average"],
        )

    async def fake_disputes(db, provider_id):
        total, open_count, resolved = dispute_totals
        return brief_module.ProviderDisputes(
            total=total, open=open_count, resolved=resolved
        )

    async def fake_claim(db, *, signature, job_id, mint, amount_atomic):
        claims.append(signature)
        return results.pop(0) if results else False

    monkeypatch.setattr(brief_module, "get_job_by_id", fake_get_job)
    monkeypatch.setattr(brief_module, "summarize_ratings_by_ratee", fake_ratings)
    monkeypatch.setattr(
        brief_module, "count_completed_jobs_for_provider", fake_completed
    )
    monkeypatch.setattr(brief_module, "summarize_completed_job_prices", fake_prices)
    monkeypatch.setattr(brief_module, "summarize_disputes_for_provider", fake_disputes)
    monkeypatch.setattr(brief_module, "claim_signature", fake_claim)
    return claims


def make_service(gateway, policy: BriefPaymentPolicy | None = None) -> AgentBriefService:
    return AgentBriefService(
        db=object(),
        gateway=gateway,
        policy=policy or make_policy(),
        now=lambda: FIXED_NOW,
        nonce_factory=lambda: "nonce-fixed",
    )


def payment_header(signature: str = SIGNATURE) -> str:
    """The base64 JSON envelope an x402 client sends back."""
    envelope = {
        "x402Version": 1,
        "scheme": "exact",
        "network": NETWORK,
        "payload": {"signature": signature},
    }
    return base64.b64encode(json.dumps(envelope).encode()).decode()


def enable_flag(monkeypatch) -> None:
    """Turn the endpoint on for a router test, with the values the tests quote."""
    monkeypatch.setattr(settings, "FEATURE_X402_AGENT_BRIEF", True)
    monkeypatch.setattr(settings, "USDC_MINT_DEVNET", USDC_MINT)
    monkeypatch.setattr(settings, "X402_AGENT_BRIEF_PAY_TO", PAY_TO)
    monkeypatch.setattr(settings, "X402_AGENT_BRIEF_PRICE_ATOMIC", PAID_ATOMIC)
    monkeypatch.setattr(settings, "X402_AGENT_BRIEF_EXPIRES_SECONDS", EXPIRES_SECONDS)


@pytest.fixture
async def api(monkeypatch):
    """A client for the brief route only, with the composition root stubbed."""
    app = FastAPI()
    app.include_router(router_module.router, prefix="/api/v1/agent")
    app.dependency_overrides[get_db] = lambda: object()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        yield client


def install_service(monkeypatch, gateway, policy=None):
    """Point the router's builder at a real service with a fake chain."""
    service = make_service(gateway, policy)
    monkeypatch.setattr(router_module, "build_agent_brief_service", lambda db: service)
    return service


BRIEF_URL = f"/api/v1/agent/brief?job_id={JOB_ID}"


# -- The wrong mint ----------------------------------------------------------


async def test_a_payment_in_another_mint_is_refused(monkeypatch):
    """A worthless token is not USDC.

    The settlement moved the required atomic amount to the required recipient and
    succeeded, and only the mint is wrong. If the mint is not compared against
    the configured one, this payment reads as paid, which is the defect the last
    attempt shipped. The refusal must be its own reason, not a generic one.
    """
    install_rows(monkeypatch)
    gateway = FakeTransactionGateway(
        {SIGNATURE: make_transaction(movements=[(OTHER_MINT, PAY_TO, PAID_ATOMIC)])}
    )

    result = await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)

    assert result.status is BriefStatus.PAYMENT_REQUIRED
    assert result.reason == "wrong_mint"
    assert result.brief is None


async def test_another_mint_does_not_top_up_a_short_payment(monkeypatch):
    """A million worthless tokens do not complete a short USDC transfer.

    The same wallet receives 1,000,000 atomic units of another mint and one
    atomic unit less USDC than the price. A check that summed every credit, or
    that accepted because some credit matched the mint, would pass; the amount
    that counts must be the configured mint's credit alone.
    """
    install_rows(monkeypatch)
    gateway = FakeTransactionGateway(
        {
            SIGNATURE: make_transaction(
                movements=[
                    (OTHER_MINT, PAY_TO, 1_000_000),
                    (USDC_MINT, PAY_TO, PAID_ATOMIC - 1),
                ]
            )
        }
    )

    result = await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)

    assert result.status is BriefStatus.PAYMENT_REQUIRED
    assert result.reason == "underpaid"
    assert result.brief is None


async def test_a_payment_in_the_configured_mint_is_accepted(monkeypatch):
    """The happy path, so the refusals above cannot pass by refusing everything."""
    claims = install_rows(monkeypatch)
    gateway = FakeTransactionGateway({SIGNATURE: make_transaction()})

    result = await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)

    assert result.status is BriefStatus.PAID
    assert result.reason is None
    assert result.brief is not None
    assert result.brief.job_id == JOB_ID
    assert claims == [SIGNATURE]


async def test_a_payment_above_the_required_amount_is_accepted(monkeypatch):
    """The threshold is a floor: more USDC than asked is still a valid payment."""
    install_rows(monkeypatch)
    gateway = FakeTransactionGateway(
        {SIGNATURE: make_transaction(movements=[(USDC_MINT, PAY_TO, PAID_ATOMIC + 1)])}
    )

    result = await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)

    assert result.status is BriefStatus.PAID


async def test_a_payment_below_the_required_amount_is_refused(monkeypatch):
    """Correct mint, correct wallet, one atomic unit short: not a payment."""
    install_rows(monkeypatch)
    gateway = FakeTransactionGateway(
        {SIGNATURE: make_transaction(movements=[(USDC_MINT, PAY_TO, PAID_ATOMIC - 1)])}
    )

    result = await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)

    assert result.status is BriefStatus.PAYMENT_REQUIRED
    assert result.reason == "underpaid"
    assert result.brief is None


async def test_a_payment_to_another_recipient_is_refused(monkeypatch):
    """The right token and amount, sent to the wrong wallet, buys nothing."""
    install_rows(monkeypatch)
    gateway = FakeTransactionGateway(
        {SIGNATURE: make_transaction(movements=[(USDC_MINT, PAYER, PAID_ATOMIC)])}
    )

    result = await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)

    assert result.status is BriefStatus.PAYMENT_REQUIRED
    assert result.reason == "wrong_recipient"
    assert result.brief is None


async def test_a_failed_transaction_is_refused(monkeypatch):
    """A transaction that errored moved no money a brief can be sold for."""
    install_rows(monkeypatch)
    gateway = FakeTransactionGateway(
        {
            SIGNATURE: make_transaction(
                movements=[(USDC_MINT, PAY_TO, PAID_ATOMIC)], succeeded=False
            )
        }
    )

    result = await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)

    assert result.status is BriefStatus.PAYMENT_REQUIRED
    assert result.reason == "transaction_failed"
    assert result.brief is None


async def test_an_unknown_signature_is_refused(monkeypatch):
    """A signature the chain has never seen is not a payment."""
    install_rows(monkeypatch)
    gateway = FakeTransactionGateway(
        {SIGNATURE: make_transaction(error_kind="transaction_not_found")}
    )

    result = await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)

    assert result.status is BriefStatus.PAYMENT_REQUIRED
    assert result.reason == "transaction_not_found"
    assert result.brief is None


async def test_an_unreadable_transaction_is_refused(monkeypatch):
    """A node answer that cannot be parsed must not look successful."""
    install_rows(monkeypatch)
    gateway = FakeTransactionGateway(
        {SIGNATURE: make_transaction(error_kind="malformed_response")}
    )

    result = await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)

    assert result.status is BriefStatus.PAYMENT_REQUIRED
    assert result.reason == "malformed_transaction"
    assert result.brief is None


async def test_verification_unavailable_refuses_rather_than_trusts(monkeypatch):
    """A gateway that cannot answer fails closed: no brief, no claim."""
    claims = install_rows(monkeypatch)
    gateway = FakeTransactionGateway(error=SolanaTransactionError("gateway down"))

    result = await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)

    assert result.status is BriefStatus.PAYMENT_REQUIRED
    assert result.reason == "verification_unavailable"
    assert result.brief is None
    assert claims == []


# -- Replay ------------------------------------------------------------------


async def test_a_spent_signature_cannot_buy_a_second_brief(monkeypatch):
    """One payment, one brief. The second read sees the ledger already owns it."""
    claims = install_rows(monkeypatch, claim_results=(True, False))
    gateway = FakeTransactionGateway({SIGNATURE: make_transaction()})
    service = make_service(gateway)

    first = await service.read_brief(JOB_ID, SIGNATURE, RESOURCE)
    second = await service.read_brief(JOB_ID, SIGNATURE, RESOURCE)

    assert first.status is BriefStatus.PAID
    assert second.status is BriefStatus.PAYMENT_REQUIRED
    assert second.reason == "payment_already_used"
    assert second.brief is None
    assert claims == [SIGNATURE, SIGNATURE]


async def test_the_brief_is_only_returned_after_the_ledger_claim(monkeypatch):
    """The claim is what gates the content: if it fails, nothing is returned."""
    install_rows(monkeypatch, claim_results=(False,))
    gateway = FakeTransactionGateway({SIGNATURE: make_transaction()})

    result = await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)

    assert result.status is BriefStatus.PAYMENT_REQUIRED
    assert result.brief is None


# -- The ledger primitive -----------------------------------------------------
# A real Postgres race cannot run here: this suite's DATABASE_URL points at a
# managed instance the smoke guard refuses to write to, and overriding that guard
# is not worth a test. What is asserted instead is the property that makes the
# race safe: one conflict-ignoring INSERT whose commit happens before the claim
# returns. A select-then-insert, or a commit after the return, fails these.


class FakeLedgerResult:
    """What an INSERT ... RETURNING answered: a signature, or nothing."""

    def __init__(self, signature: str | None) -> None:
        self._signature = signature

    def scalar_one_or_none(self):
        return self._signature


class FakeLedgerSession:
    """Records the statement and how many commits happened before the call ended."""

    def __init__(self, returned_signature: str | None) -> None:
        self.statements: list = []
        self.commits = 0
        self._returned_signature = returned_signature

    async def execute(self, statement):
        self.statements.append(statement)
        return FakeLedgerResult(self._returned_signature)

    async def commit(self) -> None:
        self.commits += 1


async def test_the_ledger_claim_is_one_conflict_ignoring_insert():
    """Two requests racing for a signature are serialised by the database."""
    session = FakeLedgerSession(returned_signature=SIGNATURE)

    claimed = await claim_signature(
        session,
        signature=SIGNATURE,
        job_id=JOB_ID,
        mint=USDC_MINT,
        amount_atomic=PAID_ATOMIC,
    )

    statement = str(session.statements[0])
    assert claimed is True
    assert "INSERT INTO agent_brief_payments" in statement
    assert "ON CONFLICT (signature) DO NOTHING" in statement
    assert session.commits == 1


async def test_a_lost_insert_is_reported_as_already_spent():
    """The loser of the race is told no, and the row stays as the winner wrote it."""
    session = FakeLedgerSession(returned_signature=None)

    claimed = await claim_signature(
        session,
        signature=SIGNATURE,
        job_id=JOB_ID,
        mint=USDC_MINT,
        amount_atomic=PAID_ATOMIC,
    )

    assert claimed is False


# -- The challenge -----------------------------------------------------------


async def test_without_a_payment_the_challenge_names_the_configured_mint(
    monkeypatch,
):
    """The 402 quotes the devnet USDC mint, the atomic price and the recipient."""
    install_rows(monkeypatch)
    gateway = FakeTransactionGateway()

    result = await make_service(gateway).read_brief(JOB_ID, None, RESOURCE)

    assert result.status is BriefStatus.PAYMENT_REQUIRED
    assert result.reason == "payment_missing"
    requirement = result.requirement
    assert requirement.scheme == "exact"
    assert requirement.network == NETWORK
    assert requirement.mint == USDC_MINT
    assert requirement.amount_atomic == PAID_ATOMIC
    assert requirement.pay_to == PAY_TO
    assert requirement.resource == RESOURCE
    assert requirement.decimals == 6
    assert requirement.nonce == "nonce-fixed"
    assert requirement.expires_at == FIXED_NOW + timedelta(seconds=EXPIRES_SECONDS)
    assert gateway.calls == []


# -- The brief itself --------------------------------------------------------


async def test_a_provider_with_no_history_is_reported_as_having_none(monkeypatch):
    """No rows means no history. Nothing is manufactured to fill the gap."""
    install_rows(monkeypatch, ratings=(), completed_jobs=0, dispute_totals=(0, 0, 0))
    gateway = FakeTransactionGateway({SIGNATURE: make_transaction()})

    result = await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)

    brief = result.brief
    assert brief.has_history is False
    assert brief.ratings_count == 0
    assert brief.ratings_average is None
    assert brief.completed_jobs == 0
    assert brief.comparable_jobs == 0
    assert brief.comparable_min is None
    assert brief.disputes_total == 0
    assert brief.summary == (
        "This provider has no completed jobs, no ratings and no disputes on "
        "Gigr yet."
    )


async def test_a_job_with_no_provider_says_so_instead_of_inventing_one(
    monkeypatch,
):
    """An unassigned job has no provider history, and the brief says that."""
    install_rows(monkeypatch, job=make_job(provider_id=None))
    gateway = FakeTransactionGateway({SIGNATURE: make_transaction()})

    result = await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)

    brief = result.brief
    assert brief.provider_id is None
    assert brief.has_history is False
    assert "No provider is assigned" in brief.summary


async def test_the_brief_carries_the_numbers_the_rows_hold(monkeypatch):
    """Every figure in the brief is the aggregate a query returned."""
    install_rows(
        monkeypatch,
        ratings=(4, 5),
        completed_jobs=3,
        comparable={
            "count": 5,
            "minimum": Decimal("80.00"),
            "maximum": Decimal("200.00"),
            "average": Decimal("140.00"),
        },
        dispute_totals=(2, 1, 1),
    )
    gateway = FakeTransactionGateway({SIGNATURE: make_transaction()})

    result = await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)

    brief = result.brief
    assert brief.has_history is True
    assert brief.ratings_count == 2
    assert brief.ratings_average == 4.5
    assert brief.ratings_distribution == {4: 1, 5: 1}
    assert brief.completed_jobs == 3
    assert brief.comparable_jobs == 5
    assert brief.comparable_min == Decimal("80.00")
    assert brief.comparable_max == Decimal("200.00")
    assert brief.comparable_average == Decimal("140.00")
    assert brief.disputes_total == 2
    assert brief.disputes_open == 1
    assert brief.disputes_resolved == 1
    assert brief.posted_price == Decimal("120.00")
    assert "3 completed jobs" in brief.summary
    assert "average rating of 4.50 from 2 ratings" in brief.summary
    assert "2 disputes, 1 open" in brief.summary
    assert "priced 80.00 to 200.00 (average 140.00)" in brief.summary


async def test_an_unknown_job_raises_not_found(monkeypatch):
    """A brief for a job that does not exist is a 404, never a paid empty answer."""
    install_rows(monkeypatch, job=None)
    gateway = FakeTransactionGateway({SIGNATURE: make_transaction()})

    with pytest.raises(brief_module.RecordNotFoundError):
        await make_service(gateway).read_brief(JOB_ID, SIGNATURE, RESOURCE)


# -- The router --------------------------------------------------------------


async def test_a_request_without_payment_gets_the_x402_challenge(
    monkeypatch, api
):
    """The 402 body an x402 client reads: scheme, network, asset, atomic amount."""
    install_rows(monkeypatch)
    enable_flag(monkeypatch)
    install_service(monkeypatch, FakeTransactionGateway())

    response = await api.get(BRIEF_URL)

    assert response.status_code == 402
    body = response.json()
    assert body["x402Version"] == 1
    assert body["error"] == "payment_missing"
    accept = body["accepts"][0]
    assert accept["scheme"] == "exact"
    assert accept["network"] == NETWORK
    assert accept["asset"] == USDC_MINT
    assert accept["maxAmountRequired"] == str(PAID_ATOMIC)
    assert accept["payTo"] == PAY_TO
    assert accept["maxTimeoutSeconds"] == EXPIRES_SECONDS
    assert accept["resource"].startswith("http://test/api/v1/agent/brief?")
    assert accept["resource"].endswith(f"job_id={JOB_ID}")
    assert accept["extra"]["nonce"] == "nonce-fixed"
    assert accept["extra"]["expiresAt"] == (
        FIXED_NOW + timedelta(seconds=EXPIRES_SECONDS)
    ).isoformat()
    assert accept["extra"]["mintDecimals"] == 6


async def test_a_wrong_mint_payment_is_refused_over_http(monkeypatch, api):
    """The transport answer for the wrong mint is 402 with its own reason."""
    install_rows(monkeypatch)
    enable_flag(monkeypatch)
    install_service(
        monkeypatch,
        FakeTransactionGateway(
            {SIGNATURE: make_transaction(movements=[(OTHER_MINT, PAY_TO, PAID_ATOMIC)])}
        ),
    )

    response = await api.get(BRIEF_URL, headers={"X-PAYMENT": payment_header()})

    assert response.status_code == 402
    body = response.json()
    assert body["error"] == "wrong_mint"
    assert "brief" not in body
    assert body["accepts"][0]["asset"] == USDC_MINT


async def test_the_refusal_reasons_stay_distinct_over_http(monkeypatch, api):
    """Wrong mint and underpaid are different answers, not one generic refusal."""
    enable_flag(monkeypatch)

    install_rows(monkeypatch)
    install_service(
        monkeypatch,
        FakeTransactionGateway(
            {SIGNATURE: make_transaction(movements=[(OTHER_MINT, PAY_TO, PAID_ATOMIC)])}
        ),
    )
    wrong_mint = await api.get(BRIEF_URL, headers={"X-PAYMENT": payment_header()})

    install_rows(monkeypatch)
    install_service(
        monkeypatch,
        FakeTransactionGateway(
            {
                SIGNATURE: make_transaction(
                    movements=[(USDC_MINT, PAY_TO, PAID_ATOMIC - 1)]
                )
            }
        ),
    )
    underpaid = await api.get(BRIEF_URL, headers={"X-PAYMENT": payment_header()})

    assert wrong_mint.json()["error"] == "wrong_mint"
    assert underpaid.json()["error"] == "underpaid"
    assert wrong_mint.status_code == underpaid.status_code == 402


async def test_a_valid_payment_returns_the_brief_over_http(monkeypatch, api):
    """A paid request gets 200 and the brief, with the receipt of what was read."""
    claims = install_rows(monkeypatch)
    enable_flag(monkeypatch)
    install_service(monkeypatch, FakeTransactionGateway({SIGNATURE: make_transaction()}))

    response = await api.get(BRIEF_URL, headers={"X-PAYMENT": payment_header()})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "paid"
    assert body["payment"]["signature"] == SIGNATURE
    assert body["payment"]["mint"] == USDC_MINT
    assert body["payment"]["amount_atomic"] == PAID_ATOMIC
    assert body["brief"]["job_id"] == str(JOB_ID)
    assert body["brief"]["completed_jobs"] == 3
    assert claims == [SIGNATURE]


async def test_a_replay_is_refused_over_http(monkeypatch, api):
    """The second request with the same header is 402, not another 200."""
    install_rows(monkeypatch, claim_results=(True, False))
    enable_flag(monkeypatch)
    install_service(monkeypatch, FakeTransactionGateway({SIGNATURE: make_transaction()}))

    first = await api.get(BRIEF_URL, headers={"X-PAYMENT": payment_header()})
    second = await api.get(BRIEF_URL, headers={"X-PAYMENT": payment_header()})

    assert first.status_code == 200
    assert second.status_code == 402
    assert second.json()["error"] == "payment_already_used"


async def test_a_malformed_payment_header_is_refused_without_a_chain_lookup(
    monkeypatch, api
):
    """Garbage in the header never reaches the gateway or the ledger."""
    claims = install_rows(monkeypatch)
    enable_flag(monkeypatch)
    gateway = FakeTransactionGateway()
    install_service(monkeypatch, gateway)

    response = await api.get(
        BRIEF_URL,
        headers={"X-PAYMENT": base64.b64encode(b"not json").decode()},
    )

    assert response.status_code == 402
    assert response.json()["error"] == "invalid_payment_header"
    assert gateway.calls == []
    assert claims == []


async def test_an_unknown_job_is_404(monkeypatch, api):
    """A job that is not there is a not-found answer, not a challenge to pay."""
    install_rows(monkeypatch, job=None)
    enable_flag(monkeypatch)
    install_service(monkeypatch, FakeTransactionGateway({SIGNATURE: make_transaction()}))

    response = await api.get(BRIEF_URL)

    assert response.status_code == 404
    assert "job_id" in response.json()["detail"]


async def test_the_flag_off_makes_the_endpoint_inert(monkeypatch, api):
    """With the flag off nothing is read, built or charged; the route is 404."""
    monkeypatch.setattr(settings, "FEATURE_X402_AGENT_BRIEF", False)

    def fail_if_called(db):
        raise AssertionError("the service was built with the flag off")

    monkeypatch.setattr(router_module, "build_agent_brief_service", fail_if_called)

    response = await api.get(BRIEF_URL)

    assert response.status_code == 404


# -- The payment header ------------------------------------------------------


def test_the_payment_header_carries_the_signature():
    assert decode_payment_header(payment_header()) == SIGNATURE


@pytest.mark.parametrize(
    "header",
    [
        "",
        "not-base64!",
        base64.b64encode(b"[]").decode(),
        base64.b64encode(b'{"payload": {}}').decode(),
        base64.b64encode(
            b'{"payload": {"signature": "not-a-signature"}}'
        ).decode(),
    ],
)
def test_a_header_without_a_real_signature_is_rejected(header):
    with pytest.raises(ValueError):
        decode_payment_header(header)


# -- The Tatum read ----------------------------------------------------------


def rpc_transaction(
    *,
    signature: str = SIGNATURE,
    pre: list | None = None,
    post: list | None = None,
    error=None,
) -> dict:
    """One getTransaction result, shaped like the node's jsonParsed answer."""
    return {
        "slot": 42,
        "blockTime": 1750000000,
        "transaction": {"signatures": [signature], "message": {}},
        "meta": {
            "err": error,
            "fee": 5000,
            "preTokenBalances": pre or [],
            "postTokenBalances": post or [],
        },
    }


def token_balance(account_index: int, mint: str, owner: str, amount: int) -> dict:
    return {
        "accountIndex": account_index,
        "mint": mint,
        "owner": owner,
        "uiTokenAmount": {"amount": str(amount), "decimals": 6},
    }


def test_parse_transaction_reports_the_token_movements_it_read():
    """The payer's loss and the recipient's gain are both visible, per mint."""
    result = parse_transaction(
        SIGNATURE,
        rpc_transaction(
            pre=[
                token_balance(0, USDC_MINT, PAYER, 25000),
                token_balance(1, USDC_MINT, PAY_TO, 0),
            ],
            post=[
                token_balance(0, USDC_MINT, PAYER, 15000),
                token_balance(1, USDC_MINT, PAY_TO, 10000),
            ],
        ),
    )

    assert result.succeeded is True
    assert result.error_kind is None
    movements = {(m.mint, m.owner): m.delta_atomic for m in result.token_deltas}
    assert movements == {
        (USDC_MINT, PAYER): -10000,
        (USDC_MINT, PAY_TO): 10000,
    }


def test_parse_transaction_marks_a_failed_transaction_as_failed():
    result = parse_transaction(
        SIGNATURE,
        rpc_transaction(error={"InstructionError": [0, "Custom"]}),
    )

    assert result.succeeded is False
    assert result.error_kind is None


def test_parse_transaction_refuses_a_missing_meta_block():
    """No meta means no evidence, and no evidence is never a payment."""
    result = parse_transaction(SIGNATURE, {"slot": 1, "transaction": {"signatures": [SIGNATURE]}})

    assert result.succeeded is False
    assert result.error_kind == "malformed_response"


def test_parse_transaction_refuses_a_transaction_for_another_signature():
    """A node answer about a different transaction proves nothing about this one."""
    result = parse_transaction(
        SIGNATURE,
        rpc_transaction(signature=SECOND_SIGNATURE),
    )

    assert result.error_kind == "malformed_response"


class FakeHttpResponse:
    def __init__(self, payload=None) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self):
        return self._payload


class FakeHttpClient:
    def __init__(self, responses) -> None:
        self._responses = list(responses)
        self.requests: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    async def post(self, url, json=None, headers=None):
        self.requests.append({"url": url, "json": json, "headers": dict(headers or {})})
        response = self._responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


def make_gateway(monkeypatch, responses) -> tuple:
    http = FakeHttpClient(responses)
    monkeypatch.setattr(
        gateway_module.httpx, "AsyncClient", lambda **kwargs: http
    )
    boundary = Boundary(
        ResiliencePolicy(
            dependency="tatum-solana-rpc",
            timeout_seconds=0.5,
            failure_threshold=3,
            reset_timeout_seconds=10.0,
            max_attempts=1,
            max_concurrency=1,
        ),
        StructuredLogMetricSink("tatum-solana-test"),
    )
    gateway = TatumSolanaTransactionGateway(
        boundary=boundary,
        rpc_url="https://solana-devnet.gateway.tatum.io",
        api_key="test-tatum-key",
    )
    return gateway, http


async def test_get_transaction_posts_to_tatum_with_the_key_in_the_header_only(
    monkeypatch,
):
    """The key travels in x-api-key; the URL never carries it."""
    gateway, http = make_gateway(
        monkeypatch,
        [FakeHttpResponse({"jsonrpc": "2.0", "id": 1, "result": rpc_transaction()})],
    )

    result = await gateway.get_transaction(SIGNATURE)

    assert result.succeeded is True
    request = http.requests[0]
    assert request["url"] == "https://solana-devnet.gateway.tatum.io"
    assert request["headers"]["x-api-key"] == "test-tatum-key"
    assert "test-tatum-key" not in request["url"]
    assert request["json"]["method"] == "getTransaction"
    assert request["json"]["params"][0] == SIGNATURE
    assert request["json"]["params"][1]["encoding"] == "jsonParsed"
    assert request["json"]["params"][1]["commitment"] == "confirmed"


async def test_an_unknown_signature_is_reported_as_not_found(monkeypatch):
    """A null result is a normal answer: the transaction does not exist."""
    gateway, _ = make_gateway(
        monkeypatch, [FakeHttpResponse({"jsonrpc": "2.0", "id": 1, "result": None})]
    )

    result = await gateway.get_transaction(SIGNATURE)

    assert result.error_kind == "transaction_not_found"
    assert result.succeeded is False


async def test_a_gateway_failure_raises_and_never_leaks_the_key(monkeypatch):
    """A transport failure refuses the payment, with the key redacted from text."""
    gateway, _ = make_gateway(
        monkeypatch, [RuntimeError("401 for x-api-key test-tatum-key")]
    )

    with pytest.raises(SolanaTransactionError) as raised:
        await gateway.get_transaction(SIGNATURE)

    assert "test-tatum-key" not in str(raised.value)
    assert "[redacted]" in str(raised.value)


# -- The configuration -------------------------------------------------------


def test_the_flag_defaults_to_off():
    """The endpoint ships inert: an unset environment must not enable a paywall."""
    assert Settings.model_fields["FEATURE_X402_AGENT_BRIEF"].default is False


def test_a_configured_flag_without_a_recipient_stays_inert(monkeypatch):
    """No address to pay means no challenge, even with the flag on."""
    monkeypatch.setattr(settings, "FEATURE_X402_AGENT_BRIEF", True)
    monkeypatch.setattr(settings, "USDC_MINT_DEVNET", USDC_MINT)
    monkeypatch.setattr(settings, "X402_AGENT_BRIEF_PAY_TO", "")
    monkeypatch.setattr(settings, "X402_AGENT_BRIEF_PRICE_ATOMIC", PAID_ATOMIC)

    # Bound to a name first: a failing assertion on the settings object itself
    # would print the whole environment, credentials included, into the report.
    enabled = settings.x402_agent_brief_enabled
    assert enabled is False
