"""Smoke tests: categories, jobs, services, applications, messages, notifications.

These exercise the read + create flows against the real app. Solana-backed
flows (fund/release/vouch minting) are intentionally NOT covered here — they
need a funded devnet wallet — but the pre-funding lifecycle (create → apply →
assign → cancel) is fully covered off-chain.
"""

from conftest import RUN_ID, auth_headers, register_user


async def _make_category(client, name: str) -> dict:
    resp = await client.post(
        "/api/v1/categories/", json={"name": name}
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def test_categories_list_and_create(client):
    # List (public).
    resp = await client.get("/api/v1/categories/")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)

    # Create.
    cat = await _make_category(client, f"smoke-{RUN_ID}-plumbing")
    assert cat["name"] == f"smoke-{RUN_ID}-plumbing"
    assert "id" in cat

    # Duplicate -> 409.
    dup = await client.post(
        "/api/v1/categories/", json={"name": f"smoke-{RUN_ID}-plumbing"}
    )
    assert dup.status_code == 409, dup.text

    # The new category shows up in the list.
    listed = await client.get("/api/v1/categories/")
    names = [c["name"] for c in listed.json()]
    assert f"smoke-{RUN_ID}-plumbing" in names


async def test_job_create_list_get_cancel(client):
    client_user = await register_user(client, role="client")
    headers = auth_headers(client_user["token"])

    created = await client.post(
        "/api/v1/jobs/",
        headers=headers,
        json={
            "title": f"Smoke job {RUN_ID}",
            "description": "Fix a leaking kitchen tap",
            "price": 5000,
            "latitude": 6.5244,
            "longitude": 3.3792,
        },
    )
    assert created.status_code == 201, created.text
    job = created.json()
    assert job["status"] == "open"
    assert job["title"] == f"Smoke job {RUN_ID}"

    job_id = job["id"]

    # Fetch single job.
    got = await client.get(f"/api/v1/jobs/{job_id}", headers=headers)
    assert got.status_code == 200
    assert got.json()["id"] == job_id

    # My jobs (as client) include it.
    mine = await client.get("/api/v1/jobs/?my=client", headers=headers)
    assert mine.status_code == 200
    ids = [j["id"] for j in mine.json()]
    assert job_id in ids

    # Unauthenticated list is rejected.
    anon = await client.get("/api/v1/jobs/")
    assert anon.status_code == 401

    # Pre-funding cancel (off-chain) works for either party.
    cancelled = await client.post(
        f"/api/v1/jobs/{job_id}/cancel", headers=headers
    )
    assert cancelled.status_code == 200, cancelled.text
    assert cancelled.json()["status"] == "cancelled"


async def test_jobs_search_filters(client):
    """Jobs search must filter by both the `q` param (frontend) and `search`
    (backend alias), and match words across title AND description, fuzzily.

    Regression: the frontend sends ?q=... but the endpoint only read ?search=...
    (FastAPI alias), so the search bar silently did nothing.
    """
    client_user = await register_user(client, role="client")
    headers = auth_headers(client_user["token"])

    def make(title: str, desc: str) -> dict:
        return {
            "title": title,
            "description": desc,
            "price": 4000,
            "latitude": 6.5244,
            "longitude": 3.3792,
        }

    a = (await client.post("/api/v1/jobs/", headers=headers, json=make(
        f"Smoke search A {RUN_ID}", "Samsung phone screen repair"))).json()
    b = (await client.post("/api/v1/jobs/", headers=headers, json=make(
        f"Smoke search B {RUN_ID}", "Dog walking in the park"))).json()

    # --- the actual frontend call: ?q= must filter ---
    q = await client.get("/api/v1/jobs/", headers=headers,
                         params={"status": "open,requested", "q": "samsung"})
    assert q.status_code == 200, q.text
    q_ids = [j["id"] for j in q.json()]
    assert a["id"] in q_ids, "?q=samsung should match the Samsung job"
    assert b["id"] not in q_ids, "?q=samsung must NOT return the dog job"

    # --- legacy alias still works ---
    legacy = await client.get("/api/v1/jobs/", headers=headers,
                              params={"search": "dog walking"})
    legacy_ids = [j["id"] for j in legacy.json()]
    assert b["id"] in legacy_ids, "?search=dog walking should match the dog job"
    assert a["id"] not in legacy_ids

    # --- fuzzy: words split across title + description, out of order ---
    fuzzy = await client.get("/api/v1/jobs/", headers=headers,
                             params={"q": "cracked samsung"})
    fuzzy_ids = [j["id"] for j in fuzzy.json()]
    assert a["id"] in fuzzy_ids, "fuzzy words across title/description must match"
    assert b["id"] not in fuzzy_ids


