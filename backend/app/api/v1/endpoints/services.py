from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from ....core.dependencies import get_db, get_current_user
from ....crud.service import (
    get_service_by_id,
    get_services_by_provider,
    get_services_nearby,
    create_service,
    update_service,
    delete_service,
    search_services_by_text,
)
from ....schemas.service import ServiceCreate, ServiceUpdate, ServiceOut
from ....models.user import User
import uuid

router = APIRouter()


# @router.post("/", response_model=ServiceOut, status_code=status.HTTP_201_CREATED)
# async def create_service_route(
#     service_in: ServiceCreate,
#     current_user: User = Depends(get_current_user),
#     db: AsyncSession = Depends(get_db),
# ):
#     service = await create_service(db, current_user.id, service_in)
#     return service

@router.post("/", response_model=ServiceOut, status_code=status.HTTP_201_CREATED)
async def create_service_route(
    service_in: ServiceCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    service = await create_service(db, current_user.id, service_in)
    await db.commit()
    await db.refresh(service)
    return service

@router.get("/provider/{provider_id}", response_model=list[ServiceOut])
async def get_provider_services(provider_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    return await get_services_by_provider(db, provider_id)

@router.get("/{service_id}", response_model=ServiceOut)
async def get_service_route(
    service_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    service = await get_service_by_id(db, service_id)
    if not service:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Service not found")
    return service


@router.get("/", response_model=list[ServiceOut])
async def list_my_services(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    return await get_services_by_provider(db, current_user.id)


@router.get("/search/nearby", response_model=list[ServiceOut])
async def search_nearby_services(
    lat: float = Query(..., description="Latitude"),
    lon: float = Query(..., description="Longitude"),
    radius: float = Query(5.0, description="Radius in km"),
    category_id: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    return await get_services_nearby(db, lat, lon, radius, category_id=uuid.UUID(category_id) if category_id else None, limit=limit, offset=offset)


@router.get("/search/text", response_model=list[ServiceOut])
async def search_services_text(
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
):
    return await search_services_by_text(db, q, limit=limit, offset=offset)


@router.patch("/{service_id}", response_model=ServiceOut)
async def update_service_route(
    service_id: uuid.UUID,
    service_in: ServiceUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    service = await get_service_by_id(db, service_id)
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    if service.provider_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not your service")
    # Apply updates (CRUD function does flush only)
    service = await update_service(db, service, service_in)
    await db.commit()
    await db.refresh(service)
    return service


@router.delete("/{service_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_service_route(
    service_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    service = await get_service_by_id(db, service_id)
    if not service:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Service not found")
    if service.provider_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not your service")
    await delete_service(db, service)       # CRUD function does flush
    await db.commit()
    return None