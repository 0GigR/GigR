"""End-to-end job lifecycle smoke tests.

Covers the pre-funding (off-chain) lifecycle:

1. Provider posts a service → client requests it → provider accepts.
2. Client posts an open job → provider applies → client assigns → provider
   cancels (off-chain) before funding.

Solana/escrow flows (fund/release/vouch) are excluded — they need a funded
devnet wallet and real on-chain state.
"""

from conftest import RUN_ID, auth_headers, register_user


async def test_request_service_and_accept(client):
    provider = await register_user(client, role="provider")
    client_user = await register_user(client, role="client")
    provider_headers = auth_headers(provider["token"])
    client_headers = auth_headers(client_user["token"])

    # Provider creates a category + service.
    cat_resp = await client.post(
        "/api/v1/categories/", json={"name": f"smoke-{RUN_ID}-electrical"}
    )
    assert cat_resp.status_code == 201, cat_resp.text
    cat_id = cat_resp.json()["id"]

    svc_resp = await client.post(
        "/api/v1/services/",
        headers=provider_headers,
        json={
            "category_id": cat_id,
            "title": f"Smoke electrical service {RUN_ID}",
            "description": "Fix wiring",
            "price": 20000,
            "latitude": 6.5244,
            "longitude": 3.3792,
        },
    )
    assert svc_resp.status_code == 201, svc_resp.text
    service_id = svc_resp.json()["id"]

    # Client requests the service -> job in "requested" state.
    req = await client.post(
        f"/api/v1/jobs/request-service/{service_id}", headers=client_headers
    )
    assert req.status_code == 201, req.text
    job = req.json()
    assert job["status"] == "requested"
    assert job["provider_id"] == provider["user_id"]
    job_id = job["id"]

    # Requesting the same service again returns the existing active job.
    again = await client.post(
        f"/api/v1/jobs/request-service/{service_id}", headers=client_headers
    )
    assert again.status_code == 201, again.text
    assert again.json()["id"] == job_id

    # Only the provider can accept.
    bad_accept = await client.post(
        f"/api/v1/jobs/{job_id}/accept-request", headers=client_headers
    )
    assert bad_accept.status_code == 403, bad_accept.text

    accepted = await client.post(
        f"/api/v1/jobs/{job_id}/accept-request", headers=provider_headers
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "assigned"

    # Pre-funding cancel: the client can cancel the assigned job.
    cancelled = await client.post(
        f"/api/v1/jobs/{job_id}/cancel", headers=client_headers
    )
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"


async def test_open_job_apply_assign_cancel(client):
    client_user = await register_user(client, role="client")
    provider = await register_user(client, role="provider")
    client_headers = auth_headers(client_user["token"])
    provider_headers = auth_headers(provider["token"])

    created = await client.post(
        "/api/v1/jobs/",
        headers=client_headers,
        json={
            "title": f"Smoke open job {RUN_ID}",
            "description": "Move a sofa up two floors",
            "price": 30000,
            "latitude": 6.5244,
            "longitude": 3.3792,
        },
    )
    assert created.status_code == 201, created.text
    job_id = created.json()["id"]

    # Provider cannot assign (only the client can).
    bad = await client.post(
        f"/api/v1/jobs/{job_id}/assign",
        headers=provider_headers,
        json={"provider_id": provider["user_id"]},
    )
    assert bad.status_code == 403, bad.text

    # Provider applies, client assigns.
    await client.post(
        "/api/v1/applications/",
        headers=provider_headers,
        json={"job_id": job_id, "message": "I have a van"},
    )
    assigned = await client.post(
        f"/api/v1/jobs/{job_id}/assign",
        headers=client_headers,
        json={"provider_id": provider["user_id"]},
    )
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["status"] == "assigned"

    # Provider cancels pre-funding.
    cancelled = await client.post(
        f"/api/v1/jobs/{job_id}/cancel", headers=provider_headers
    )
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"


async def test_job_auth_rules(client):
    """Jobs are only visible to authenticated users; a stranger cannot peek."""
    client_user = await register_user(client, role="client")
    stranger = await register_user(client, role="stranger")
    client_headers = auth_headers(client_user["token"])
    stranger_headers = auth_headers(stranger["token"])

    created = await client.post(
        "/api/v1/jobs/",
        headers=client_headers,
        json={
            "title": f"Smoke private job {RUN_ID}",
            "description": "secret project",
            "price": 40000,
        },
    )
    assert created.status_code == 201, created.text
    job_id = created.json()["id"]

    # Job details are public (readable by anyone, even unauthenticated)...
    got = await client.get(f"/api/v1/jobs/{job_id}", headers=stranger_headers)
    assert got.status_code == 200
    anon = await client.get(f"/api/v1/jobs/{job_id}")
    assert anon.status_code == 200

    # ...but only the client can cancel it.
    deny = await client.post(
        f"/api/v1/jobs/{job_id}/cancel", headers=stranger_headers
    )
    assert deny.status_code == 403, deny.text
