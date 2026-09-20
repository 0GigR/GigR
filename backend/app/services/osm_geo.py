"""Free OpenStreetMap geo services — geocoding, reverse geocoding and routing.

Everything here talks to free OSM-ecosystem endpoints. No API keys, no billing:

  * Nominatim  — forward + reverse geocoding
  * OSRM       — routing, distance and ETA

Both are donated community services, so this module is deliberately polite:

  * a descriptive ``User-Agent`` (Nominatim's usage policy requires it),
  * at most one Nominatim call per second, enforced with a module-level lock,
  * short timeouts, and
  * an in-process TTL cache, so repeat lookups never leave the box at all.

Every helper degrades gracefully: a geo lookup failing logs a warning and
returns ``None``/``[]`` rather than raising, because a broken geocoder must
never take down a request that would otherwise have succeeded.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import Any, Dict, List, Optional

import httpx

from ..core.config import settings

logger = logging.getLogger(__name__)

OSM_ATTRIBUTION = "© OpenStreetMap contributors"

# Nominatim asks for a maximum of one request per second from a single client.
_NOMINATIM_MIN_INTERVAL_SECONDS = 1.0


class _TTLCache:
    """Tiny in-process TTL cache.

    Deliberately not Redis: geocoding results are tiny, the hit-rate is high
    (the same neighbourhoods get looked up constantly), and a single worker
    process is the common deployment. Keys are dropped oldest-first when full.
    """

    def __init__(self, maxsize: int = 1024) -> None:
        self._data: Dict[Any, tuple[float, Any]] = {}
        self._maxsize = maxsize

    def get(self, key: Any) -> Any:
        hit = self._data.get(key)
        if hit is None:
            return None
        expires_at, value = hit
        if expires_at < time.monotonic():
            self._data.pop(key, None)
            return None
        return value

    def set(self, key: Any, value: Any, ttl_seconds: float) -> None:
        if len(self._data) >= self._maxsize:
            # Evict the oldest ~10% rather than the single oldest entry, so we
            # don't pay the eviction cost on every subsequent insert.
            for stale_key in list(self._data)[: max(1, self._maxsize // 10)]:
                self._data.pop(stale_key, None)
        self._data[key] = (time.monotonic() + ttl_seconds, value)

    def clear(self) -> None:
        self._data.clear()


_geocode_cache = _TTLCache(maxsize=2048)
_route_cache = _TTLCache(maxsize=512)

_nominatim_lock = asyncio.Lock()
_last_nominatim_call: float = 0.0


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        timeout=settings.GEO_HTTP_TIMEOUT_SECONDS,
        headers={
            "User-Agent": settings.GEO_USER_AGENT,
            "Accept": "application/json",
            "Accept-Language": "en",
        },
    )


async def _nominatim_get(path: str, params: Dict[str, Any]) -> Any:
    """GET against Nominatim, throttled to one call per second across the process."""
    global _last_nominatim_call
    base = settings.NOMINATIM_BASE_URL.rstrip("/")
    async with _nominatim_lock:
        elapsed = time.monotonic() - _last_nominatim_call
        if elapsed < _NOMINATIM_MIN_INTERVAL_SECONDS:
            await asyncio.sleep(_NOMINATIM_MIN_INTERVAL_SECONDS - elapsed)
        _last_nominatim_call = time.monotonic()
        async with _client() as client:
            resp = await client.get(f"{base}{path}", params=params)
            resp.raise_for_status()
            return resp.json()


def _as_float(value: Any) -> Optional[float]:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _short_label(address: Dict[str, Any], display_name: Optional[str]) -> Optional[str]:
    """A human label for map popups: "Lekki, Lagos" rather than a full address."""
    parts = [
        address.get("neighbourhood")
        or address.get("suburb")
        or address.get("quarter")
        or address.get("village")
        or address.get("hamlet"),
        address.get("city")
        or address.get("town")
        or address.get("municipality")
        or address.get("state_district")
        or address.get("state"),
    ]
    label = ", ".join(p for p in parts if p)
    if label:
        return label
    if display_name:
        bits = [b.strip() for b in display_name.split(",") if b.strip()]
        if bits:
            return ", ".join(bits[:2])
    return None


def _normalise_place(raw: Any) -> Optional[Dict[str, Any]]:
    """Convert a Nominatim record into the stable shape the API exposes."""
    if not isinstance(raw, dict):
        return None
    latitude = _as_float(raw.get("lat"))
    longitude = _as_float(raw.get("lon"))
    if latitude is None or longitude is None:
        return None
    address = raw.get("address") or {}
    display_name = raw.get("display_name")
    return {
        "latitude": latitude,
        "longitude": longitude,
        "display_name": display_name,
        "label": _short_label(address, display_name),
        "name": raw.get("name")
        or address.get("suburb")
        or address.get("neighbourhood")
        or (display_name or "").split(",")[0].strip()
        or None,
        "type": raw.get("type") or raw.get("category"),
        "importance": _as_float(raw.get("importance")),
        "address": address,
        "bounding_box": raw.get("boundingbox"),
    }


async def geocode(
    query: str,
    *,
    limit: int = 5,
    bias_latitude: Optional[float] = None,
    bias_longitude: Optional[float] = None,
    country_codes: Optional[str] = None,
) -> List[Dict[str, Any]]:
    """Forward geocode a free-text address/place into coordinates.

    ``bias_*`` softly prefers results around a point (the user's current
    location) without excluding good matches elsewhere — ``bounded=0``.
    """
    text = (query or "").strip()
    if len(text) < 2:
        return []

    cache_key = (
        "geocode",
        text.lower(),
        limit,
        round(bias_latitude, 3) if bias_latitude is not None else None,
        round(bias_longitude, 3) if bias_longitude is not None else None,
        country_codes or "",
    )
    cached = _geocode_cache.get(cache_key)
    if cached is not None:
        return cached

    params: Dict[str, Any] = {
        "q": text,
        "format": "jsonv2",
        "addressdetails": 1,
        "limit": max(1, min(limit, 10)),
    }
    if country_codes:
        params["countrycodes"] = country_codes
    if bias_latitude is not None and bias_longitude is not None:
        delta = 0.5  # ~55 km box; enough to disambiguate without locking results
        params["viewbox"] = (
            f"{bias_longitude - delta},{bias_latitude + delta},"
            f"{bias_longitude + delta},{bias_latitude - delta}"
        )
        params["bounded"] = 0

    try:
        data = await _nominatim_get("/search", params)
    except Exception as exc:  # network, timeout, rate limit, bad JSON
        logger.warning("[geo] Nominatim geocode failed for %r: %s", text, exc)
        return []

    results = [place for place in (_normalise_place(r) for r in (data or [])) if place]
    _geocode_cache.set(cache_key, results, settings.GEO_GEOCODE_CACHE_TTL_SECONDS)
    return results


async def reverse_geocode(
    latitude: float,
    longitude: float,
    *,
    zoom: int = 16,
) -> Optional[Dict[str, Any]]:
    """Turn coordinates into a human-readable place (neighbourhood label)."""
    cache_key = ("reverse", round(latitude, 4), round(longitude, 4), zoom)
    cached = _geocode_cache.get(cache_key)
    if cached is not None:
        return cached or None

    try:
        data = await _nominatim_get(
            "/reverse",
            {
                "lat": latitude,
                "lon": longitude,
                "format": "jsonv2",
                "addressdetails": 1,
                "zoom": zoom,
            },
        )
    except Exception as exc:
        logger.warning("[geo] Nominatim reverse failed for %s,%s: %s", latitude, longitude, exc)
        return None

    place = _normalise_place(data) if data else None
    # Cache misses too (as a falsy sentinel) so a bad point isn't re-queried
    # on every render.
    _geocode_cache.set(cache_key, place, settings.GEO_GEOCODE_CACHE_TTL_SECONDS)
    return place


async def route(
    start_latitude: float,
    start_longitude: float,
    end_latitude: float,
    end_longitude: float,
    *,
    profile: str = "driving",
) -> Optional[Dict[str, Any]]:
    """Road distance + ETA between two points via OSRM (free, OSM-based)."""
    cache_key = (
        "route",
        profile,
        round(start_latitude, 4),
        round(start_longitude, 4),
        round(end_latitude, 4),
        round(end_longitude, 4),
    )
    cached = _route_cache.get(cache_key)
    if cached is not None:
        return cached

    base = settings.OSRM_BASE_URL.rstrip("/")
    coords = (
        f"{start_longitude},{start_latitude};{end_longitude},{end_latitude}"
    )
    url = f"{base}/route/v1/{profile}/{coords}"

    try:
        async with _client() as client:
            resp = await client.get(
                url,
                params={"overview": "full", "geometries": "geojson", "steps": "false"},
            )
            resp.raise_for_status()
            data = resp.json()
    except Exception as exc:
        logger.warning("[geo] OSRM route failed: %s", exc)
        return None

    routes = (data or {}).get("routes") or []
    if not routes:
        return None

    best = routes[0]
    distance_m = _as_float(best.get("distance"))
    duration_s = _as_float(best.get("duration"))
    geometry = (best.get("geometry") or {}).get("coordinates")

    result: Dict[str, Any] = {
        "profile": profile,
        "distance_m": distance_m,
        "distance_km": round(distance_m / 1000, 2) if distance_m is not None else None,
        "duration_s": duration_s,
        "duration_min": round(duration_s / 60, 1) if duration_s is not None else None,
        # [lon, lat] pairs per GeoJSON — the client can hand this straight to Leaflet.
        "geometry": geometry,
        "attribution": OSM_ATTRIBUTION,
    }
    _route_cache.set(cache_key, result, settings.GEO_ROUTE_CACHE_TTL_SECONDS)
    return result


def haversine_km(
    lat1: float, lon1: float, lat2: float, lon2: float
) -> float:
    """Great-circle distance in km — a cheap fallback when routing is unavailable."""
    radius = 6371.0088
    d_lat = math.radians(lat2 - lat1)
    d_lon = math.radians(lon2 - lon1)
    a = (
        math.sin(d_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(d_lon / 2) ** 2
    )
    return radius * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


def map_config() -> Dict[str, Any]:
    """Tile/style config for the client, so tile URLs aren't hardcoded everywhere."""
    return {
        "tile_light_url": settings.TILE_LIGHT_URL,
        "attribution": OSM_ATTRIBUTION,
        # Dark mode is done client-side with a CSS filter over the standard OSM
        # raster tiles: free, keyless, and it keeps a single tile source.
        "dark_mode_strategy": "css-filter",
        "geocoder": "nominatim",
        "routing": "osrm",
    }
