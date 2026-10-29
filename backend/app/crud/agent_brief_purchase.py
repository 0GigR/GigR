"""Persistence for one purchase attempt of the paid agent brief. One entity.

The claim is a single ``INSERT ... ON CONFLICT (user_id, job_id) DO UPDATE ...
WHERE state = 'declined' RETURNING id``. Postgres decides who won:

* a pair with no row is inserted, so the caller owns the attempt;
* a pair already ``submitting``, ``submitted``, ``paid``, ``refused`` or
  ``unconfirmed`` does not satisfy the WHERE clause, so the update is skipped and
  RETURNING is empty -- the caller lost and must not send anything;
* a pair whose last attempt was ``declined`` (the node refused it, or the
  transaction failed on chain, so nothing was paid) is taken over and retried.

That is the same discipline the signature ledger uses one layer up: one
conflict-aware statement, committed before the caller can submit a transfer, and
the database's unique index is the lock rather than a read-then-write in Python.
"""

from uuid import UUID, uuid4

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.agent_brief_purchase import (
    PURCHASE_SUBMITTING,
    RETRYABLE_PURCHASE_STATES,
    AgentBriefPurchase,
)


async def claim_purchase_attempt(
    db: AsyncSession,
    *,
    user_id: UUID,
    job_id: UUID,
) -> UUID | None:
    """Claim the one purchase slot for ``(user_id, job_id)``.

    Returns the row's id when this caller may send a transfer, or None when an
    earlier attempt that may already have paid owns the slot. The commit happens
    here, before the caller can build or send anything.
    """
    statement = (
        insert(AgentBriefPurchase)
        .values(
            id=uuid4(),
            user_id=user_id,
            job_id=job_id,
            state=PURCHASE_SUBMITTING,
        )
        .on_conflict_do_update(
            index_elements=["user_id", "job_id"],
            set_={
                "state": PURCHASE_SUBMITTING,
                "signature": None,
                "reason": None,
                "updated_at": func.now(),
            },
            where=AgentBriefPurchase.state.in_(RETRYABLE_PURCHASE_STATES),
        )
        .returning(AgentBriefPurchase.id)
    )
    result = await db.execute(statement)
    await db.commit()
    # RETURNING is empty when the conflict clause did nothing, so the answer does
    # not depend on a driver's rowcount bookkeeping.
    return result.scalar_one_or_none()


async def get_purchase_attempt(
    db: AsyncSession,
    *,
    user_id: UUID,
    job_id: UUID,
) -> AgentBriefPurchase | None:
    """The attempt for this pair, or None when nobody has tried to buy it."""
    statement = select(AgentBriefPurchase).where(
        AgentBriefPurchase.user_id == user_id,
        AgentBriefPurchase.job_id == job_id,
    )
    result = await db.execute(statement)
    return result.scalar_one_or_none()


async def record_purchase_outcome(
    db: AsyncSession,
    *,
    purchase_id: UUID,
    state: str,
    signature: str | None = None,
    reason: str | None = None,
) -> None:
    """Move one attempt to ``state``, committing before the caller answers.

    ``signature`` is only written when one is given: a state that adds evidence
    must never overwrite the signature an earlier state already recorded.
    """
    values: dict = {"state": state, "reason": reason, "updated_at": func.now()}
    if signature is not None:
        values["signature"] = signature
    statement = (
        update(AgentBriefPurchase)
        .where(AgentBriefPurchase.id == purchase_id)
        .values(**values)
    )
    await db.execute(statement)
    await db.commit()
