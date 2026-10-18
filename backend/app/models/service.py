import uuid
from sqlalchemy import Column, String, Text, Numeric, Boolean, DateTime, func, ForeignKey
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import relationship
from geoalchemy2 import Geography
from ..core.database import Base
from geoalchemy2.shape import to_shape

class ServiceListing(Base):
    __tablename__ = "service_listings"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    provider_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    category_id = Column(UUID(as_uuid=True), ForeignKey("categories.id"), nullable=False)
    title = Column(String(255), nullable=False)
    description = Column(Text, nullable=True)
    price = Column(Numeric(10, 2), nullable=True, default=0)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())
    location = Column(Geography(geometry_type="POINT", srid=4326), nullable=False)
    radius_km = Column(Numeric(10, 2), default=5.0)

    provider = relationship("User", back_populates="service_listings")
    category = relationship("Category")
    jobs = relationship("Job", back_populates="service_listing")

    min_price = Column(Numeric(10, 2), nullable=True)
    max_price = Column(Numeric(10, 2), nullable=True)

    image_url = Column(String(500), nullable=True)

    # ───── location helpers ─────
    @property
    def latitude(self) -> float | None:
        if self.location is None:
            return None
        from ..core.geo import extract_coordinates
        lat, _ = extract_coordinates(self.location)
        return lat

    @property
    def longitude(self) -> float | None:
        if self.location is None:
            return None
        from ..core.geo import extract_coordinates
        _, lon = extract_coordinates(self.location)
        return lon