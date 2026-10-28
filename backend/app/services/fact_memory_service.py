"""Write fact sentences into a user's Walrus Memory namespace.

Two callers need the same three rules, which is why this module owns them
instead of each of them re-deriving them:

* the namespace is the one the agent memory already writes to,
  ``f"{settings.MEMWAL_NAMESPACE_PREFIX}-{user_id}"``, taken from
  :func:`core.memory_namespace.memory_namespace` so the format cannot drift;
* a fact's stable key comes from :func:`build_fact_identity`, so the same
  sentence always maps to the same key and a second pass can tell which facts
  are already stored;
* the idempotency key handed to the relayer is derived from the user and that
  key, so a retry after a timeout collapses onto the write the relayer already
  accepted instead of storing the sentence twice. The relayer keeps the write it
  accepted first and discards the duplicate;
* a failed write is never retried blind. The relayer has no per-fact delete, so
  a 5xx does not prove the write was lost: the outcome is unknown until the
  fact's own text is recalled from the user's namespace. Present means the write succeeded;
  provably absent means the one retry is safe; an unanswerable recall means no
  retry at all, because a duplicate cannot be taken back.

Nothing here decides whether writing is allowed: :attr:`FactMemoryService.enabled`
answers that from FEATURE_AGENT_WALRUS_MEMORY and the injected gateway, and a
caller that ignores it would raise a dependency error rather than silently write.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Iterable, Optional
from uuid import UUID

from ..core.agent_features import agent_feature_enabled
from ..core.memory_namespace import FLAG_NAME, memory_namespace
from .user_fact_service import build_fact_identity

if TYPE_CHECKING:  # pragma: no cover - typing only, never imported at runtime
    from ..core.gateways.walrus_memory_gateway import WalrusMemoryGateway

logger = logging.getLogger(__name__)

# Separates the two parts of the payload before it is hashed. A character that
# cannot appear in a sentence keeps a user id and a fact key from ever running
# together into the same input.
_UNIT_SEPARATOR = "\x1f"

# How many recalled entries the verification reads after a failed write. The
# query is the fact's own text, so the exact entry ranks first; the margin covers
# a namespace that already holds many similar facts.
VERIFY_RECALL_LIMIT = 50

# Returned by write() when the fact was already stored: the relayer kept the
# write it accepted, so there is no new job id to name.
ALREADY_STORED = "already-stored"


@dataclass(frozen=True)
class FactWrite:
    """One fact sentence and the two keys that identify it.

    ``key`` is the local, stable identity used to tell whether the fact was
    already written. ``idempotency_key`` is what the relayer deduplicates on.
    """

    text: str
    key: str
    idempotency_key: str


class FactMemoryService:
    """Place fact sentences in one user's memory namespace.

    ``gateway`` is injected from the composition root and may be None when the
    relayer is not configured; the service is then disabled and every write
    raises only if a caller ignores :attr:`enabled`.
    """

    def __init__(self, gateway: Optional["WalrusMemoryGateway"] = None) -> None:
        self._gateway = gateway

    @property
    def enabled(self) -> bool:
        """True when the flag is on and a usable gateway was injected."""
        return bool(
            agent_feature_enabled(FLAG_NAME)
            and self._gateway is not None
            and self._gateway.configured
        )

    def namespace(self, user_id: UUID) -> str:
        """The Walrus namespace of one user, in the format the memory uses."""
        return memory_namespace(user_id)

    def plan(self, user_id: UUID, facts: Iterable[str]) -> list[FactWrite]:
        """Turn sentences into writes, one per distinct fact key, in order.

        A sentence that appears twice (a listing named twice, a category
        budget repeated after a merge) is written once: two writes with the same
        idempotency key would collapse at the relayer anyway, and spending two
        requests on them would be a waste of the account's minute budget.
        """
        writes: list[FactWrite] = []
        seen: set[str] = set()
        for fact_text in facts:
            text, key = build_fact_identity(fact_text)
            if key in seen:
                continue
            seen.add(key)
            writes.append(
                FactWrite(
                    text=text,
                    key=key,
                    idempotency_key=_idempotency_key(
                        user_id, key, self.namespace(user_id)
                    ),
                )
            )
        return writes

    async def write(self, user_id: UUID, write: FactWrite) -> str:
        """Store one fact and return the relayer's job id.

        A write that fails is not retried blind. There is no per-fact delete, so
        a server error means the outcome is unknown: the fact may have been
        stored before the error was returned. The fact's own text is recalled
        from the user's namespace first.

        * already there: the write is treated as succeeded and
          ``ALREADY_STORED`` is returned, so the caller records it and no second
          write is made;
        * provably absent: the same write is attempted once more, with the same
          namespace-scoped idempotency key, so the relayer still collapses it;
        * not verifiable: the original error is raised and nothing is written
          again, because writing on an unknown outcome is how a duplicate is
          made.

        Raises DependencyUnavailableError when the relayer cannot be reached;
        the caller decides whether that leaves a user incomplete (the backfill
        does) or is logged and dropped (the agent loop does).
        """
        if self._gateway is None:
            raise RuntimeError(
                "FactMemoryService has no gateway (operation=write_fact)"
            )
        namespace = self.namespace(user_id)
        try:
            return await self._remember(write, namespace)
        except Exception as exc:  # noqa: BLE001 - an outbound dependency may fail any way
            stored = await self._already_stored(user_id, write.text)
            if stored is True:
                logger.warning(
                    "[fact-memory] write for user_id=%s failed (%s: %s) but the "
                    "fact is already stored; recording it instead of writing "
                    "again (operation=write_fact)",
                    user_id,
                    type(exc).__name__,
                    exc,
                )
                return ALREADY_STORED
            if stored is None:
                logger.warning(
                    "[fact-memory] write for user_id=%s failed (%s: %s) and the "
                    "relayer could not say whether the fact landed; not writing "
                    "again (operation=write_fact)",
                    user_id,
                    type(exc).__name__,
                    exc,
                )
                raise
            return await self._remember(write, namespace)

    async def _remember(self, write: FactWrite, namespace: str) -> str:
        """Make one relayer write for this fact, with its one idempotency key.

        Both attempts go through here so the first try and the verified retry
        cannot drift onto different keys.
        """
        return await self._gateway.remember(
            write.text, namespace, idempotency_key=write.idempotency_key
        )

    async def _already_stored(self, user_id: UUID, text: str) -> Optional[bool]:
        """Whether the exact fact text is in the user's namespace: T/F/None.

        None means the relayer could not be asked. That is not evidence of
        absence, so the caller must not write again on it.
        """
        try:
            memories = await self._gateway.recall(
                text, self.namespace(user_id), VERIFY_RECALL_LIMIT
            )
            return any(memory.text == text for memory in memories)
        except Exception as exc:  # noqa: BLE001 - an outbound dependency may fail any way
            logger.warning(
                "[fact-memory] could not verify whether a fact landed for "
                "user_id=%s (operation=verify_fact): %s: %s",
                user_id,
                type(exc).__name__,
                exc,
            )
            return None


def _idempotency_key(user_id: Any, fact_key: str, namespace: str = "") -> str:
    """The relayer idempotency key for one fact about one user.

    Deterministic, so the same fact for the same user is the same key in a
    retried run, in a resumed run and in an event write that repeats the
    backfill's sentence.

    The namespace is part of the payload. The relayer answers 500, not a clean
    conflict, when one idempotency key is presented again under a different
    namespace, so a key that ignored the namespace would break every write made
    after the namespace prefix changed.
    """
    payload = f"{namespace}{_UNIT_SEPARATOR}{user_id}{_UNIT_SEPARATOR}{fact_key}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
