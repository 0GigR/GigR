import uuid
from sqlalchemy import Column, String, Text, Numeric, DateTime, Boolean, func, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from geoalchemy2 import Geography
from ..core.database import Base
from .scope_amendment import ScopeAmendment
from geoalchemy2.shape import to_shape

class Job(Base):
    __tablename__ = "jobs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    client_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    provider_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=True)
    service_listing_id = Column(UUID(as_uuid=True), ForeignKey("service_listings.id"), nullable=True)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=False)
    status = Column(String(50), nullable=False, default="open")
    # open, assigned, funded, in_progress, completed, cancelled, disputed
    price = Column(Numeric(10, 2), nullable=False)
    location = Column(Geography(geometry_type="POINT", srid=4326), nullable=True)
    escrow_address = Column(String(255), nullable=True)  # PDA of escrow account
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    client = relationship("User", back_populates="client_jobs", foreign_keys=[client_id])
    provider = relationship("User", back_populates="provider_jobs", foreign_keys=[provider_id])
    service_listing = relationship("ServiceListing", back_populates="jobs")
    applications = relationship("Application", back_populates="job")
    vouches = relationship("Vouch", back_populates="job")
    messages = relationship("Message", back_populates="job")
    disputes = relationship("Dispute", back_populates="job")
    scope_amendments = relationship("ScopeAmendment", back_populates="job")

        # In addition to existing fields:
    contract_job_id = Column(String(50), unique=True, nullable=True)
    # We'll store the hex of the lower 64 bits of the UUID when the job is created

    min_price = Column(Numeric(10, 2), nullable=True)
    max_price = Column(Numeric(10, 2), nullable=True)

    image_url = Column(String(500), nullable=True)

    # Auto-release: set when the provider submits completed work. The background
    # scanner releases the escrow to the provider once auto_release_at passes,
    # unless the client releases or disputes first.
    work_submitted_at = Column(DateTime(timezone=True), nullable=True)
    auto_release_at = Column(DateTime(timezone=True), nullable=True)

    @property
    def latitude(self) -> float | None:
        if self.location is None:
            return None
        return to_shape(self.location).y

    @property
    def longitude(self) -> float | None:
        if self.location is None:
            return None
        return to_shape(self.location).x