"""Tatum Solana transaction read: the one place a payment is looked up on chain.

Only ``getTransaction`` is spoken here, over the Tatum Solana gateway's
JSON-RPC endpoint. The API key travels as the ``x-api-key`` request header,
never in the URL and never in a log line or an error string: the URL is what an
exception tends to echo, so the key is filtered out by value before the
boundary's metric sink can see it, exactly as the escrow read path does.

This is a read. Nothing here builds or sends a transaction, so it cannot touch
the escrow path, the Anchor program, or the Tatum read/write split that keeps
every write on ``SOLANA_RPC_URL``.

Every lookup crosses the injected :class:`Boundary` (timeout, breaker, bulkhead,
bounded retry for this idempotent read). A node that answers that the signature
is unknown is a normal answer, not a dependency failure, so it does not count
toward the breaker. A transport failure raises a typed error and the caller
refuses the payment; there is no silent null.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx

from ..errors import DependencyUnavailableError
from ..resilience import Boundary, failure_fallback


DEPENDENCY = "tatum-solana-rpc"

REQUEST_TIMEOUT_SECONDS = 10.0

# Tokens a transaction moved, as the node reports them. ``owner`` is the token
# account's owner: the wallet address a payment was sent to, not the associated
# token account, which is derived per payer and per mint.
@dataclass(frozen=True)
class TokenBalanceDelta:
    """One token account's balance change, in atomic units."""

    mint: str
    owner: str
    delta_atomic: int


@dataclass(frozen=True)
class SolanaTransaction:
    """A confirmed transaction, as far as a payment check needs it.

    ``error_kind`` is set when the node did not return a usable transaction:
    ``transaction_not_found`` when the signature is unknown, ``rpc_error`` when
    the gateway rejected the request, ``malformed_response`` when the answer is
    not shaped like a transaction. In those cases ``token_deltas`` is empty and
    ``succeeded`` is False, so the caller must refuse.
    """

    signature: str
    slot: int | None
    succeeded: bool
    error: str | None
    token_deltas: tuple[TokenBalanceDelta, ...]
    error_kind: str | None = None


class SolanaTransactionError(DependencyUnavailableError):
    """The gateway could not answer at all. The caller refuses; it never allows."""

    def __init__(self, message: str) -> None:
        super().__init__(DEPENDENCY, message)


def _redact(secret: str, text: str) -> str:
    """Remove the API key from outbound error text before it can be logged."""
    if secret and text and secret in text:
        return text.replace(secret, "[redacted]")
    return text


def _atomic_amount(entry: dict[str, Any]) -> int | None:
    """The atomic amount of one token balance entry, or None when unreadable."""
    amount = (entry.get("uiTokenAmount") or {}).get("amount")
    try:
        return int(amount)
    except (TypeError, ValueError):
        return None


def _balances(entries: Any) -> dict[tuple[str, str], int] | None:
    """Sum token balances by (mint, owner), or None when the list is unreadable."""
    if entries is None:
        return {}
    if not isinstance(entries, list):
        return None
    totals: dict[tuple[str, str], int] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            return None
        mint = entry.get("mint")
        owner = entry.get("owner")
        if not isinstance(mint, str) or not isinstance(owner, str):
            # A balance without a mint or an owner cannot be attributed to a
            # payment, so the whole answer is treated as unreadable rather than
            # guessing which movement it was.
            return None
        amount = _atomic_amount(entry)
        if amount is None:
            return None
        totals[(mint, owner)] = totals.get((mint, owner), 0) + amount
    return totals


def parse_transaction(signature: str, result: Any) -> SolanaTransaction:
    """Turn one ``getTransaction`` result into the payment-relevant view.

    A result that does not carry a meta block, a signature list that does not
    start with the signature that was asked for, or a token balance list that
    cannot be read all produce ``error_kind == "malformed_response"``. A node
    answer that cannot be read must never look like a successful payment.
    """
    if not isinstance(result, dict):
        return SolanaTransaction(
            signature=signature,
            slot=None,
            succeeded=False,
            error=None,
            token_deltas=(),
            error_kind="malformed_response",
        )

    meta = result.get("meta")
    if not isinstance(meta, dict):
        return SolanaTransaction(
            signature=signature,
            slot=None,
            succeeded=False,
            error=None,
            token_deltas=(),
            error_kind="malformed_response",
        )

    block = result.get("transaction")
    signatures = block.get("signatures") if isinstance(block, dict) else None
    if not isinstance(signatures, list) or not signatures or signatures[0] != signature:
        return SolanaTransaction(
            signature=signature,
            slot=None,
            succeeded=False,
            error=None,
            token_deltas=(),
            error_kind="malformed_response",
        )

    pre = _balances(meta.get("preTokenBalances"))
    post = _balances(meta.get("postTokenBalances"))
    if pre is None or post is None:
        return SolanaTransaction(
            signature=signature,
            slot=None,
            succeeded=False,
            error=None,
            token_deltas=(),
            error_kind="malformed_response",
        )

    movements: list[TokenBalanceDelta] = []
    for (mint, owner) in sorted(set(pre) | set(post)):
        delta = post.get((mint, owner), 0) - pre.get((mint, owner), 0)
        if delta != 0:
            movements.append(
                TokenBalanceDelta(mint=mint, owner=owner, delta_atomic=delta)
            )

    error = meta.get("err")
    slot = result.get("slot")
    return SolanaTransaction(
        signature=signature,
        slot=slot if isinstance(slot, int) else None,
        succeeded=error is None,
        error=None if error is None else str(error),
        token_deltas=tuple(movements),
    )


