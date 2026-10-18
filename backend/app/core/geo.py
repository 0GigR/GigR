"""
geo.py - Geographic data helpers and GeoAlchemy2 element normalizers.

Ensures geometry columns (POINT, srid=4326) are always assigned a valid
WKTElement/WKBElement object rather than a raw string, preventing
"TypeError: Only WKBElement and WKTElement objects are supported"
when Pydantic or model property accessors call geoalchemy2.shape.to_shape.
"""

from __future__ import annotations

import re
from typing import Any, Optional, Tuple

from geoalchemy2.elements import WKBElement, WKTElement
from geoalchemy2.shape import to_shape


def to_wkt_point(latitude: Optional[float], longitude: Optional[float]) -> Optional[WKTElement]:
    """Create a WKTElement for a POINT(longitude latitude) with SRID 4326."""
    if latitude is None or longitude is None:
        return None
    try:
        lat_f = float(latitude)
        lon_f = float(longitude)
        return WKTElement(f"POINT({lon_f} {lat_f})", srid=4326)
    except (ValueError, TypeError):
        return None


def to_wkt_element(location_value: Any) -> Optional[Any]:
    """Convert an arbitrary location value (str, WKTElement, WKBElement, or dict)
    into a proper GeoAlchemy2 element with SRID 4326.
    """
    if location_value is None:
        return None

    if isinstance(location_value, (WKTElement, WKBElement)):
        return location_value

    if isinstance(location_value, str):
        cleaned = location_value.strip()
        if not cleaned:
            return None
        # Strip off any leading 'SRID=4326;'
        if cleaned.upper().startswith("SRID="):
            parts = cleaned.split(";", 1)
            wkt_text = parts[1] if len(parts) > 1 else cleaned
        else:
            wkt_text = cleaned
        return WKTElement(wkt_text, srid=4326)

    if isinstance(location_value, dict):
        lat = location_value.get("latitude") or location_value.get("lat")
        lon = location_value.get("longitude") or location_value.get("lng") or location_value.get("lon")
        return to_wkt_point(lat, lon)

    return None


def extract_coordinates(location_value: Any) -> Tuple[Optional[float], Optional[float]]:
    """Safely extract (latitude, longitude) from any geometry element or string.
    Returns (None, None) if missing or unparseable. Never raises.
    """
    if location_value is None:
        return None, None

    # 1. Try GeoAlchemy2 / Shapely to_shape if it is already a geometry element
    if isinstance(location_value, (WKTElement, WKBElement)):
        try:
            point = to_shape(location_value)
            return float(point.y), float(point.x)
        except Exception:
            pass

    # 2. String representation parsing: handles "SRID=4326;POINT(lon lat)" or "POINT(lon lat)"
    raw_str = str(location_value)
    match = re.search(r"POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)", raw_str, re.IGNORECASE)
    if match:
        try:
            lon = float(match.group(1))
            lat = float(match.group(2))
            return lat, lon
        except (ValueError, IndexError):
            pass

    # 3. Fallback attempt via WKTElement wrapping
    try:
        wkt_elem = to_wkt_element(location_value)
        if wkt_elem is not None:
            point = to_shape(wkt_elem)
            return float(point.y), float(point.x)
    except Exception:
        pass

    return None, None
