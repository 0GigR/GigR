import uuid
from sqlalchemy import Column, String, DateTime, Boolean, Float, Text, func
from sqlalchemy.dialects.postgresql import UUID, JSONB, ARRAY
from sqlalchemy.orm import relationship
from geoalchemy2 import Geography
from cryptography.fernet import Fernet
from ..core.database import Base
from ..core.config import settings
from .service import ServiceListing


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False)
    hashed_password = Column(String(255), nullable=True)               # null for OAuth users
    google_id = Column(String(255), unique=True, nullable=True)
    display_name = Column(String(100), nullable=False)
    phone_number = Column(String(20), nullable=True)
    profile_image_url = Column(String(500), nullable=True)
    is_verified = Column(Boolean, default=False)
    role = Column(String(20), default="user", nullable=False)  # "user", "admin", "superadmin"
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Solana wallet – public key is base58, private key is Fernet‑encrypted
    wallet_public_key = Column(String(44), unique=True, nullable=True)
    _wallet_private_key = Column("wallet_private_key", String(255), nullable=True)

    # Geography
    last_location = Column(Geography(geometry_type="POINT", srid=4326), nullable=True)
    last_seen_at = Column(DateTime(timezone=True), nullable=True)
    # Plain float copies of last_location for easy API exposure (set alongside the PostGIS column)
    location_lat = Column(Float, nullable=True)
    location_lng = Column(Float, nullable=True)
    # Privacy gate: user must opt-in before their location is visible on their public profile
    location_public = Column(Boolean, default=False, server_default="false", nullable=False)

    # Relationships
    service_listings = relationship("ServiceListing", back_populates="provider")
    client_jobs = relationship("Job", back_populates="client", foreign_keys="[Job.client_id]")
    provider_jobs = relationship("Job", back_populates="provider", foreign_keys="[Job.provider_id]")
    applications = relationship("Application", back_populates="applicant")
    vouches_given = relationship("Vouch", back_populates="voucher", foreign_keys="[Vouch.voucher_id]")
    vouches_received = relationship("Vouch", back_populates="vouchee", foreign_keys="[Vouch.vouchee_id]")
    messages = relationship("Message", back_populates="sender")
    disputes_as_client = relationship("Dispute", back_populates="client", foreign_keys="[Dispute.client_id]")
    disputes_as_provider = relationship("Dispute", back_populates="provider", foreign_keys="[Dispute.provider_id]")

    civic_gateway_token = Column(String(255), nullable=True)
    is_identity_verified = Column(Boolean, default=False)

    # AI Settings (e.g. auto_reply_enabled, negotiate_enabled)
    ai_settings = Column(JSONB, nullable=True, default={})

    # AI feature gate — set to False to disable the agent for this user (future pro tier)
    ai_enabled = Column(Boolean, nullable=False, default=True, server_default="true")

    # Public profile fields
    bio = Column(Text, nullable=True)
    skills = Column(ARRAY(String), nullable=True, default=[])

    @property
    def wallet_private_key(self) -> bytes | None:
        """Decrypt and return the private key bytes."""
        if not self._wallet_private_key:
            return None
        f = Fernet(settings.WALLET_ENCRYPTION_KEY.encode())  # key must be bytes
        return f.decrypt(self._wallet_private_key.encode())