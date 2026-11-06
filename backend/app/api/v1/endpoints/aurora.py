"""Aurora Intents endpoint: provides any-chain liquidity and quote discovery.

Conforms strictly to house-standard.md:
- Pure router: parse request, call service, shape response
- No business logic or SQL inside router
- Deny by default: 404 Not Found when FEATURE_AURORA_INTENTS is false
- Zero emojis anywhere in strings or comments
"""

from __future__ import annotations

import logging
from typing import Any
from fastapi import APIRouter, HTTPException, Query, status

from ....core.config import settings
from ....core.container import build_aurora_intents_service
from ....core.errors import DependencyUnavailableError
from ....schemas.aurora import (
    AuroraQuoteRequest,
    AuroraStatusResponse,
)

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/status", response_model=AuroraStatusResponse)
async def get_aurora_status() -> AuroraStatusResponse:
    """Return the operational status of the Aurora Intents integration."""
    return AuroraStatusResponse(
        enabled=settings.FEATURE_AURORA_INTENTS,
        configured=settings.aurora_intents_enabled,
        base_url=settings.AURORA_INTENTS_BASE_URL,
        fee_bps=settings.AURORA_INTENTS_FEE_BPS,
        network="devnet",
    )


@router.get("/tokens")
async def get_supported_tokens() -> list[dict[str, Any]]:
    """Retrieve supported tokens and multi-chain network availability."""
    if not settings.aurora_intents_enabled:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Aurora Intents integration is not enabled on this deployment.",
        )

    service = build_aurora_intents_service()
    try:
        return await service.get_tokens()
    except DependencyUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Aurora Intents service unavailable: {exc.message}",
        )


@router.post("/quote")
async def request_aurora_quote(request: AuroraQuoteRequest) -> dict[str, Any]:
    """Generate a quote and an any-chain deposit address."""
    if not settings.aurora_intents_enabled:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Aurora Intents integration is not enabled on this deployment.",
        )

    service = build_aurora_intents_service()
    try:
        return await service.create_quote(request)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=str(exc),
        )
    except DependencyUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Failed to generate quote from Aurora Intents: {exc.message}",
        )


@router.get("/deposit-status")
async def check_deposit_status(
    deposit_address: str = Query(..., min_length=1, max_length=128),
) -> dict[str, Any]:
    """Poll the settlement status of an issued deposit address."""
    if not settings.aurora_intents_enabled:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Aurora Intents integration is not enabled on this deployment.",
        )

    service = build_aurora_intents_service()
    try:
        return await service.check_status(deposit_address)
    except DependencyUnavailableError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Unable to fetch deposit status: {exc.message}",
        )


