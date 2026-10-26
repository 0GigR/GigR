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
  accepted first and discards the duplicate.

Nothing here decides whether writing is allowed: :attr:`FactMemoryService.enabled`
answers that from FEATURE_AGENT_WALRUS_MEMORY and the injected gateway, and a
caller that ignores it would raise a dependency error rather than silently write.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Iterable, Optional
from uuid import UUID

from ..core.agent_features import agent_feature_enabled
from ..core.memory_namespace import FLAG_NAME, memory_namespace
from .user_fact_service import build_fact_identity

if TYPE_CHECKING:  # pragma: no cover - typing only, never imported at runtime
    from ..core.gateways.walrus_memory_gateway import WalrusMemoryGateway

# Separates the two parts of the payload before it is hashed. A character that
# cannot appear in a sentence keeps a user id and a fact key from ever running
# together into the same input.
_UNIT_SEPARATOR = "\x1f"


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
                    idempotency_key=_idempotency_key(user_id, key),
                )
            )
        return writes

    async def write(self, user_id: UUID, write: FactWrite) -> str:
        """Store one fact and return the relayer's job id.

        Raises DependencyUnavailableError when the relayer cannot be reached;
        the caller decides whether that aborts a run (the backfill does) or is
        logged and dropped (the agent loop does).
        """
        if self._gateway is None:
            raise RuntimeError(
                "FactMemoryService has no gateway (operation=write_fact)"
            )
        return await self._gateway.remember(
            write.text, self.namespace(user_id), idempotency_key=write.idempotency_key
        )


def _idempotency_key(user_id: Any, fact_key: str) -> str:
    """The relayer idempotency key for one fact about one user.

    Deterministic, so the same fact for the same user is the same key in a
    retried run, in a resumed run and in an event write that repeats the
    backfill's sentence.
    """
    payload = f"{user_id}{_UNIT_SEPARATOR}{fact_key}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