class TatumSolanaTransactionGateway:
    """Read one confirmed Solana transaction from the Tatum gateway."""

    def __init__(
        self,
        boundary: Boundary,
        rpc_url: str,
        api_key: str,
        request_timeout_seconds: float = REQUEST_TIMEOUT_SECONDS,
    ) -> None:
        self._boundary = boundary
        self._rpc_url = rpc_url
        self._api_key = api_key
        self._request_timeout_seconds = request_timeout_seconds

    @property
    def configured(self) -> bool:
        """True only when both the endpoint and the network's key are present."""
        return bool(self._rpc_url and self._api_key)

    def __repr__(self) -> str:
        return (
            f"TatumSolanaTransactionGateway(rpc_url={self._rpc_url!r}, "
            f"configured={self.configured})"
        )

    def __str__(self) -> str:
        return self.__repr__()

    def _payload(self, signature: str) -> dict[str, Any]:
        """The documented getTransaction request, with a parsed meta block."""
        return {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "getTransaction",
            "params": [
                signature,
                {
                    "encoding": "jsonParsed",
                    # Confirmed, not finalized: the brief is a small, read-only
                    # report and waiting for finality would make every payer
                    # wait about 13 more seconds. The payment is checked once,
                    # at sale time.
                    "commitment": "confirmed",
                    "maxSupportedTransactionVersion": 0,
                },
            ],
        }

    async def _post(self, payload: dict[str, Any]) -> Any:
        """One JSON-RPC POST. The key is a header, never part of the URL."""
        async with httpx.AsyncClient(timeout=self._request_timeout_seconds) as client:
            response = await client.post(
                self._rpc_url,
                json=payload,
                headers={"x-api-key": self._api_key, "content-type": "application/json"},
            )
            response.raise_for_status()
            return response.json()

    async def get_transaction(self, signature: str) -> SolanaTransaction:
        """Look one signature up on chain.

        Returns the transaction with ``error_kind`` set for an unknown signature,
        a JSON-RPC error, or an unreadable answer. Raises
        :class:`SolanaTransactionError` when the gateway could not answer at all
        (timeout, transport, auth, breaker open). The caller refuses the payment
        in every one of those cases.
        """
        if not signature:
            raise ValueError("get_transaction requires a signature")
        if not self.configured:
            raise SolanaTransactionError(
                "tatum-solana-rpc: getTransaction is not configured; set "
                "TATUM_SOLANA_RPC_URL and the network's Tatum key"
            )

        async def operation() -> Any:
            try:
                body = await self._post(self._payload(signature))
            except Exception as exc:  # noqa: BLE001 - redact before the boundary logs it
                raise SolanaTransactionError(
                    _redact(self._api_key, f"{type(exc).__name__}: {exc}")
                ) from None
            if not isinstance(body, dict):
                raise SolanaTransactionError("malformed JSON-RPC response")
            if body.get("error") is not None:
                raise SolanaTransactionError(
                    _redact(
                        self._api_key,
                        "JSON-RPC error: " + json.dumps(body.get("error"))[:200],
                    )
                )
            return body.get("result")

        outcome = await self._boundary.call(
            operation,
            failure_fallback(DEPENDENCY, "solana_get_transaction_failed"),
            idempotent=True,
        )
        if not outcome.ok:
            raise SolanaTransactionError(
                _redact(self._api_key, outcome.error or "no response")
            )

        result = outcome.value
        if result is None:
            return SolanaTransaction(
                signature=signature,
                slot=None,
                succeeded=False,
                error=None,
                token_deltas=(),
                error_kind="transaction_not_found",
            )
        return parse_transaction(signature, result)
