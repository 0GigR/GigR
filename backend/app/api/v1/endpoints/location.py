"""Location / geo endpoints backed by the free OpenStreetMap stack.

Every lookup goes through :mod:`app.services.osm_geo`, which applies the
required ``User-Agent``, throttles Nominatim to one call per second and caches
results in-process. These endpoints are authenticated so that anonymous traffic
can't consume the community services' rate limits on Gigr's behalf.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status

from ....core.dependencies import get_current_user
from ....models.user import User
from ....services import osm_geo

router = APIRouter()

_ALLOWED_PROFILES = ("driving", "walking", "cycling")


@router.get("/map-config")
async def map_config() -> Dict[str, Any]:
    """Tile template, attribution and strategy for the client.

    Served from the backend so tile URLs live in one place instead of being
    hardcoded into every map component.
    """
    return osm_geo.map_config()


@router.get("/geocode")
async def geocode(
    q: str = Query(..., min_length=2, max_length=200, description="Address, area or landmark"),
    limit: int = Query(5, ge=1, le=10),
    lat: Optional[float] = Query(None, ge=-90, le=90, description="Bias results toward this latitude"),
    lon: Optional[float] = Query(None, ge=-180, le=180, description="Bias results toward this longitude"),
    country: Optional[str] = Query(None, max_length=20, description="Comma-separated ISO codes, e.g. 'ng'"),
    _: User = Depends(get_current_user),
) -> List[Dict[str, Any]]:
    """Forward geocode free text into coordinates (address/area search)."""
    return await osm_geo.geocode(
        q,
        limit=limit,
        bias_latitude=lat,
        bias_longitude=lon,
        country_codes=country,
    )


@router.get("/reverse")
async def reverse(
    lat: float = Query(..., ge=-90, le=90),
    lon: float = Query(..., ge=-180, le=180),
    _: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Turn coordinates into a neighbourhood label for map popups and cards."""
    place = await osm_geo.reverse_geocode(lat, lon)
    if not place:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No address found for these coordinates",
        )
    return place


@router.get("/route")
async def route(
    from_lat: float = Query(..., ge=-90, le=90),
    from_lon: float = Query(..., ge=-180, le=180),
    to_lat: float = Query(..., ge=-90, le=90),
    to_lon: float = Query(..., ge=-180, le=180),
    profile: str = Query("driving"),
    _: User = Depends(get_current_user),
) -> Dict[str, Any]:
    """Road distance and ETA between two points (OSRM).

    Falls back to a straight-line estimate when routing is unavailable, so the
    UI always has something honest to show — flagged as ``approximate``.
    """
    if profile not in _ALLOWED_PROFILES:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"profile must be one of {', '.join(_ALLOWED_PROFILES)}",
        )

    result = await osm_geo.route(from_lat, from_lon, to_lat, to_lon, profile=profile)
    if result:
        return result

    straight_km = osm_geo.haversine_km(from_lat, from_lon, to_lat, to_lon)
    return {
        "profile": profile,
        "distance_m": round(straight_km * 1000),
        "distance_km": round(straight_km, 2),
        "duration_s": None,
        "duration_min": None,
        "geometry": None,
        "attribution": osm_geo.OSM_ATTRIBUTION,
        # Routing unavailable — this is as-the-crow-flies, not road distance.
        "approximate": True,
    }
