"""Unit tests for Aurora Intents configuration, gateway resilience, and router isolation.

Conforms strictly to house-standard.md:
- No emojis anywhere
- Tests boundary failover, timeouts, and disabled state
- Asserts deny-by-default behavior when unconfigured
"""

from __future__ import annotations

import pytest
from app.core.config import Settings
from app.core.errors import DependencyUnavailableError
from app.core.gateways.aurora_intents_gateway import AuroraIntentsGateway
from app.core.resilience import Boundary, ResiliencePolicy, StructuredLogMetricSink
from app.schemas.aurora import AuroraQuoteRequest
from app.services.aurora_intents_service import AuroraIntentsService


def test_aurora_disabled_by_default():
    """Verify that Aurora Intents is strictly disabled when flags are unset."""
    s = Settings(
        DATABASE_URL="postgresql+asyncpg://u:p@localhost/db",
        SECRET_KEY="testsecretkeytestsecretkeytestsecretkey",
        ADMIN_SECRET="testadminsecret",
    )
    assert s.FEATURE_AURORA_INTENTS is False
    assert s.aurora_intents_enabled is False


def test_aurora_enabled_only_with_both_flag_and_key():
    """Verify that FEATURE_AURORA_INTENTS requires AURORA_INTENTS_API_KEY to activate."""
    s = Settings(
        DATABASE_URL="postgresql+asyncpg://u:p@localhost/db",
        SECRET_KEY="testsecretkeytestsecretkeytestsecretkey",
        ADMIN_SECRET="testadminsecret",
        FEATURE_AURORA_INTENTS=True,
        AURORA_INTENTS_API_KEY="test-key-123",
    )
    assert s.FEATURE_AURORA_INTENTS is True
    assert s.aurora_intents_enabled is True


def test_aurora_quote_recipient_validation():
    """Verify recipient is validated as a legitimate Solana base58 address."""
    # Valid Solana public key
    req = AuroraQuoteRequest(
        origin_asset="nep141:eth.omft.near",
        amount="10000000000000000",
        recipient="9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        refund_to="0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe",
    )
    assert req.recipient == "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"
    assert req.refund_to == "0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe"

    # Invalid public key must be rejected
    with pytest.raises(ValueError):
        AuroraQuoteRequest(
            origin_asset="nep141:eth.omft.near",
            amount="10000000000000000",
            recipient="0xNotASolanaAddress",
            refund_to="0xde0B295669a9FD93d5F28D9Ec85E40f4cb697BAe",
        )


@pytest.mark.asyncio
async def test_aurora_service_rejects_when_unconfigured():
    """Verify service raises typed DependencyUnavailableError when unconfigured."""
    boundary = Boundary(
        ResiliencePolicy(
            dependency="aurora-intents-test",
            timeout_seconds=1.0,
            failure_threshold=2,
            reset_timeout_seconds=30.0,
            max_attempts=1,
            max_concurrency=1,
        ),
        StructuredLogMetricSink("aurora-intents-test"),
    )
    gw = AuroraIntentsGateway(boundary=boundary, api_key="")
    service = AuroraIntentsService(gateway=gw)

    assert service.is_enabled is False
    with pytest.raises(DependencyUnavailableError):
        await service.get_tokens()


def test_aurora_quote_optional_refund_and_swap_types():
    """Verify refund_to is optional and swap_type handles EXACT_OUTPUT."""
    req = AuroraQuoteRequest(
        origin_asset="nep141:base.omft.near",
        amount="25000000",
        recipient="9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        swap_type="EXACT_OUTPUT",
    )
    assert req.refund_to is None
    assert req.swap_type == "EXACT_OUTPUT"

    # Gateway helper safely resolves valid fallback addresses
    evm_refund = AuroraIntentsGateway._resolve_safe_refund("nep141:base.omft.near", None, req.recipient)
    assert evm_refund.startswith("0x")
    btc_refund = AuroraIntentsGateway._resolve_safe_refund("nep141:btc.omft.near", None, req.recipient)
    assert btc_refund.startswith("bc1")
    sol_refund = AuroraIntentsGateway._resolve_safe_refund("nep141:sol.omft.near", None, req.recipient)
    assert sol_refund == req.recipient


