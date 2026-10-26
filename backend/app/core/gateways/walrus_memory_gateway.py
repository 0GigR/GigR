"""Walrus Memory gateway: the only place the memwal SDK is touched.

The SDK is imported lazily so the application boots, and every unrelated test
runs, on a machine where ``memwal`` is not installed. The private key is held
for signing only: it is never logged, never included in an error message and
never rendered by ``repr``.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from ..errors import DependencyUnavailableError
from ..resilience import Boundary, Outcome, failure_fallback, outcome_fallback

logger = logging.getLogger(__name__)

DEPENDENCY = "walrus-memory"


@dataclass(frozen=True)
class RecalledMemory:
    """One stored memory and the metadata the relayer returned with it.

    ``text`` is what the memory was stored as, which is what the caller matches
    against its own keys. ``score`` is the relayer's relevance score and
    ``created_at`` its ISO-8601 timestamp; both are optional because the relayer
    leaves them out for entries whose embedding or timestamp it does not know.
    A reader that needs a date formats it and treats an unparseable value as no
    date at all, never as a guess.
    """

    text: str
    score: float | None
    created_at: str | None


class WalrusMemoryGateway:
    """Async wrapper around the Walrus Memory relayer.

    Every call crosses a :class:`Boundary`, which supplies the timeout, the
    circuit breaker, the bulkhead and bounded retries. Reads are retried because
    they are idempotent; writes are not, because the relayer is append-only and
    an accepted write that timed out may already be stored. Writes carry a
    deterministic idempotency key instead.
    """

    def __init__(
        self,
        boundary: Boundary,
        private_key: str,
        account_id: str,
        server_url: str,
        client: Any | None = None,
    ) -> None:
        self._boundary = boundary
        self._private_key = private_key
        self._account_id = account_id
        self._server_url = server_url
        self._client = client

    @property
    def configured(self) -> bool:
        """True when both credentials the relayer needs are present."""
        return bool(self._private_key and self._account_id)

    def __repr__(self) -> str:
        return (
            f"WalrusMemoryGateway(account_id={self._account_id!r}, "
            f"server_url={self._server_url!r}, configured={self.configured})"
        )

    def _sdk_client(self) -> Any:
        """Build the SDK client on first use, from the injected credentials."""
        if not self.configured:
            raise DependencyUnavailableError(
                DEPENDENCY,
                "MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID must both be set "
                "(operation=build_client)",
            )
        if self._client is None:
            from memwal import MemWal

            self._client = MemWal.create(
                key=self._private_key,
                account_id=self._account_id,
                server_url=self._server_url,
            )
        return self._client

    async def _read(
        self,
        operation_name: str,
        operation: Any,
        fallback: Any,
    ) -> Any:
        outcome = await self._boundary.call(operation, fallback, idempotent=True)
        return self._resolve(operation_name, outcome)

    async def _write(self, operation_name: str, operation: Any) -> Any:
        fallback = failure_fallback(DEPENDENCY, f"{operation_name}_failed")
        outcome = await self._boundary.call(operation, fallback, idempotent=False)
        return self._resolve(operation_name, outcome)

    def _resolve(self, operation_name: str, outcome: Outcome[Any]) -> Any:
        if outcome.ok and outcome.value is not None:
            return outcome.value
        raise DependencyUnavailableError(
            DEPENDENCY,
            f"{DEPENDENCY}: {operation_name} failed against {self._server_url} "
            f"(account_id={self._account_id}): {outcome.error or 'no value returned'}",
        )

    async def remember(
        self, text: str, namespace: str, idempotency_key: str | None = None
    ) -> str:
        """Queue one memory for storage and return the relayer's job id.

        The relayer accepts the write and persists it in the background; this
        returns as soon as the job is accepted, which is what a request path can
        afford. ``idempotency_key`` makes a retried call collapse onto the same
        job instead of storing the text twice.
        """

        async def operation() -> str:
            result = await self._sdk_client().remember(
                text, namespace, idempotency_key=idempotency_key
            )
            return result.job_id

        return await self._write("remember", operation)

    async def recall(
        self, query: str, namespace: str, limit: int
    ) -> tuple[RecalledMemory, ...]:
        """Return the stored memories most similar to ``query`` in ``namespace``.

        Each entry keeps its text, relevance score and creation timestamp, so a
        caller can tell two contradicting memories apart by age. The relayer
        returns them best match first and that order is preserved.
        """
        if not query or not query.strip():
            raise ValueError("recall requires a non-empty query (operation=recall)")

        async def operation() -> tuple[RecalledMemory, ...]:
            result = await self._sdk_client().recall(
                query, limit=limit, namespace=namespace
            )
            return tuple(
                RecalledMemory(
                    text=memory.text,
                    score=memory.score,
                    created_at=memory.created_at,
                )
                for memory in result.results
            )

        return await self._read(
            "recall", operation, outcome_fallback(DEPENDENCY, (), "recall_degraded")
        )

    async def list_namespaces(self) -> tuple[str, ...]:
        """Return the namespaces this account holds memories in."""

        async def operation() -> tuple[str, ...]:
            result = await self._sdk_client().list_namespaces()
            return tuple(summary.name for summary in result.namespaces)

        return await self._read(
            "list_namespaces",
            operation,
            outcome_fallback(DEPENDENCY, (), "list_namespaces_degraded"),
        )
