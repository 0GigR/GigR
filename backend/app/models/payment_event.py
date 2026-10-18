import uuid
from sqlalchemy import Column, String, Numeric, DateTime, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID, JSONB
from ..core.database import Base


class PaymentEvent(Base):
    """Append-only ledger of every money-moving PayPal call and webhook.

    One row per step of an escrow's life (order created → captured → payout /
    refund). It is the audit trail, the idempotency record for webhooks
    (``paypal_event_id`` is unique), and the data behind the payments ledger.
    """

    __tablename__ = "payment_events"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id = Column(UUID(as_uuid=True), ForeignKey("jobs.id"), nullable=True, index=True)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    # order_created | captured | payout_sent | refunded | webhook | failed
    kind = Column(String(32), nullable=False)
    # The PayPal object id this row is about (order / capture / payout batch / refund).
    paypal_id = Column(String(64), nullable=True)
    # Webhook event id; unique so a retried delivery is processed once.
    paypal_event_id = Column(String(64), unique=True, nullable=True)
    amount = Column(Numeric(12, 2), nullable=True)
    currency = Column(String(8), nullable=True)
    status = Column(String(40), nullable=True)
    detail = Column(String(500), nullable=True)
    raw = Column(JSONB, nullable=True)
    # clock_timestamp() (not now()): now() is frozen at transaction start, so a
    # split's refund + payout written in one transaction would share a timestamp
    # and the ledger could not order them.
    created_at = Column(DateTime(timezone=True), server_default=func.clock_timestamp(), index=True)
