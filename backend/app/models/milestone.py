import uuid
from sqlalchemy import Column, String, Text, Numeric, Integer, DateTime, func, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from ..core.database import Base


class JobMilestone(Base):
    """JobMilestone — represents an incremental milestone or staged escrow for a job.

    Enables local handyman/contract jobs to support staged payments (e.g. deposit,
    materials phase, rough-in, final release) and scope amendments without requiring
    re-deployment of the Solana smart contract program.

    Each milestone derives its own Solana escrow PDA using its 64-bit contract_milestone_id.
    """
    __tablename__ = "job_milestones"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    job_id = Column(UUID(as_uuid=True), ForeignKey("jobs.id"), nullable=False, index=True)
    milestone_index = Column(Integer, nullable=False, default=1)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    amount = Column(Numeric(10, 2), nullable=False)
    status = Column(String(50), nullable=False, default="pending")  # pending, funded, released, disputed
    contract_milestone_id = Column(String(50), unique=True, nullable=False)  # 64-bit hex for PDA derivation
    escrow_address = Column(String(255), nullable=True)  # Solana escrow PDA address
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    funded_at = Column(DateTime(timezone=True), nullable=True)
    released_at = Column(DateTime(timezone=True), nullable=True)

    job = relationship("Job", back_populates="milestones")
