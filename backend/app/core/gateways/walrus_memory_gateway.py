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


# The query the forget verification sends. A namespace whose rows were deleted
# answers with nothing; one that still holds rows usually answers with them. The
# text names the subjects the fact writer stores, because a recall ranks by
# similarity and a question about a single topic can miss a namespace that only
# holds the others.
FORGET_VERIFY_QUERY = (
    "this user's preferences, jobs, services, providers, prices, locations, "
    "payments and past activity"
)

# How many rows the verification asks for. Two are enough to tell "something
# remains" from "nothing came back", and they keep the probe inside a single
# cheap recall.
FORGET_VERIFY_LIMIT = 2


@dataclass(frozen=True)
class ForgottenNamespace:
    """The outcome of deleting one namespace's index rows.

    ``deleted`` is the row count the relayer reported, or None when the relayer
    never got to report one (the call failed and the verification is what proved
    the rows gone). ``verified`` says the answer came from a verification read
    rather than from the relayer's own count, so a caller can log the difference.
    """

    namespace: str
    deleted: int | None
    verified: bool = False


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
    they are idempotent; writes are not, because an accepted write that timed out
    may already be stored and there is no per-fact delete to take a duplicate
    back. Writes carry a deterministic idempotency key instead.

    ``forget`` deletes one namespace's index rows (memwal 0.2.2 and later). It is
    a write, so it is never retried blind either: a failure is followed by a
    verification read, and only a namespace that provably still holds rows is
    deleted again. Deleting twice would be harmless, but claiming a deletion
    that did not happen would not be.
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
        *,
        timeout_seconds: float | None = None,
        retry: bool = True,
    ) -> Any:
        outcome = await self._boundary.call(
            operation,
            fallback,
            idempotent=retry,
            timeout_seconds=timeout_seconds,
        )
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
        self,
        query: str,
        namespace: str,
        limit: int,
        *,
        timeout_seconds: float | None = None,
        retry: bool = True,
    ) -> tuple[RecalledMemory, ...]:
        """Return the stored memories most similar to ``query`` in ``namespace``.

        Each entry keeps its text, relevance score and creation timestamp, so a
        caller can tell two contradicting memories apart by age. The relayer
        returns them best match first and that order is preserved.

        ``timeout_seconds`` gives one large read more room than the dependency's
        policy allows; the breaker is still the same one (see ``Boundary.call``).
        ``retry`` is false for a call that already waits a long time, so a
        failure cannot double the wall clock the caller pays.
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
            "recall",
            operation,
            outcome_fallback(DEPENDENCY, (), "recall_degraded"),
            timeout_seconds=timeout_seconds,
            retry=retry,
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

    async def forget(self, namespace: str) -> ForgottenNamespace:
        """Delete every index row in ``namespace`` and report what happened.

        This is the namespace-level delete memwal 0.2.2 added
        (``MemWal.forget``, MystenLabs/walrus-memory#1061): one user's whole
        memory, never a single fact. The relayer still has no per-fact delete,
        so anything that needs one fact removed must rewrite the namespace.

        It is a write, so it is never retried blind. A failure means the outcome
        is unknown: the rows may have been deleted before the error was
        returned. The namespace is verified before anything is repeated.

        * provably empty: the delete is treated as applied and
          ``verified=True`` is returned, with no row count because the relayer
          never got to report one;
        * provably still holding rows: the same delete is made once more (it is
          idempotent, and the verification proved the first one did not land);
        * not verifiable: the original error is raised and nothing is deleted
          again, because claiming a deletion nobody confirmed is worse than
          reporting the failure.

        Raises DependencyUnavailableError when the relayer cannot be reached.
        The callers that face a user wrap it: see
        ``AgentMemoryService.forget_namespace``.
        """
        if not namespace or not namespace.strip():
            raise ValueError("forget requires a non-empty namespace (operation=forget)")

        async def operation() -> ForgottenNamespace:
            result = await self._sdk_client().forget(namespace=namespace)
            return ForgottenNamespace(
                namespace=result.namespace,
                deleted=int(result.deleted),
                verified=False,
            )

        try:
            return await self._write("forget", operation)
        except Exception as exc:  # noqa: BLE001 - an outbound dependency may fail any way
            empty = await self._namespace_provably_empty(namespace)
            if empty is True:
                logger.warning(
                    "[walrus-memory] forget for namespace=%s reported %s: %s but the "
                    "namespace holds no rows; treating the delete as applied and not "
                    "repeating it (operation=forget)",
                    namespace,
                    type(exc).__name__,
                    exc,
                )
                return ForgottenNamespace(
                    namespace=namespace, deleted=None, verified=True
                )
            if empty is None:
                logger.warning(
                    "[walrus-memory] forget for namespace=%s failed (%s: %s) and the "
                    "relayer could not say whether the rows are gone; not deleting "
                    "again (operation=forget)",
                    namespace,
                    type(exc).__name__,
                    exc,
                )
                raise
            logger.warning(
                "[walrus-memory] forget for namespace=%s failed (%s: %s) and the rows "
                "are still there; deleting once more (operation=forget)",
                namespace,
                type(exc).__name__,
                exc,
            )
            return await self._write("forget", operation)

    async def _namespace_provably_empty(self, namespace: str) -> bool | None:
        """Whether the namespace holds nothing: True, False, or None if unknown.

        None is not evidence of absence, so the caller must not delete again on
        it. Two reads are used because one is not conclusive on its own: a recall
        is similarity-ranked, so it can miss a row that the namespace listing
        still counts. The count has the final say.
        """
        try:
            memories = await self.recall(
                FORGET_VERIFY_QUERY, namespace, FORGET_VERIFY_LIMIT
            )
        except Exception as exc:  # noqa: BLE001 - an outbound dependency may fail any way
            logger.warning(
                "[walrus-memory] could not recall namespace=%s to verify a delete "
                "(operation=forget_verify): %s: %s",
                namespace,
                type(exc).__name__,
                exc,
            )
            return None
        if memories:
            return False
        count = await self._reported_row_count(namespace)
        if count is None:
            return None
        return count == 0

    async def _reported_row_count(self, namespace: str) -> int | None:
        """The relayer's own row count for ``namespace``, or None if unavailable."""

        async def operation() -> int:
            result = await self._sdk_client().list_namespaces()
            for summary in result.namespaces:
                if summary.name == namespace:
                    return int(getattr(summary, "memory_count", 0) or 0)
            return 0

        try:
            return await self._read(
                "forget_verify",
                operation,
                outcome_fallback(DEPENDENCY, 0, "forget_verify_degraded"),
            )
        except Exception as exc:  # noqa: BLE001 - an outbound dependency may fail any way
            logger.warning(
                "[walrus-memory] could not count namespace=%s to verify a delete "
                "(operation=forget_verify): %s: %s",
                namespace,
                type(exc).__name__,
                exc,
            )
            return None
