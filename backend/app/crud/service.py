from uuid import UUID
from typing import List
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from geoalchemy2 import functions as geo_func
from ..models.service import ServiceListing
from ..schemas.service import ServiceCreate, ServiceUpdate

async def get_service_by_id(db: AsyncSession, service_id: UUID) -> ServiceListing | None:
    result = await db.execute(select(ServiceListing).where(ServiceListing.id == service_id))
    return result.scalar_one_or_none()

async def get_services_by_provider(db: AsyncSession, provider_id: UUID, limit: int = 20, offset: int = 0) -> List[ServiceListing]:
    result = await db.execute(
        select(ServiceListing)
        .where(ServiceListing.provider_id == provider_id)
        .limit(limit)
        .offset(offset)
    )
    return result.scalars().all()

async def get_services_nearby(
    db: AsyncSession,
    latitude: float,
    longitude: float,
    radius_km: float = 5.0,
    category_id: UUID | None = None,
    limit: int = 20,
    offset: int = 0
) -> List[ServiceListing]:
    # Distance calculation in meters using PostGIS
    point = f"SRID=4326;POINT({longitude} {latitude})"
    # distance_col = geo_func.ST_DistanceSphere(ServiceListing.location, point).label("distance")
    distance_col = geo_func.ST_Distance(
        ServiceListing.location,
        func.ST_GeogFromText(point)
    ).label("distance")

    query = select(ServiceListing, distance_col).where(
        # geo_func.ST_DWithin(
        #     ServiceListing.location, point, radius_km * 1000  # convert km to meters
        # )
        geo_func.ST_DWithin(
            ServiceListing.location,
            func.ST_GeogFromText(point),
            radius_km * 1000
        )
    )

    if category_id:
        query = query.where(ServiceListing.category_id == category_id)

    query = query.order_by(distance_col).limit(limit).offset(offset)
    result = await db.execute(query)
    return [row[0] for row in result.all()]

async def create_service(db: AsyncSession, provider_id: UUID, service_in: ServiceCreate) -> ServiceListing:
    service = ServiceListing(
        provider_id=provider_id,
        category_id=service_in.category_id,
        title=service_in.title,
        description=service_in.description,
        price=service_in.price,
        location=f"SRID=4326;POINT({service_in.longitude} {service_in.latitude})",
        radius_km=service_in.radius_km or 5.0,
        image_url=service_in.image_url,
    )
    db.add(service)
    # await db.commit()
    await db.flush()
    # await db.refresh(service)
    return service

async def update_service(db: AsyncSession, service: ServiceListing, service_in: ServiceUpdate) -> ServiceListing:
    for field, value in service_in.model_dump(exclude_unset=True).items():
        if field == "latitude":
            continue  # handled together with longitude
        elif field == "longitude":
            if service_in.latitude is not None and service_in.longitude is not None:
                service.location = f"SRID=4326;POINT({service_in.longitude} {service_in.latitude})"
        else:
            setattr(service, field, value)
    await db.flush()
    # await db.refresh(service)
    return service

async def toggle_service_active(db: AsyncSession, service: ServiceListing, is_active: bool) -> ServiceListing:
    service.is_active = is_active
    await db.flush()
    # await db.refresh(service)
    return service

async def delete_service(db: AsyncSession, service: ServiceListing) -> None:
    # Check if there are active jobs on this service listing
    # That check will be done in the endpoint; here we just delete.
    await db.delete(service)
    await db.flush()

async def search_services_by_text(
    db: AsyncSession,
    query: str,
    limit: int = 20,
    offset: int = 0
) -> List[ServiceListing]:
    """Word-tokenized search: match services containing ANY significant query
    word in title or description, then rank by how many words match.

    Fixes the naive full-phrase bug where 'samsung repair guy' failed to match
    a service titled 'Samsung phone repairs'.
    """
    from ..core.text_search import tokenize_query, relevance_score

    tokens = tokenize_query(query)
    if tokens:
        conditions = []
        for t in tokens:
            conditions.append(ServiceListing.title.ilike(f"%{t}%"))
            conditions.append(ServiceListing.description.ilike(f"%{t}%"))
    else:
        # Nothing meaningful to tokenize — fall back to raw phrase match
        conditions = [
            ServiceListing.title.ilike(f"%{query}%"),
            ServiceListing.description.ilike(f"%{query}%"),
        ]

    # Pull a wider candidate set, then rank + trim in Python
    result = await db.execute(
        select(ServiceListing).where(or_(*conditions)).limit(max(limit * 3, 30))
    )
    services = list(result.scalars().all())

    if tokens:
        services.sort(key=lambda s: relevance_score(tokens, s.title, s.description), reverse=True)

    return services[offset:offset + limit]