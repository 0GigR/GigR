"""Schemas for Aurora Intents multi-chain liquidity and execution.

Conforms strictly to house-standard.md:
- Explicit bounds and worst-case input validation
- Zero emojis anywhere
- Allowlist validation
"""

from __future__ import annotations

import re
from typing import Optional
from pydantic import BaseModel, Field, field_validator


class AuroraQuoteRequest(BaseModel):
    """Wire input for requesting a cross-chain quote."""

    origin_asset: str = Field(..., min_length=1, max_length=150)
    destination_asset: Optional[str] = Field(default=None, max_length=150)
    amount: str = Field(..., min_length=1, max_length=50)
    recipient: str = Field(..., min_length=32, max_length=64)
    refund_to: str = Field(..., min_length=20, max_length=100)
    swap_type: str = Field(default="EXACT_INPUT")
    slippage_tolerance: int = Field(default=100, ge=10, le=5000)

    @field_validator("recipient", mode="before")
    @classmethod
    def _validate_recipient(cls, v: object) -> str:
        s = str(v).strip()
        if not re.fullmatch(r"[1-9A-HJ-NP-Za-km-z]{32,44}", s):
            raise ValueError("Recipient must be a valid base58 Solana address.")
        return s

    @field_validator("swap_type")
    @classmethod
    def _validate_swap_type(cls, v: str) -> str:
        cleaned = v.strip().upper()
        if cleaned not in ("EXACT_INPUT", "EXACT_OUTPUT", "FLEX_INPUT", "ANY_INPUT"):
            raise ValueError("Invalid swap type specified.")
        return cleaned


class AuroraStatusQuery(BaseModel):
    """Query parameters for polling deposit address status."""

    deposit_address: str = Field(..., min_length=1, max_length=128)


class AuroraTokenItem(BaseModel):
    """Normalized token descriptor for multi-chain selection."""

    asset_id: str
    symbol: str
    blockchain: str
    decimals: int
    contract_address: Optional[str] = None
    price_usd: Optional[float] = None


class AuroraStatusResponse(BaseModel):
    """Status payload indicating feature readiness and deployment configuration."""

    enabled: bool
    configured: bool
    base_url: str
    fee_bps: int
    network: str = "devnet"
