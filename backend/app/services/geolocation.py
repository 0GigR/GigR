"""Pure-Python distance helpers.

This module is deliberately dependency-free and free of side effects. It used to
construct a module-level sync ``Nominatim`` geolocator that was never called;
geocoding and routing now live in :mod:`app.services.osm_geo`, which is async,
throttled and cached.

The distance maths here delegates to :func:`osm_geo.haversine_km` so there is a
single implementation rather than one per caller.
"""

from __future__ import annotations

import math
from typing import Tuple

from .osm_geo import haversine_km


def calculate_distance_km(
    lat1: float, lon1: float, lat2: float, lon2: float
) -> float:
    """Great-circle distance between two points in kilometres (WGS-84)."""
    return haversine_km(lat1, lon1, lat2, lon2)


def is_within_radius(
    center_lat: float,
    center_lon: float,
    point_lat: float,
    point_lon: float,
    radius_km: float,
) -> bool:
    """True when ``point`` lies within ``radius_km`` of ``center``."""
    return (
        calculate_distance_km(center_lat, center_lon, point_lat, point_lon)
        <= radius_km
    )


def bounding_box(
    lat: float, lon: float, radius_km: float
) -> Tuple[float, float, float, float]:
    """Approximate bounding box around a point.

    Returns ``(min_lat, min_lon, max_lat, max_lon)``. Useful for cheap
    pre-filtering before hitting PostGIS, and for fitting a map viewport.
    """
    lat_delta = radius_km / 111.32  # 1 degree of latitude ≈ 111.32 km
    # Guard the poles, where cos(lat) → 0 and the longitude delta explodes.
    cos_lat = max(math.cos(math.radians(lat)), 1e-6)
    lon_delta = radius_km / (111.32 * cos_lat)
    return (lat - lat_delta, lon - lon_delta, lat + lat_delta, lon + lon_delta)
