from uuid import UUID
from datetime import datetime, timezone
from typing import List
from sqlalchemy import select, func, or_
from sqlalchemy.ext.asyncio import AsyncSession
from geoalchemy2 import functions as geo_func
from ..models.service import ServiceListing
from ..schemas.service import ServiceCreate, ServiceUpdate

# Vouched providers are treated as this many km closer in nearby rankings.
SERVICE_VOUCH_DISTANCE_BOOST_KM = 3.0

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
    """Nearby services, ranked for the marketplace browse list.

    Distance is the primary signal (as before), but a provider with at least
    one verifiable vouch gets a distance boost — treated as if they were
    ``SERVICE_VOUCH_DISTANCE_BOOST_KM`` closer — so verified pros surface
    above unvouched ones at similar range. Listings tie-break by recency.
    """
    from ..models.vouch import Vouch

    # Distance in meters using PostGIS
    point = f"SRID=4326;POINT({longitude} {latitude})"
    distance_col = geo_func.ST_Distance(
        ServiceListing.location,
        func.ST_GeogFromText(point)
    ).label("distance")

    vouch_counts = (
        select(Vouch.vouchee_id, func.count(Vouch.id).label("cnt"))
        .group_by(Vouch.vouchee_id)
        .subquery()
    )

    conditions = [
        # radius_km <= 0 means "no limit": the map shows everything with a
        # coordinate and draws the radius as an indicator instead of a filter.
        ServiceListing.is_active.isnot(False),
    ]
    if radius_km and radius_km > 0:
        conditions.append(
            geo_func.ST_DWithin(
                ServiceListing.location,
                func.ST_GeogFromText(point),
                radius_km * 1000,
            )
        )

    query = select(ServiceListing, distance_col, vouch_counts.c.cnt).where(
        *conditions,
    )
    query = query.outerjoin(vouch_counts, vouch_counts.c.vouchee_id == ServiceListing.provider_id)

    if category_id:
        query = query.where(ServiceListing.category_id == category_id)

    rows = (await db.execute(query)).all()
    ranked = []
    for svc, dist_m, vouch_count in rows:
        dist_km = (dist_m or 0) / 1000
        # Expose the true distance (not the vouch-boosted ranking value) so the
        # UI can show "1.2 km away" honestly.
        svc.distance_km = round(dist_km, 2)
        effective_km = dist_km + (SERVICE_VOUCH_DISTANCE_BOOST_KM if (vouch_count or 0) == 0 else 0)
        created = svc.created_at.replace(tzinfo=timezone.utc) if svc.created_at and svc.created_at.tzinfo is None else svc.created_at
        ranked.append((effective_km, created, svc))
    ranked.sort(key=lambda t: (t[0], -(t[1].timestamp() if t[1] else 0)))
    return [svc for _, _, svc in ranked][offset:offset + limit]

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
    from ..core.text_search import compact, tokenize_query, relevance_score

    tokens = tokenize_query(query)
    if tokens:
        # Separator-stripped copies of the searchable text, so a query that spans
        # a space ("woodworks" vs "Wood Works, Furniture") still matches.
        compact_title = func.regexp_replace(
            func.lower(ServiceListing.title), r"[^a-z0-9]", "", "g"
        )
        compact_description = func.regexp_replace(
            func.lower(func.coalesce(ServiceListing.description, "")), r"[^a-z0-9]", "", "g"
        )
        conditions = []
        for t in tokens:
            conditions.append(ServiceListing.title.ilike(f"%{t}%"))
            conditions.append(ServiceListing.description.ilike(f"%{t}%"))
            collapsed = compact(t)
            if collapsed:
                conditions.append(compact_title.like(f"%{collapsed}%"))
                conditions.append(compact_description.like(f"%{collapsed}%"))
    else:
        # Nothing meaningful to tokenize — fall back to raw phrase match
        conditions = [
            ServiceListing.title.ilike(f"%{query}%"),
            ServiceListing.description.ilike(f"%{query}%"),
        ]

    # Pull a wider candidate set, then rank + trim in Python
    result = await db.execute(
        select(ServiceListing)
        .where(or_(*conditions), ServiceListing.is_active.isnot(False))
        .limit(max(limit * 3, 30))
    )
    services = list(result.scalars().all())

    if tokens:
        services.sort(key=lambda s: relevance_score(tokens, s.title, s.description), reverse=True)

    return services[offset:offset + limit]