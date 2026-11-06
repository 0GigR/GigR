"""Aurora Intents service: coordinates quote fetching and multi-chain status queries.

Conforms strictly to house-standard.md:
- Pure business logic layer (no raw queries, no HTTP direct calls)
- Injected gateway dependency from composition root
- Zero emojis anywhere in code, comments, or error text
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from ..core.errors import DependencyUnavailableError
from ..core.gateways.aurora_intents_gateway import AuroraIntentsGateway
from ..schemas.aurora import AuroraQuoteRequest

logger = logging.getLogger(__name__)

# Default Solana USDC on 1Click NEAR Intents
SOLANA_USDC_ASSET_ID = "nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near"


class AuroraIntentsService:
    """Coordinates Aurora Intents multi-chain operations."""

    def __init__(self, gateway: AuroraIntentsGateway) -> None:
        self._gateway = gateway

    @property
    def is_enabled(self) -> bool:
        return self._gateway.is_configured

    async def get_tokens(self) -> list[dict[str, Any]]:
        """Retrieve live token routes across 38+ blockchains from Aurora 1Click."""
        if not self.is_enabled:
            raise DependencyUnavailableError(
                "aurora-intents", "Aurora Intents is currently disabled."
            )
        return await self._gateway.get_supported_tokens()

    async def create_quote(self, request: AuroraQuoteRequest) -> dict[str, Any]:
        """Request a quote and generate an any-chain deposit address."""
        if not self.is_enabled:
            raise DependencyUnavailableError(
                "aurora-intents", "Aurora Intents is currently disabled."
            )
        dest_asset = request.destination_asset or SOLANA_USDC_ASSET_ID

        return await self._gateway.request_quote(
            origin_asset=request.origin_asset,
            destination_asset=dest_asset,
            amount=request.amount,
            recipient=request.recipient,
            refund_to=request.refund_to,
            swap_type=request.swap_type,
            slippage_tolerance=request.slippage_tolerance,
        )

    async def check_status(self, deposit_address: str) -> dict[str, Any]:
        """Poll the settlement status of an issued deposit address."""
        if not self.is_enabled:
            raise DependencyUnavailableError(
                "aurora-intents", "Aurora Intents is currently disabled."
            )
        return await self._gateway.get_swap_status(deposit_address)

    async def simulate_settlement(self, recipient: str, amount_usdc: float) -> str:
        """Simulate Devnet cross-chain settlement by transferring test USDC to recipient."""
        if not self.is_enabled:
            raise DependencyUnavailableError(
                "aurora-intents", "Aurora Intents is currently disabled."
            )
        from .solana_client import transfer_platform_usdc
        return await transfer_platform_usdc(recipient, amount_usdc)