async def test_jobs_ranked_by_hotness(client):
    """Open jobs default to hotness ranking (freshness + demand) and every job
    in the list carries its applications_count for the card badge."""
    client_user = await register_user(client, role="client")
    provider_user = await register_user(client, role="provider")
    client_headers = auth_headers(client_user["token"])
    provider_headers = auth_headers(provider_user["token"])

    def make(title: str) -> dict:
        return {
            "title": title,
            "description": "Ranking smoke job",
            "price": 6000,
            "latitude": 6.5244,
            "longitude": 3.3792,
        }

    engaged = (await client.post("/api/v1/jobs/", headers=client_headers,
                                 json=make(f"Hotness engaged {RUN_ID}"))).json()
    fresh = (await client.post("/api/v1/jobs/", headers=client_headers,
                               json=make(f"Hotness fresh {RUN_ID}"))).json()

    # One application to the "engaged" job (both jobs are equally fresh, so
    # demand is the tiebreaker that must push it above the untouched job).
    applied = await client.post(
        "/api/v1/applications/",
        headers=provider_headers,
        json={"job_id": engaged["id"], "message": "I can handle this"},
    )
    assert applied.status_code == 201, applied.text

    lst = await client.get("/api/v1/jobs/", headers=client_headers,
                           params={"status": "open,requested"})
    assert lst.status_code == 200, lst.text
    ids = [j["id"] for j in lst.json()]
    assert engaged["id"] in ids and fresh["id"] in ids
    assert ids.index(engaged["id"]) < ids.index(fresh["id"]), \
        "engaged job (1 applicant) must rank above untouched fresh job"

    by_id = {j["id"]: j for j in lst.json()}
    assert by_id[engaged["id"]]["applications_count"] == 1
    assert by_id[fresh["id"]]["applications_count"] == 0


async def test_jobs_category_filter(client):
    """Jobs browse filters by category: direct posts carry their own
    category_id, service-request jobs inherit the listing's, and the filter
    matches both."""
    client_user = await register_user(client, role="client")
    headers = auth_headers(client_user["token"])
    cat = await _make_category(client, f"smoke-{RUN_ID}-catfilter")

    def make(title: str, category_id=None) -> dict:
        payload = {
            "title": title,
            "description": "Category filter smoke job",
            "price": 5000,
            "latitude": 6.5244,
            "longitude": 3.3792,
        }
        if category_id:
            payload["category_id"] = category_id
        return payload

    tagged = (await client.post("/api/v1/jobs/", headers=headers,
                                json=make(f"Cat tagged {RUN_ID}", cat["id"]))).json()
    untagged = (await client.post("/api/v1/jobs/", headers=headers,
                                  json=make(f"Cat untagged {RUN_ID}"))).json()
    assert tagged["category_id"] == cat["id"]
    assert untagged["category_id"] is None

    # Service-request jobs inherit the listing's category.
    provider = await register_user(client, role="provider")
    ph = auth_headers(provider["token"])
    svc = (await client.post("/api/v1/services/", headers=ph, json={
        "category_id": cat["id"],
        "title": f"Cat svc {RUN_ID}",
        "description": "svc",
        "price": 10000,
        "latitude": 6.5244,
        "longitude": 3.3792,
        "radius_km": 10,
    })).json()
    req = await client.post(f"/api/v1/jobs/request-service/{svc['id']}", headers=headers)
    assert req.status_code == 201, req.text
    assert req.json()["category_id"] == cat["id"]

    filtered = await client.get("/api/v1/jobs/", headers=headers,
                                params={"category_id": cat["id"]})
    assert filtered.status_code == 200, filtered.text
    ids = [j["id"] for j in filtered.json()]
    assert tagged["id"] in ids, "direct post with category must match"
    assert req.json()["id"] in ids, "service-request job must match via inherited category"
    assert untagged["id"] not in ids, "job without category must be excluded"


