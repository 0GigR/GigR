"""The ledger of x402 signatures this endpoint has already been paid with.

A signature is a bearer proof of one payment. Once it has bought a brief it must
never buy another, in this process or the next one, for any job. The primary key
is the signature itself, so the database -- not a dictionary in memory -- is what
makes that true across restarts and across workers. Making the key anything
wider than the signature alone would let one payment buy one brief per job.

Deliberately no foreign key to ``jobs``: the record must outlive a job. If a
deleted job could cascade the row away, the same payment would be spendable
again, which is the whole failure this table exists to prevent.
"""

from sqlalchemy import BigInteger, Column, DateTime, String, func
from sqlalchemy.dialects.postgresql import UUID
from ..core.database import Base


class AgentBriefPayment(Base):
    __tablename__ = "agent_brief_payments"

    # The settlement transaction signature: one payment, one row.
    signature = Column(String(128), primary_key=True)
    # The job the brief was bought for. Not a foreign key on purpose (see above).
    job_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    mint = Column(String(64), nullable=False)
    amount_atomic = Column(BigInteger, nullable=False)
    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )

    def __repr__(self) -> str:
        return (
            f"AgentBriefPayment(signature={self.signature!r}, "
            f"job_id={self.job_id!r})"
        )
