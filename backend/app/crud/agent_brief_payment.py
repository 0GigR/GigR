"""Persistence for the x402 signature ledger. One entity, one file.

The claim is a single ``INSERT ... ON CONFLICT DO NOTHING``. Postgres decides who
won, so two requests that verify the same payment at the same moment cannot both
be told the signature was fresh -- the database's unique index is the lock. The
return value is the answer: True means this caller now owns the payment and may
return the content it bought.
"""

from uuid import UUID

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.agent_brief_payment import AgentBriefPayment


async def claim_signature(
    db: AsyncSession,
    *,
    signature: str,
    job_id: UUID,
    mint: str,
    amount_atomic: int,
) -> bool:
    """Record one payment as spent. Returns False when it was already spent.

    The insert and the commit happen here, before the caller can return any paid
    content. A process that dies after this commit leaves the signature spent,
    which is the safe direction: a payment that bought nothing is refused rather
    than silently reusable.
    """
    statement = (
        insert(AgentBriefPayment)
        .values(
            signature=signature,
            job_id=job_id,
            mint=mint,
            amount_atomic=amount_atomic,
        )
        .on_conflict_do_nothing(index_elements=["signature"])
        .returning(AgentBriefPayment.signature)
    )
    result = await db.execute(statement)
    await db.commit()
    # RETURNING is empty when the conflict clause swallowed the row, so the
    # answer does not depend on a driver's rowcount bookkeeping.
    return result.scalar_one_or_none() is not None