async def test_nudge_loop(client):
    """Unanswered applications trigger one follow-up nudge to each side:
    the client (providers are waiting) and the applicant (no reply yet)."""
    from sqlalchemy import text
    from app.services.nudge_loop import run_nudges
    from app.core.database import async_session as _async_session

    client_user = await register_user(client, role="client")
    provider_user = await register_user(client, role="provider")
    ch = auth_headers(client_user["token"])
    ph = auth_headers(provider_user["token"])

    job = (await client.post("/api/v1/jobs/", headers=ch, json={
        "title": f"Nudge job {RUN_ID}",
        "description": "Nudge smoke job",
        "price": 7000,
        "latitude": 6.5244,
        "longitude": 3.3792,
    })).json()

    applied = await client.post(
        "/api/v1/applications/",
        headers=ph,
        json={"job_id": job["id"], "message": "I can do this"},
    )
    assert applied.status_code == 201, applied.text

    # Backdate the application past NUDGE_AFTER_HOURS (default 12h) so the
    # nudge qualifies without touching env config.
    async with _async_session() as db:
        await db.execute(
            text("UPDATE applications SET created_at = now() - interval '2 days' WHERE job_id = :jid"),
            {"jid": job["id"]},
        )
        await db.commit()

    await run_nudges()

    client_notifs = (await client.get("/api/v1/notifications/", headers=ch)).json()
    client_titles = [n["title"] for n in client_notifs]
    assert "Providers are waiting" in client_titles

    provider_notifs = (await client.get("/api/v1/notifications/", headers=ph)).json()
    provider_titles = [n["title"] for n in provider_notifs]
    assert "Your application is waiting" in provider_titles

    # Dedupe: a second scan must not re-send the same nudges.
    await run_nudges()
    again = (await client.get("/api/v1/notifications/", headers=ch)).json()
    assert sum(1 for n in again if n["title"] == "Providers are waiting") == 1
    again_p = (await client.get("/api/v1/notifications/", headers=ph)).json()
    assert sum(1 for n in again_p if n["title"] == "Your application is waiting") == 1


async def test_service_create_and_list(client):
    provider = await register_user(client, role="provider")
    headers = auth_headers(provider["token"])

    cat = await _make_category(client, f"smoke-{RUN_ID}-cleaning")

    created = await client.post(
        "/api/v1/services/",
        headers=headers,
        json={
            "category_id": cat["id"],
            "title": f"Smoke cleaning service {RUN_ID}",
            "description": "Deep home cleaning",
            "price": 15000,
            "latitude": 6.5244,
            "longitude": 3.3792,
            "radius_km": 10,
        },
    )
    assert created.status_code == 201, created.text
    service = created.json()
    assert service["title"] == f"Smoke cleaning service {RUN_ID}"
    service_id = service["id"]

    # My services.
    mine = await client.get("/api/v1/services/", headers=headers)
    assert mine.status_code == 200
    ids = [s["id"] for s in mine.json()]
    assert service_id in ids

    # Nearby search (public) finds it.
    nearby = await client.get(
        "/api/v1/services/search/nearby",
        params={"lat": 6.5244, "lon": 3.3792, "radius": 20},
    )
    assert nearby.status_code == 200
    nearby_ids = [s["id"] for s in nearby.json()]
    assert service_id in nearby_ids


