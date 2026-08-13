"""Smoke tests: health check + OpenAPI schema are served."""


async def test_health(client):
    resp = await client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "healthy"
    assert body["version"] == "1.0.0"


async def test_openapi_available(client):
    resp = await client.get("/openapi.json")
    assert resp.status_code == 200
    paths = resp.json()["paths"]
    # A few endpoints we expect to exist.
    for p in (
        "/api/v1/auth/register",
        "/api/v1/auth/login",
        "/api/v1/jobs/",
        "/api/v1/services/",
        "/api/v1/categories/",
        "/api/v1/notifications/",
        "/api/v1/applications/",
        "/api/v1/messages/",
    ):
        assert p in paths, f"expected {p} in OpenAPI paths"
