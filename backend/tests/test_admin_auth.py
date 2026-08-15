"""Tests for admin permissions (IAM-style), announcements, message
notification coalescing, and the forgot/reset password flow."""

from conftest import auth_headers, register_user
from sqlalchemy import text
from app.core.database import engine as _engine


async def _set_role(db_conn, user_id: str, role: str, permissions: list[str] | None = None):
    if permissions is None:
        await db_conn.execute(text("UPDATE users SET role = :r WHERE id = :i"), {"r": role, "i": user_id})
    else:
        await db_conn.execute(
            text("UPDATE users SET role = :r, permissions = :p WHERE id = :i"),
            {"r": role, "p": permissions, "i": user_id},
        )


async def test_admin_permission_gating(client):
    """Regular users can't reach admin endpoints; admins need the right slug;
    superadmin bypasses everything."""
    victim = await register_user(client, role="client")
    vh = auth_headers(victim["token"])
    job = (await client.post("/api/v1/jobs/", headers=vh, json={
        "title": "Admin gating job",
        "description": "gating",
        "price": 5000,
        "latitude": 6.5244,
        "longitude": 3.3792,
    })).json()

    admin = await register_user(client, role="admin")
    ah = auth_headers(admin["token"])

    async with _engine.begin() as conn:
        await _set_role(conn, admin["user_id"], "admin", [])

    # Admin with NO permissions: every admin action is 403.
    for method, path in [("get", "/api/v1/admin/jobs"), ("get", "/api/v1/admin/users")]:
        resp = await client.request(method, path, headers=ah)
        assert resp.status_code == 403, f"{path} should be 403 for permission-less admin: {resp.text}"

    # Grant jobs:manage only — jobs work, users stay locked.
    async with _engine.begin() as conn:
        await _set_role(conn, admin["user_id"], "admin", ["jobs:manage"])
    resp = await client.get("/api/v1/admin/jobs", headers=ah)
    assert resp.status_code == 200, resp.text
    resp = await client.get("/api/v1/admin/users", headers=ah)
    assert resp.status_code == 403, "users:manage not granted — must be 403"

    # Delete the victim's job with jobs:manage.
    resp = await client.delete(f"/api/v1/admin/jobs/{job['id']}", headers=ah)
    assert resp.status_code == 204, resp.text

    # Announce needs announce:manage even for an admin with jobs:manage.
    resp = await client.post("/api/v1/admin/announce", headers=ah,
                             json={"title": "T", "message": "M"})
    assert resp.status_code == 403, resp.text

    # Superadmin bypasses everything (including announce).
    async with _engine.begin() as conn:
        await _set_role(conn, admin["user_id"], "superadmin", None)
    resp = await client.post("/api/v1/admin/announce", headers=ah,
                             json={"title": "SA", "message": "From the top", "target": "inactive", "inactive_days": 1})
    assert resp.status_code == 200, resp.text
    ann_id = resp.json()["announcement_id"]

    # The announcement is visible to a normal user via the popup endpoint.
    viewer = await register_user(client, role="provider")
    active = await client.get("/api/v1/announcements/active", headers=auth_headers(viewer["token"]))
    assert active.status_code == 200, active.text
    assert any(a["id"] == ann_id and a["title"] == "SA" for a in active.json())

    # Clean up rows this test created (announcement + its notifications).
    async with _engine.begin() as conn:
        await conn.execute(text("DELETE FROM notifications WHERE tag = :t"), {"t": f"announcement:{ann_id}"})
        await conn.execute(text("DELETE FROM announcements WHERE id = :i"), {"i": ann_id})


async def test_message_notifications_coalesce_and_clear(client):
    """A message spam must produce ONE unread notification per conversation,
    and opening the conversation must clear it."""
    client_user = await register_user(client, role="client")
    provider_user = await register_user(client, role="provider")
    ch = auth_headers(client_user["token"])
    ph = auth_headers(provider_user["token"])

    job = (await client.post("/api/v1/jobs/", headers=ch, json={
        "title": "Coalesce job",
        "description": "coalesce",
        "price": 9000,
        "latitude": 6.5244,
        "longitude": 3.3792,
    })).json()
    await client.post(f"/api/v1/jobs/{job['id']}/assign", headers=ch,
                      json={"provider_id": provider_user["user_id"]})

    # Spam: three messages from the client to the provider.
    for i in range(3):
        sent = await client.post("/api/v1/messages/", headers=ch,
                                 json={"job_id": job["id"], "content": f"msg {i}"})
        assert sent.status_code == 201, sent.text

    notifs = (await client.get("/api/v1/notifications/", headers=ph)).json()
    message_notifs = [n for n in notifs if n["type"] == "message"]
    assert len(message_notifs) == 1, f"expected ONE coalesced message notification, got {len(message_notifs)}"
    assert "msg 2" in message_notifs[0]["message"], "coalesced row should carry the latest preview"
    assert message_notifs[0]["is_read"] is False

    # Opening the conversation clears it server-side.
    cleared = await client.post("/api/v1/notifications/read-conversation",
                                headers=ph, json={"job_id": job["id"]})
    assert cleared.status_code == 200, cleared.text
    notifs = (await client.get("/api/v1/notifications/", headers=ph)).json()
    message_notifs = [n for n in notifs if n["type"] == "message"]
    assert message_notifs and message_notifs[0]["is_read"] is True

    # A new message after reading creates a fresh unread row (not a re-read bump).
    await client.post("/api/v1/messages/", headers=ch,
                      json={"job_id": job["id"], "content": "new after read"})
    notifs = (await client.get("/api/v1/notifications/", headers=ph)).json()
    unread_messages = [n for n in notifs if n["type"] == "message" and not n["is_read"]]
    assert len(unread_messages) == 1
    assert "new after read" in unread_messages[0]["message"]


