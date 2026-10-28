"""The one mapping from an outbound memory failure to a stable reason code.

The read-only review, the namespace wipe and the per-fact reconcile all face the
same relayer and the same two states a reader can act on: the account's minute
budget is spent, or the deadline expired. Each answers a client that maps the
code to a sentence, so the codes must not drift between them.

A third module owns the rule because two services may not import each other.
"""

from __future__ import annotations


def dependency_failure_reason(error: BaseException) -> str:
    """Return the stable reason code for one failed memory call.

    The gateway raises one typed error for every outbound failure and carries
    the boundary's own outcome in its message: ``rate_limited: ...`` when the
    relayer said the budget is spent, ``timeout after ...`` when the deadline
    expired, and an exception name otherwise. Splitting busy from timeout is
    what lets the page ask the reader to wait a minute rather than retry into a
    limit that is still open.

    An unrecognised message is ``relayer_unavailable``: the safe answer when the
    cause is not one of the two the client can act on.
    """
    detail = str(error).casefold()
    if "rate_limited" in detail or "429" in detail:
        return "relayer_busy"
    if "timeout" in detail or "timed out" in detail or "504" in detail:
        return "relayer_timeout"
    return "relayer_unavailable"
