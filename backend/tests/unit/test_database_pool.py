"""The engine's pool must detect a stale connection instead of using it.

The Walrus Memory backfill opens one session per user, but a pooled connection
can still be closed by the pooler between two reads. Pre-ping and recycling turn
that into a fresh connection instead of a ConnectionDoesNotExistError in the
middle of a query, which is what stopped an earlier run part-way.
"""

from app.core.database import engine


def test_the_pool_checks_a_connection_before_using_it():
    # The pool instance is the thing the requirement is about, and SQLAlchemy
    # keeps these two settings on it; there is no public reader for them.
    assert engine.pool._pre_ping is True
    assert engine.pool._recycle == 1800
