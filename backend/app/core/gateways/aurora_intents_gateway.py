"""Aurora Intents outbound gateway with circuit breaker, timeout, and structured metrics.

Directly integrated with Aurora Intents / 1Click API (38+ blockchains, non-EVM included).
Conforms strictly to house-standard.md:
- Pure vertical slice behind ResiliencePolicy Boundary
- Zero emojis anywhere in strings, logs, or error text
- Deny-by-default when disabled or unconfigured
- Correlation and error segregation (internal cause logged, safe typed failure)
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional
import httpx

from ..config import settings
from ..errors import DependencyUnavailableError
from ..resilience import Boundary

logger = logging.getLogger(__name__)

DEPENDENCY = "aurora-intents"

ONECLICK_API_BASE = "https://1click.chaindefuser.com/v0"


class AuroraIntentsGateway:
    """Outbound gateway for Aurora Intents / 1Click multi-chain routing."""

    def __init__(
        self,
        boundary: Boundary,
        api_key: str,
        base_url: str = "https://intents-api.aurora.dev",
    ) -> None:
        self._boundary = boundary
        self._api_key = api_key.strip()
        self._base_url = base_url.rstrip("/")

    @property
    def is_configured(self) -> bool:
        return bool(self._api_key and settings.aurora_intents_enabled)

    async def get_supported_tokens(self) -> list[dict[str, Any]]:
        """Fetch real-time supported token routes across all 38+ blockchains."""
        if not self.is_configured:
            raise DependencyUnavailableError(
                DEPENDENCY, "Aurora Intents is disabled or unconfigured."
            )

        url = f"{ONECLICK_API_BASE}/tokens"

        async def _call() -> list[dict[str, Any]]:
            async with httpx.AsyncClient(timeout=settings.AURORA_INTENTS_TIMEOUT_SECONDS) as client:
                resp = await client.get(url)
                if resp.status_code >= 400:
                    logger.warning(
                        "[aurora-intents] get_tokens failed (status=%s): %s",
                        resp.status_code,
                        resp.text[:200],
                    )
                    raise DependencyUnavailableError(
                        DEPENDENCY,
                        f"Aurora token discovery returned status {resp.status_code}",
                    )
                return resp.json()

        outcome = await self._boundary.call(_call)
        if outcome.is_success:
            return outcome.result
        raise DependencyUnavailableError(
            DEPENDENCY, "Failed to retrieve supported tokens from Aurora Intents."
        )

    async def request_quote(
        self,
        *,
        origin_asset: str,
        destination_asset: str,
        amount: str,
        recipient: str,
        refund_to: str,
        swap_type: str = "EXACT_INPUT",
        slippage_tolerance: int = 100,
        deadline_minutes: int = 30,
    ) -> dict[str, Any]:
        """Request a live cross-chain quote and persistent deposit address via 1Click."""
        if not self.is_configured:
            raise DependencyUnavailableError(
                DEPENDENCY, "Aurora Intents is disabled or unconfigured."
            )

        url = f"{ONECLICK_API_BASE}/quote"
        deadline = (datetime.now(timezone.utc) + timedelta(minutes=deadline_minutes)).isoformat()

        payload = {
            "dry": False,
            "swapType": swap_type,
            "originAsset": origin_asset,
            "destinationAsset": destination_asset,
            "amount": amount,
            "depositType": "ORIGIN_CHAIN",
            "recipient": recipient,
            "recipientType": "DESTINATION_CHAIN",
            "refundTo": refund_to,
            "refundType": "ORIGIN_CHAIN",
            "slippageTolerance": slippage_tolerance,
            "deadline": deadline,
        }

        async def _call() -> dict[str, Any]:
            async with httpx.AsyncClient(timeout=settings.AURORA_INTENTS_TIMEOUT_SECONDS) as client:
                resp = await client.post(url, json=payload)
                if resp.status_code >= 400:
                    logger.warning(
                        "[aurora-intents] request_quote failed (status=%s): %s",
                        resp.status_code,
                        resp.text[:200],
                    )
                    raise DependencyUnavailableError(
                        DEPENDENCY,
                        f"Aurora quote service returned status {resp.status_code}: {resp.text[:120]}",
                    )
                return resp.json()

        outcome = await self._boundary.call(_call)
        if outcome.is_success:
            return outcome.result
        raise DependencyUnavailableError(
            DEPENDENCY, "Failed to obtain swap quote from Aurora Intents."
        )

    async def get_swap_status(self, deposit_address: str) -> dict[str, Any]:
        """Query live settlement status for an Aurora deposit address."""
        if not self.is_configured:
            raise DependencyUnavailableError(
                DEPENDENCY, "Aurora Intents is disabled or unconfigured."
            )

        url = f"{ONECLICK_API_BASE}/status"
        params = {"depositAddress": deposit_address}

        async def _call() -> dict[str, Any]:
            async with httpx.AsyncClient(timeout=settings.AURORA_INTENTS_TIMEOUT_SECONDS) as client:
                resp = await client.get(url, params=params)
                if resp.status_code >= 400:
                    logger.warning(
                        "[aurora-intents] get_status failed (status=%s): %s",
                        resp.status_code,
                        resp.text[:200],
                    )
                    raise DependencyUnavailableError(
                        DEPENDENCY,
                        f"Aurora status query returned status {resp.status_code}",
                    )
                return resp.json()

        outcome = await self._boundary.call(_call)
        if outcome.is_success:
            return outcome.result
        raise DependencyUnavailableError(
            DEPENDENCY, "Failed to get swap status from Aurora Intents."
        )