async def test_forgot_and_reset_password(client):
    """Forgot-password never leaks which emails exist; a valid reset token
    sets a new password that immediately works for login."""
    user = await register_user(client, role="user")

    # Unknown email: same 200 response as a known one (no account enumeration).
    unknown = await client.post("/api/v1/auth/forgot-password", json={"email": "nobody@smoke.gigr.dev"})
    assert unknown.status_code == 200, unknown.text
    known = await client.post("/api/v1/auth/forgot-password", json={"email": user["email"]})
    assert known.status_code == 200, known.text
    assert unknown.json()["message"] == known.json()["message"]

    # Mint a reset token the same way the endpoint does (the email is stubbed
    # in tests, so we can't read the link — insert the token row directly).
    import hashlib
    from datetime import datetime, timedelta, timezone
    from uuid import uuid4
    from app.core.database import async_session as session_factory
    from app.models.password_reset_token import PasswordResetToken

    raw_token = "test-reset-token-12345"
    token_hash = hashlib.sha256(raw_token.encode()).hexdigest()
    async with session_factory() as db:
        db.add(PasswordResetToken(
            user_id=user["user_id"],
            token_hash=token_hash,
            expires_at=datetime.now(timezone.utc) + timedelta(hours=1),
        ))
        await db.commit()

    # Wrong token -> 400.
    bad = await client.post("/api/v1/auth/reset-password",
                            json={"token": "bogus", "new_password": "NewPass!456"})
    assert bad.status_code == 400, bad.text

    # Valid token -> new password works.
    ok = await client.post("/api/v1/auth/reset-password",
                           json={"token": raw_token, "new_password": "NewPass!456"})
    assert ok.status_code == 200, ok.text

    login_old = await client.post("/api/v1/auth/login",
                                  json={"email": user["email"], "password": user["password"]})
    assert login_old.status_code == 401, "old password must no longer work"
    login_new = await client.post("/api/v1/auth/login",
                                  json={"email": user["email"], "password": "NewPass!456"})
    assert login_new.status_code == 200, login_new.text

    # Token is single-use.
    again = await client.post("/api/v1/auth/reset-password",
                              json={"token": raw_token, "new_password": "Another!789"})
    assert again.status_code == 400, "used token must be rejected"


async def test_announce_emails_all_recipients(client, monkeypatch):
    """Announcement emails go to every recipient, not just stale users: an
    "all" announce emails active users too, while "inactive" emails only
    accounts that have been away past the cutoff."""
    import app.api.v1.endpoints.jobs as jobs_module

    sent: list[tuple[str, str, str]] = []
    monkeypatch.setattr(
        jobs_module, "_send_email_background",
        lambda to, subject, html: sent.append((to, subject, html)),
    )

    # One freshly-active user and one stale user.
    active = await register_user(client, role="client")
    stale = await register_user(client, role="provider")
    async with _engine.begin() as conn:
        await conn.execute(text("UPDATE users SET last_seen_at = NOW() WHERE id = :i"), {"i": active["user_id"]})
        await conn.execute(text("UPDATE users SET last_seen_at = NOW() - interval '30 days' WHERE id = :i"), {"i": stale["user_id"]})

    # The announcer needs announce:manage — make them superadmin.
    admin = await register_user(client, role="admin")
    ah = auth_headers(admin["token"])
    async with _engine.begin() as conn:
        await _set_role(conn, admin["user_id"], "superadmin", None)

    # "all" emails everyone, including the active user.
    resp = await client.post("/api/v1/admin/announce", headers=ah,
                             json={"title": "All", "message": "Hello everyone", "target": "all"})
    assert resp.status_code == 200, resp.text
    all_emails = {e[0] for e in sent}
    assert active["email"] in all_emails, "active user must be emailed on an 'all' announce"
    assert stale["email"] in all_emails
    ann_all = resp.json()["announcement_id"]

    # "inactive" emails only the stale user.
    sent.clear()
    resp = await client.post("/api/v1/admin/announce", headers=ah,
                             json={"title": "Inactive", "message": "Come back", "target": "inactive", "inactive_days": 10})
    assert resp.status_code == 200, resp.text
    inactive_emails = {e[0] for e in sent}
    assert stale["email"] in inactive_emails
    assert active["email"] not in inactive_emails, "active user must NOT be emailed on an 'inactive' announce"
    ann_inactive = resp.json()["announcement_id"]

    # Clean up rows this test created (announcements + their notifications).
    async with _engine.begin() as conn:
        for ann_id in (ann_all, ann_inactive):
            await conn.execute(text("DELETE FROM notifications WHERE tag = :t"), {"t": f"announcement:{ann_id}"})
            await conn.execute(text("DELETE FROM announcements WHERE id = :i"), {"i": ann_id})
