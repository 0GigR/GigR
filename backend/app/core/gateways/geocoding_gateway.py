"""Reverse-geocoding gateway: a point from the database to a place name.

The Nominatim client already exists in :mod:`app.services.osm_geo`. It owns the
three things Nominatim's usage policy requires -- a descriptive ``User-Agent``,
at most one request per second, and a cache so one point is never fetched twice
-- and it is shared by the map endpoints. This gateway does not reimplement any
of them: the composition root injects that client's ``reverse_geocode`` here, so
the whole process keeps one Nominatim budget, one cache and one place where the
request is actually made.

What this gateway adds is the house outbound boundary -- a timeout, a circuit
breaker, a bulkhead and bounded retries -- and an explicit typed answer. A
lookup that times out, fails, or finds no place returns None after logging why,
and the caller writes no location fact. Nothing here raises: a geocoder that is
down must never fail the backfill that asked it.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any, Optional

from ..resilience import Boundary, outcome_fallback

logger = logging.getLogger(__name__)

DEPENDENCY = "nominatim"


class GeocodingGateway:
    """Reverse geocoding behind the standard boundary.

    ``reverse_geocode`` is the existing Nominatim client's coroutine, injected
    from the composition root. It returns the client's normalised place mapping
    (or None); the gateway turns that into the one string a fact sentence can
    carry.
    """

    def __init__(
        self,
        boundary: Boundary,
        reverse_geocode: Callable[[float, float], Awaitable[Optional[dict[str, Any]]]],
    ) -> None:
        self._boundary = boundary
        self._reverse_geocode = reverse_geocode

    async def place_name(self, latitude: float, longitude: float) -> Optional[str]:
        """Return the short place name for one point, or None.

        The name is the human label the map already shows ("Lekki, Lagos"),
        which is what a sentence can carry. A point with no place, a lookup
        failure and a timeout all answer None; the failure is logged with the
        dependency and the point so it stays traceable, and it never reaches the
        caller as an exception.
        """

        async def operation() -> Optional[str]:
            place = await self._reverse_geocode(latitude, longitude)
            if not isinstance(place, dict):
                return None
            name = place.get("label") or place.get("name")
            if isinstance(name, str) and name.strip():
                return name.strip()
            return None

        outcome = await self._boundary.call(
            operation,
            outcome_fallback(DEPENDENCY, None, "reverse_geocode_degraded"),
            idempotent=True,
        )
        if outcome.ok:
            return outcome.value
        logger.warning(
            "[geocoding] reverse geocode failed for lat=%s lon=%s "
            "(operation=place_name): %s",
            latitude,
            longitude,
            outcome.error or "no value returned",
        )
        return None
