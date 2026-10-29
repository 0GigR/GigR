"""Wire format for the x402 challenge, its payment header, and the brief.

Two shapes here are other people's: the 402 body an x402 client understands and
the base64 ``X-PAYMENT`` header it sends back. Both are parsed or built at the
transport boundary, which is why the validation lives here and not in the
service. The brief's own response model is the third shape.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from datetime import datetime
from typing import Any, Literal
from uuid import UUID

from pydantic import BaseModel, Field

# A Solana signature is base58 and far shorter than this. The bound rejects a
# header that is not a signature before any base64 work is done on it, and the
# 4 KiB cap stops a caller from making the process decode an unbounded value.
MAX_PAYMENT_HEADER_CHARS = 4096
_SIGNATURE_PATTERN = re.compile(r"^[1-9A-HJ-NP-Za-km-z]{64,100}$")


class X402Accept(BaseModel):
    """One payment option in an x402 challenge."""

    scheme: Literal["exact"] = "exact"
    network: str
    maxAmountRequired: str
    resource: str
    description: str
    mimeType: str = "application/json"
    payTo: str
    asset: str
    maxTimeoutSeconds: int
    extra: dict[str, Any] = Field(default_factory=dict)


class X402PaymentRequired(BaseModel):
    """The HTTP 402 body: what to pay, and why the last attempt did not count."""

    x402Version: int = 1
    accepts: list[X402Accept]
    error: str | None = None


class X402PaymentPayload(BaseModel):
    """The part of the ``X-PAYMENT`` header this endpoint reads.

    ``payload.signature`` is the settlement transaction's signature. The x402
    envelope's other fields are accepted and ignored: the signature is the proof,
    and it is checked against the chain, not against the envelope's claims.
    """

    x402Version: int | None = None
    scheme: str | None = None
    network: str | None = None
    payload: dict[str, Any]


def decode_payment_header(value: str) -> str:
    """Return the settlement signature carried by an ``X-PAYMENT`` header.

    Raises ``ValueError`` for anything that is not base64-encoded JSON carrying a
    well-formed Solana signature. The caller turns that into a 402 with its own
    reason; a malformed header must never reach the chain lookup.
    """
    if not value or len(value) > MAX_PAYMENT_HEADER_CHARS:
        raise ValueError("payment header is empty or too long")
    try:
        raw = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("payment header is not valid base64") from exc
    try:
        decoded = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("payment header is not valid JSON") from exc
    if not isinstance(decoded, dict):
        raise ValueError("payment header is not a JSON object")
    payload = decoded.get("payload")
    if not isinstance(payload, dict):
        raise ValueError("payment header has no payload object")
    signature = payload.get("signature")
    if not isinstance(signature, str) or not _SIGNATURE_PATTERN.match(signature):
        raise ValueError("payment header carries no valid Solana signature")
    return signature


def build_payment_required_body(
    *,
    network: str,
    mint: str,
    amount_atomic: int,
    pay_to: str,
    resource: str,
    nonce: str,
    expires_at: datetime,
    decimals: int,
    max_timeout_seconds: int,
    reason: str | None,
    description: str,
) -> dict[str, Any]:
    """The 402 body, with the amount in atomic units and the quote's expiry.

    ``maxAmountRequired`` and ``asset`` are the fields an x402 client reads; the
    nonce and expiry travel in ``extra`` because the scheme's standard fields do
    not carry a quote identity. The nonce is not a security control -- it cannot
    be validated without server-side state, and the verified signature is what
    makes a payment real -- so it is documented as a quote tag, nothing more.
    """
    body = X402PaymentRequired(
        accepts=[
            X402Accept(
                network=network,
                maxAmountRequired=str(amount_atomic),
                resource=resource,
                description=description,
                payTo=pay_to,
                asset=mint,
                maxTimeoutSeconds=max_timeout_seconds,
                extra={
                    "nonce": nonce,
                    "expiresAt": expires_at.isoformat(),
                    "mintDecimals": decimals,
                    "mint": mint,
                },
            )
        ],
        error=reason,
    )
    return body.model_dump()


class RatingSummary(BaseModel):
    """The provider's received ratings, aggregated."""

    count: int
    average: float | None
    distribution: dict[int, int]


class ComparableJobs(BaseModel):
    """Completed jobs in the same category, aggregated."""

    count: int
    min_price: float | None
    max_price: float | None
    average_price: float | None


class DisputeSummary(BaseModel):
    """The provider's disputes, counted by status."""

    total: int
    open: int
    resolved: int


class AgentBriefOut(BaseModel):
    """The job and its provider's history, every number from a database row."""

    job_id: UUID
    title: str
    job_status: str
    posted_price: float | None
    provider_id: UUID | None
    ratings: RatingSummary
    completed_jobs: int
    comparable_jobs: ComparableJobs
    disputes: DisputeSummary
    has_history: bool
    summary: str


class PaymentReceipt(BaseModel):
    """What was verified on chain before the brief was returned."""

    signature: str
    network: str
    mint: str
    amount_atomic: int
    pay_to: str


class AgentBriefPaidOut(BaseModel):
    """A 200: the payment was verified and the brief is the content it bought."""

    status: Literal["paid"] = "paid"
    payment: PaymentReceipt
    brief: AgentBriefOut


class AgentBriefPurchasedOut(AgentBriefPaidOut):
    """A 200 from the purchase route: the paid brief, plus how it was paid for.

    ``already_purchased`` is true when this tap found a purchase that had already
    completed and re-served its brief instead of charging again. It is not a
    failure and not a new payment.
    """

    already_purchased: bool = False


class AgentBriefPurchaseFailure(BaseModel):
    """A purchase answer that is not paid: typed, and explicit about the money.

    ``payment_state`` is the honest answer about the transfer, not about the
    purchase: ``none`` means nothing was submitted, ``unknown`` means a send may
    have reached the network without a signature coming back, ``submitted`` means
    the node accepted it and it is not confirmed yet, and ``confirmed`` means it
    is on chain (whether or not it paid for this brief).

    ``message`` is the sentence to show: what happened and what to do next. The
    amounts are present for the one reason that compares them.
    """

    status: Literal["failed", "pending"]
    reason: str
    message: str
    payment_state: Literal["none", "unknown", "submitted", "confirmed"]
    signature: str | None = None
    required_atomic: int | None = None
    available_atomic: int | None = None
