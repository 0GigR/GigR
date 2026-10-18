"""The payment rail is chosen per request (X-Payment-Rail), not globally."""
import pytest

from app.core import rail
from app.core.config import settings


@pytest.fixture
def both_rails(monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_CLIENT_ID", "id")
    monkeypatch.setattr(settings, "PAYPAL_CLIENT_SECRET", "secret")
    for name in ("GIGR_PROGRAM_ID", "SOLANA_RPC_URL", "PLATFORM_KEYPAIR",
                 "WALLET_ENCRYPTION_KEY", "USDC_MINT_DEVNET"):
        monkeypatch.setattr(settings, name, "x")


def test_both_rails_offered_when_configured(both_rails):
    assert set(settings.available_rails) == {"solana", "paypal"}


def test_default_is_solana_when_configured_else_paypal(both_rails, monkeypatch):
    assert settings.default_rail == "solana"
    monkeypatch.setattr(settings, "GIGR_PROGRAM_ID", "")
    assert settings.default_rail == "paypal"


def test_header_choice_wins_over_default(both_rails):
    token = rail.set_request_rail("paypal")
    try:
        assert rail.current_rail() == "paypal"
    finally:
        rail.reset_request_rail(token)
    assert rail.current_rail() == "solana"


def test_unknown_value_falls_back_to_default(both_rails):
    token = rail.set_request_rail("bogus")
    try:
        assert rail.current_rail() == "solana"
    finally:
        rail.reset_request_rail(token)


def test_agent_task_context_is_readopted(both_rails):
    """The agent worker has no request; it restores the rail and frontend the task was queued from."""
    rail.adopt("paypal", "https://pay.example.com/")
    try:
        assert rail.current_rail() == "paypal"
        assert rail.current_frontend_url() == "https://pay.example.com"
    finally:
        rail.adopt(None, None)
    assert rail.current_rail() == "solana"


async def test_every_request_carries_the_rail_end_to_end(both_rails, monkeypatch):
    """Middleware → contextvar → endpoint, and CORS lets the custom header through."""
    import httpx
    from app.main import app

    monkeypatch.setattr(settings, "PAYPAL_CLIENT_ID", "id")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        for want in ("paypal", "solana"):
            r = await c.get("/api/v1/config/public", headers={"X-Payment-Rail": want})
            assert r.json()["payment_rail"] == want
        pre = await c.options("/api/v1/config/public", headers={
            "Origin": "http://localhost:5173", "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "x-payment-rail,authorization"})
        assert pre.status_code == 200
        assert "x-payment-rail" in pre.headers["access-control-allow-headers"].lower()
