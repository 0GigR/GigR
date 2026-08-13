"""Smoke tests: registration, login, /me, refresh, logout."""

from conftest import make_email


async def test_register_and_me(client):
    email = make_email("auth")
    resp = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Secret!123", "display_name": "Smoke Auth"},
    )
    assert resp.status_code == 201, resp.text
    user = resp.json()
    assert user["email"] == email
    assert user["display_name"] == "Smoke Auth"
    assert "id" in user

    # /me requires the token.
    login = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": "Secret!123"}
    )
    assert login.status_code == 200, login.text
    token = login.json()["access_token"]

    me = await client.get(
        "/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"}
    )
    assert me.status_code == 200, me.text
    assert me.json()["id"] == user["id"]


async def test_duplicate_email_rejected(client):
    email = make_email("dup")
    payload = {"email": email, "password": "Secret!123", "display_name": "Dup User"}
    first = await client.post("/api/v1/auth/register", json=payload)
    assert first.status_code == 201, first.text

    second = await client.post("/api/v1/auth/register", json=payload)
    assert second.status_code == 409, second.text


async def test_login_wrong_password(client):
    email = make_email("badpw")
    await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Right!123", "display_name": "Bad Pw"},
    )
    resp = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": "Wrong!123"}
    )
    assert resp.status_code == 401, resp.text


async def test_me_requires_auth(client):
    resp = await client.get("/api/v1/auth/me")
    assert resp.status_code == 401, resp.text


async def test_refresh_flow(client):
    email = make_email("refresh")
    await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Secret!123", "display_name": "Refresh"},
    )
    login = await client.post(
        "/api/v1/auth/login", json={"email": email, "password": "Secret!123"}
    )
    assert login.status_code == 200
    refresh_cookie = login.cookies.get("refresh_token")
    assert refresh_cookie, "login should set a refresh_token cookie"

    resp = await client.post("/api/v1/auth/refresh", cookies={"refresh_token": refresh_cookie})
    assert resp.status_code == 200, resp.text
    assert resp.json()["access_token"]
