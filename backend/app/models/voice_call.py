"""
VoiceCall model — one row per outbound AI phone call.

The AI agent decides *what to say* to a specific user, saves that content here
keyed by a random unguessable ``token``, then asks Twilio to call the user with
its TwiML webhook pointed at ``/api/v1/voice/twiml/{token}``. When Twilio "rings"
that URL, the backend looks the row up by token and returns the personalised
``<Say>`` message. This is what makes the spoken content dynamic *per call*.
"""

import uuid
from sqlalchemy import Column, String, Text, DateTime, func, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from ..core.database import Base


class VoiceCall(Base):
    __tablename__ = "voice_calls"
    __table_args__ = {"extend_existing": True}

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)

    # Who is being called.
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)

    # Random URL-safe token embedded in the public TwiML webhook URL. This is the
    # only thing Twilio sends back to identify the call, so it must be unguessable.
    token = Column(String(64), nullable=False, unique=True, index=True)

    # E.164 destination number the call was placed to (snapshot at call time).
    to_number = Column(String(20), nullable=False)

    # The text spoken to the user (rendered into <Say> TwiML).
    message = Column(Text, nullable=False)

    # What caused this call: item_found | negotiation_done | job_posted |
    # task_failed | manual | test
    trigger = Column(String(50), nullable=False, default="manual")

    # Optional link back to the agent task that triggered the call.
    task_id = Column(UUID(as_uuid=True), ForeignKey("agent_tasks.id", ondelete="SET NULL"), nullable=True, index=True)

    # Lifecycle status. Starts "created"; updated from Twilio's status callback:
    # queued → initiated → ringing → in-progress → completed | busy | no-answer | failed | canceled
    status = Column(String(20), nullable=False, default="created", index=True)

    # Twilio Call SID (CAxxxx…) once the call is placed.
    call_sid = Column(String(64), nullable=True, index=True)

    # Populated if placing the call fails.
    error = Column(Text, nullable=True)

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    user = relationship("User", foreign_keys=[user_id])