async def test_application_flow(client):
    client_user = await register_user(client, role="client")
    provider_user = await register_user(client, role="provider")
    client_headers = auth_headers(client_user["token"])
    provider_headers = auth_headers(provider_user["token"])

    job = await client.post(
        "/api/v1/jobs/",
        headers=client_headers,
        json={
            "title": f"Smoke app job {RUN_ID}",
            "description": "Assemble an office chair",
            "price": 8000,
            "latitude": 6.5244,
            "longitude": 3.3792,
        },
    )
    assert job.status_code == 201, job.text
    job_id = job.json()["id"]

    # Provider applies.
    app_resp = await client.post(
        "/api/v1/applications/",
        headers=provider_headers,
        json={"job_id": job_id, "message": "I can do this!", "proposed_price": 7500},
    )
    assert app_resp.status_code == 201, app_resp.text
    application = app_resp.json()
    assert application["job_id"] == job_id
    assert application["applicant_id"] == provider_user["user_id"]

    # Duplicate application -> 400.
    dup = await client.post(
        "/api/v1/applications/",
        headers=provider_headers,
        json={"job_id": job_id, "message": "again"},
    )
    assert dup.status_code == 400, dup.text

    # Client sees the application with applicant enrichment.
    apps = await client.get(
        f"/api/v1/applications/job/{job_id}", headers=client_headers
    )
    assert apps.status_code == 200, apps.text
    assert len(apps.json()) == 1
    assert apps.json()[0]["applicant_id"] == provider_user["user_id"]

    # Provider's "mine" endpoint lists it.
    mine = await client.get("/api/v1/applications/mine", headers=provider_headers)
    assert mine.status_code == 200
    assert job_id in mine.json()["job_ids"]

    # Client assigns the provider (off-chain).
    assigned = await client.post(
        f"/api/v1/jobs/{job_id}/assign",
        headers=client_headers,
        json={"provider_id": provider_user["user_id"]},
    )
    assert assigned.status_code == 200, assigned.text
    assert assigned.json()["status"] == "assigned"
    assert assigned.json()["provider_id"] == provider_user["user_id"]


async def test_messages_flow(client):
    client_user = await register_user(client, role="client")
    provider_user = await register_user(client, role="provider")
    client_headers = auth_headers(client_user["token"])
    provider_headers = auth_headers(provider_user["token"])

    job = await client.post(
        "/api/v1/jobs/",
        headers=client_headers,
        json={
            "title": f"Smoke msg job {RUN_ID}",
            "description": "Paint a fence",
            "price": 12000,
            "latitude": 6.5244,
            "longitude": 3.3792,
        },
    )
    job_id = job.json()["id"]

    # Assign so the provider becomes a participant.
    await client.post(
        f"/api/v1/jobs/{job_id}/assign",
        headers=client_headers,
        json={"provider_id": provider_user["user_id"]},
    )

    sent = await client.post(
        "/api/v1/messages/",
        headers=client_headers,
        json={"job_id": job_id, "content": f"Hi! Smoke message {RUN_ID}"},
    )
    assert sent.status_code == 201, sent.text
    assert sent.json()["content"] == f"Hi! Smoke message {RUN_ID}"

    # Provider can read the thread; client can too.
    for h in (client_headers, provider_headers):
        thread = await client.get(f"/api/v1/messages/job/{job_id}", headers=h)
        assert thread.status_code == 200, thread.text
        contents = [m["content"] for m in thread.json()]
        assert f"Hi! Smoke message {RUN_ID}" in contents


async def test_notifications_flow(client):
    client_user = await register_user(client, role="client")
    provider_user = await register_user(client, role="provider")
    client_headers = auth_headers(client_user["token"])
    provider_headers = auth_headers(provider_user["token"])

    job = await client.post(
        "/api/v1/jobs/",
        headers=client_headers,
        json={
            "title": f"Smoke notif job {RUN_ID}",
            "description": "Install a ceiling fan",
            "price": 10000,
            "latitude": 6.5244,
            "longitude": 3.3792,
        },
    )
    job_id = job.json()["id"]

    # Applying creates a notification for the job poster.
    await client.post(
        "/api/v1/applications/",
        headers=provider_headers,
        json={"job_id": job_id, "message": "applying"},
    )

    notifs = await client.get("/api/v1/notifications/", headers=client_headers)
    assert notifs.status_code == 200, notifs.text
    assert len(notifs.json()) >= 1

    # Mark all read.
    read = await client.post("/api/v1/notifications/read-all", headers=client_headers)
    assert read.status_code == 200
    assert read.json()["status"] == "ok"
