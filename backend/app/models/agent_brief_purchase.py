"""One purchase of the paid agent brief: the row that makes a double tap safe.

A purchase is identified by the pair ``(user, job)``, not by a signature: the
signature does not exist until the transfer has been built and sent, and the
whole point of this row is to decide who may send one. The unique index on that
pair is the lock. A second tap while the first is in flight loses the insert and
is told what the first one is doing instead of paying again.

The state records what is known, not what was hoped for:

``submitting``
    This request claimed the pair and is sending. A row left in this state by a
    crashed process blocks a new send on purpose: the transfer may be on chain
    and paying twice is worse than a job that needs support.
``submitted``
    A signature was returned by the node, so the transfer was accepted for
    broadcast. It may or may not be confirmed yet. A later tap re-checks this
    same signature and never sends a second transfer.
``paid``
    The settlement was verified and the signature was claimed in the existing
    ``agent_brief_payments`` ledger. The brief may be re-served, free, because
    this pair already paid for it.
``declined``
    The node refused the transaction before broadcast, or the transaction was
    confirmed as failed on chain. Nothing was paid, so a retry is allowed.
``refused``
    A confirmed transfer that did not pay for the brief (wrong mint, underpaid,
    already spent). Money moved, so there is no retry.
``unconfirmed``
    The send raised without a signature. The transfer may have been broadcast,
    so this row blocks any further send for the pair.

Deliberately no foreign key to ``jobs``: a purchase record must outlive the job
it bought, exactly as the signature ledger does.
"""

from uuid import uuid4

from sqlalchemy import Column, DateTime, String, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import UUID

from ..core.database import Base

PURCHASE_SUBMITTING = "submitting"
PURCHASE_SUBMITTED = "submitted"
PURCHASE_PAID = "paid"
PURCHASE_DECLINED = "declined"
PURCHASE_REFUSED = "refused"
PURCHASE_UNCONFIRMED = "unconfirmed"

# The only state a new attempt may take over. Every other state means a transfer
# was sent, or a payment was made, and taking it over could pay twice.
RETRYABLE_PURCHASE_STATES = (PURCHASE_DECLINED,)


class AgentBriefPurchase(Base):
    __tablename__ = "agent_brief_purchases"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "job_id",
            name="uq_agent_brief_purchase_user_job",
        ),
    )

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid4)
    # The paying Gigr user. Not a foreign key, for the same reason as job_id.
    user_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    job_id = Column(UUID(as_uuid=True), nullable=False, index=True)
    state = Column(String(16), nullable=False)
    # The settlement signature, known from the moment the node accepts the send.
    signature = Column(String(128), nullable=True)
    # Why the last attempt ended where it did; the same reason the API named.
    reason = Column(String(64), nullable=True)
    created_at = Column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    updated_at = Column(
        DateTime(timezone=True),
        server_default=func.now(),
        onupdate=func.now(),
        nullable=False,
    )

    def __repr__(self) -> str:
        return (
            f"AgentBriefPurchase(user_id={self.user_id!r}, "
            f"job_id={self.job_id!r}, state={self.state!r})"
        )
