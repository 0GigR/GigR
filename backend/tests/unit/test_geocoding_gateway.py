"""The reverse-geocoding gateway over a faked Nominatim.

Neither the database nor the network is real: ``osm_geo._client`` is replaced
with a fake HTTP client that records every request, so the assertions are on the
requests that would have left the process and on the one answer a fact sentence
can use.

The cache and the one-request-per-second throttle belong to the reused
``osm_geo`` client, which the composition root injects here. These tests guard
that the gateway really goes through it: if the reuse is replaced by a direct
call, by an uncached client, or by one that ignores the throttle, the tests
below go red.
"""

from __future__ import annotations

import types

import app.services.osm_geo as osm_geo
from app.core.gateways.geocoding_gateway import GeocodingGateway
from app.core.resilience import Boundary, ResiliencePolicy, StructuredLogMetricSink

PLACE = {
    "lat": "6.5095",
    "lon": "3.3711",
    "display_name": "Lekki, Lagos, Nigeria",
    "address": {"suburb": "Lekki", "city": "Lagos"},
}


class FakeResponse:
    """One Nominatim answer."""

    def __init__(self, payload=None) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self):
        return self._payload


class FakeHttpClient:
    """Stands in for httpx.AsyncClient: records every GET, answers in order."""

    def __init__(self, responses) -> None:
        self._responses = list(responses)
        self.requests: list[dict] = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc_info):
        return False

    async def get(self, url, params=None):
        self.requests.append({"url": url, "params": dict(params or {})})
        if not self._responses:
            raise AssertionError("unexpected second Nominatim request")
        response = self._responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        return response


class FakeClock:
    """A monotonic clock that only moves when the code under test sleeps."""

    def __init__(self, start: float = 1000.0) -> None:
        self.value = start

    def monotonic(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


def _patch_http(monkeypatch, responses) -> FakeHttpClient:
    """Replace the HTTP layer below the reused Nominatim client.

    The throttle timestamp is reset too: it is process-wide, and a lookup this
    test did a moment ago would otherwise make the first request here wait a
    real second and race the boundary's timeout.
    """
    http = FakeHttpClient(responses)
    osm_geo._geocode_cache.clear()
    monkeypatch.setattr(osm_geo, "_last_nominatim_call", 0.0)
    monkeypatch.setattr(osm_geo, "_client", lambda: http)
    return http


def _boundary(attempts: int = 1) -> Boundary:
    """A boundary whose timeout is longer than the throttle.

    With a 1.0s timeout a request that should not have happened would be killed
    while it waited its second, and the request counter would stay at one: the
    timeout would hide the bug instead of the test catching it.
    """
    return Boundary(
        ResiliencePolicy(
            dependency="nominatim",
            timeout_seconds=3.0,
            failure_threshold=5,
            reset_timeout_seconds=60.0,
            max_attempts=attempts,
            max_concurrency=1,
        ),
        StructuredLogMetricSink("nominatim-test"),
    )


def _gateway(attempts: int = 1) -> GeocodingGateway:
    return GeocodingGateway(
        boundary=_boundary(attempts), reverse_geocode=osm_geo.reverse_geocode
    )


async def test_a_successful_reverse_returns_the_short_place_name(monkeypatch):
    """A point becomes the human label a sentence can carry, and the request is
    the reverse endpoint with the point the caller asked about."""
    http = _patch_http(monkeypatch, [FakeResponse(PLACE)])

    name = await _gateway().place_name(6.5095, 3.3711)

    assert name == "Lekki, Lagos"
    assert len(http.requests) == 1
    assert http.requests[0]["url"].endswith("/reverse")
    assert http.requests[0]["params"]["lat"] == 6.5095
    assert http.requests[0]["params"]["lon"] == 3.3711


async def test_a_raising_lookup_returns_none_instead_of_raising():
    """The gateway's own contract: a lookup that raises is turned by the
    boundary into a typed None, because a backfill must not stop over a place."""

    async def failing_reverse(latitude, longitude):
        raise RuntimeError("Nominatim unreachable")

    gateway = GeocodingGateway(
        boundary=_boundary(), reverse_geocode=failing_reverse
    )

    assert await gateway.place_name(6.1, 3.2) is None


async def test_an_empty_answer_is_cached_like_a_place(monkeypatch):
    """A point that has no place is an answer too. Re-asking Nominatim for it
    would spend the one-request-per-second budget on a question already
    answered, so the empty answer must come back from the cache."""
    http = _patch_http(monkeypatch, [FakeResponse(None), FakeResponse(None)])
    gateway = _gateway()

    assert await gateway.place_name(6.1, 3.2) is None
    assert await gateway.place_name(6.1, 3.2) is None
    assert len(http.requests) == 1


async def test_the_same_point_is_never_fetched_twice(monkeypatch):
    """Nominatim's policy says one request per second and a cache for repeats.
    The second lookup of one point must be answered from the cache."""
    http = _patch_http(
        monkeypatch, [FakeResponse(PLACE), FakeResponse(PLACE)]
    )
    gateway = _gateway()

    first = await gateway.place_name(6.5095, 3.3711)
    second = await gateway.place_name(6.5095, 3.3711)

    assert (first, second) == ("Lekki, Lagos", "Lekki, Lagos")
    assert len(http.requests) == 1


async def test_two_points_are_at_least_one_second_apart(monkeypatch):
    """Two different points must not leave in the same second. The reused client
    is the only throttle in the process, so the wait happens inside the call."""
    clock = FakeClock()
    sleeps: list[float] = []

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        clock.advance(seconds)

    http = _patch_http(
        monkeypatch,
        [
            FakeResponse(PLACE),
            FakeResponse(
                {
                    "lat": "6.6",
                    "lon": "3.4",
                    "display_name": "Ikeja, Lagos, Nigeria",
                    "address": {"suburb": "Ikeja", "city": "Lagos"},
                }
            ),
        ],
    )
    monkeypatch.setattr(osm_geo, "time", clock)
    monkeypatch.setattr(
        osm_geo, "asyncio", types.SimpleNamespace(sleep=fake_sleep)
    )
    monkeypatch.setattr(osm_geo, "_last_nominatim_call", 0.0)

    gateway = _gateway()
    first = await gateway.place_name(6.5095, 3.3711)
    second = await gateway.place_name(6.6, 3.4)

    assert (first, second) == ("Lekki, Lagos", "Ikeja, Lagos")
    assert len(http.requests) == 2
    assert sleeps == [1.0]
