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
