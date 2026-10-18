"""Shared fixtures for the Gigr API smoke-test suite.

Design notes
------------
- We exercise the REAL FastAPI app via httpx's ASGITransport (in-process, no
  live server, no network port). This tests the actual request handlers,
  auth, and ORM layer against a real PostgreSQL+PostGIS database.
- All data created by the suite is namespaced with a unique run id so runs
  don't collide, and a session-scoped autouse fixture deletes every row the
  suite created before the DB session pool shuts down.
- If the database is unreachable, the whole suite skips with a clear message
  instead of failing with a wall of connection errors.

Run from the backend/ directory:  venv/bin/python -m pytest
"""
from __future__ import annotations

import os
import uuid
from pathlib import Path

import httpx
import pytest
from sqlalchemy import text

from app.core.config import settings
from app.core.database import engine
from app.main import app

# ── Safety guard ─────────────────────────────────────────────────────────────
# This suite WRITES and DELETES rows. If a run is killed mid-flight (timeout, CI
# cancel) the session-scoped cleanup below never fires and orphaned smoke rows
# survive in whatever database it pointed at. That is exactly how smoke data
# ended up in production Supabase. Refuse to run against a managed cloud
# database unless the operator explicitly opts in.
_DESTRUCTIVE_HOST_MARKERS = (
    "supabase", "pooler", "neon.tech", "render.com",
    "heroku", "amazonaws.com", "azure.com",
)
_ALLOW_REMOTE_ENV = "GIGR_SMOKE_TESTS_ALLOW_REMOTE"


def _guard_destructive_target() -> None:
    """Skip (never fail) when the configured DB looks like production."""
    if os.getenv(_ALLOW_REMOTE_ENV) == "1":
        return
    url = str(getattr(settings, "DATABASE_URL", "") or "").lower()
    for marker in _DESTRUCTIVE_HOST_MARKERS:
        if marker in url:
            pytest.skip(
                f"Refusing to run the destructive smoke suite against what looks "
                f"like a managed/hosted database (matched {marker!r}). Point "
                f"DATABASE_URL at a disposable test database, or set "
                f"{_ALLOW_REMOTE_ENV}=1 to override deliberately."
            )

# Unique per-run suffix so parallel/repeat runs never collide.
RUN_ID = uuid.uuid4().hex[:10]

# A real TLD so email-validator accepts it (reserved TLDs like .test are rejected).
TEST_EMAIL_DOMAIN = "smoke.gigr.dev"


def make_email(role: str = "user") -> str:
    return f"{role}-{RUN_ID}-{uuid.uuid4().hex[:8]}@{TEST_EMAIL_DOMAIN}"


@pytest.fixture(scope="session")
async def db_ready() -> None:
    """Make sure the database is reachable and initialised, then proceed.

    Runs init_db() so the suite works against a *fresh* PostGIS database
    (CI containers), not just the dev database that already has tables.
    """
    _guard_destructive_target()
    try:
        from app.core.database import init_db
        await init_db()
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception as exc:  # pragma: no cover - depends on env
        pytest.skip(f"Database unreachable — cannot run smoke suite: {exc}")


@pytest.fixture(scope="session")
async def client(db_ready):
    """Async HTTP client that talks to the app in-process."""
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


@pytest.fixture(scope="session", autouse=True)
def _stub_external_services():
    """Neutralise fire-and-forget side effects that hit real third parties.

    These run as asyncio background tasks during requests; in the test session
    they would make real network calls (Brevo emails) and write notifications
    for OTHER (real) users whose services match the smoke jobs. None of that is
    what we're testing, so stub them out — the request handlers' responses are
    unaffected.
    """
    import app.api.v1.endpoints.jobs as jobs_module

    mp = pytest.MonkeyPatch()

    def _noop_email(to_email, subject, html_content):
        pass

    async def _noop_matching_providers(job_id: str, poster_name: str):
        pass

    mp.setattr(jobs_module, "_send_email_background", _noop_email)
    mp.setattr(jobs_module, "_notify_matching_providers", _noop_matching_providers)
    yield
    mp.undo()


async def register_user(client: httpx.AsyncClient, role: str = "user", display_name: str | None = None) -> dict:
    """Register a fresh user via the real API and return their login token + id."""
    email = make_email(role)
    password = "SmokeTest!123"
    resp = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": password,
            "display_name": display_name or f"Smoke {role} {uuid.uuid4().hex[:6]}",
        },
    )
    assert resp.status_code == 201, f"register failed: {resp.status_code} {resp.text}"
    user = resp.json()

    login = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    assert login.status_code == 200, f"login failed: {login.status_code} {login.text}"
    token = login.json()["access_token"]
    return {"token": token, "user_id": user["id"], "email": email, "password": password}


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _in_clause(ids: list[str]) -> str:
    """Build a SQL IN (...) clause from a list of UUID strings (safe: ids come from the DB)."""
    return ",".join(f"'{i}'" for i in ids)


async def _fetch_user_ids() -> list[str]:
    """All user ids created by this run (matched by email domain)."""
    async with engine.connect() as conn:
        result = await conn.execute(
            text("SELECT id FROM users WHERE email LIKE :pattern"),
            {"pattern": f"%@{TEST_EMAIL_DOMAIN}"},
        )
        return [str(row[0]) for row in result.all()]


async def _fetch_job_ids(user_ids: list[str]) -> list[str]:
    """Jobs owned by the given users (as client or provider)."""
    if not user_ids:
        return []
    async with engine.connect() as conn:
        result = await conn.execute(
            text(
                f"SELECT id FROM jobs WHERE client_id IN ({_in_clause(user_ids)}) OR provider_id IN ({_in_clause(user_ids)})"
            )
        )
        return [str(row[0]) for row in result.all()]


@pytest.fixture(scope="session", autouse=True)
async def cleanup_session(db_ready):
    """Delete every row this run created, in FK-safe order, at session end."""
    yield
    user_ids = await _fetch_user_ids()
    if not user_ids:
        return
    job_ids = await _fetch_job_ids(user_ids)

    async with engine.begin() as conn:
        # Child rows referencing the run's jobs / users.
        if job_ids:
            for table in ("messages", "scope_amendments", "disputes", "vouches", "payment_events"):
                await conn.execute(
                    text(f"DELETE FROM {table} WHERE job_id IN ({_in_clause(job_ids)})")
                )
        for table in ("notifications", "push_subscriptions", "agent_tasks"):
            await conn.execute(
                text(f"DELETE FROM {table} WHERE user_id IN ({_in_clause(user_ids)})")
            )
        # Applications have applicant_id (not user_id) — delete both via job and applicant.
        if job_ids:
            await conn.execute(
                text(f"DELETE FROM applications WHERE job_id IN ({_in_clause(job_ids)})")
            )
        await conn.execute(
            text(f"DELETE FROM applications WHERE applicant_id IN ({_in_clause(user_ids)})")
        )
        # Parents.
        if job_ids:
            await conn.execute(
                text(f"DELETE FROM jobs WHERE id IN ({_in_clause(job_ids)})")
            )
        await conn.execute(
            text(f"DELETE FROM service_listings WHERE provider_id IN ({_in_clause(user_ids)})")
        )
        await conn.execute(
            text(f"DELETE FROM announcements WHERE created_by IN ({_in_clause(user_ids)})")
        )
        await conn.execute(
            text(f"DELETE FROM users WHERE id IN ({_in_clause(user_ids)})")
        )
        # Categories created by this run (named with the run prefix).
        await conn.execute(
            text("DELETE FROM categories WHERE name LIKE :prefix"),
            {"prefix": f"smoke-{RUN_ID}%"},
        )
