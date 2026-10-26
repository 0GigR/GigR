"""The one definition of a user's Walrus Memory namespace, and the flag gating it.

Two services need the same two answers: the agent memory, which mirrors saved
keys, and the fact writer, which stores history sentences. Both must name a
user's namespace identically or a recall would look in one place while the facts
were written in another, and both must read the same flag.

Keeping the pair here is what lets either service depend on this module instead
of importing the other, which the house standard forbids.
"""

from uuid import UUID

from .config import settings

FLAG_NAME = "FEATURE_AGENT_WALRUS_MEMORY"


def memory_namespace(user_id: UUID) -> str:
    """The Walrus namespace for one user, prefixed from MEMWAL_NAMESPACE_PREFIX.

    The prefix is configuration, declared in core/config.py and read from
    settings here; it is not a feature flag and no module in this codebase reads
    the environment for it directly. The format is fixed: existing namespaces
    already written under it must keep resolving.
    """
    return f"{settings.MEMWAL_NAMESPACE_PREFIX}-{user_id}"
