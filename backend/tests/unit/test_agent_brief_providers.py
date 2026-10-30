"""The providers the agent-brief picker offers, and the job each row carries.

The picker's contract has two halves and both are pinned here.

The first half is that the brief endpoint stays keyed by job. The picker does not
change that: each provider row carries the representative completed job the
existing quote and purchase are asked for, so the endpoint's shape is untouched.

The second half is the input handling on a public read: a blank search lists
everyone, a long search is cut before it becomes a LIKE pattern, and a page size
a caller invents cannot ask for the whole table. Each of those is a test that
fails if its rule is removed, not a smoke test.

Nothing here touches the network or the database: the query is replaced at the
service's own import seam, and the router is exercised in-process with its
dependency overridden.
"""

from __future__ import annotations

from decimal import Decimal
from uuid import UUID

import pytest
from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.v1.endpoints import agent_brief as router_module
from app.core.dependencies import get_db
from app.crud.agent_brief_provider import BriefProviderRow
from app.services import agent_brief_service as brief_module
from app.services.agent_brief_service import (
    BRIEF_PROVIDER_PAGE_SIZE,
    BRIEF_PROVIDER_SEARCH_CHARS,
    MAX_BRIEF_PROVIDER_PAGE_SIZE,
    list_brief_providers,
)

PROVIDER_ID = UUID("da15e7cb-2103-4d71-904b-2c6cb7616f66")
OTHER_PROVIDER_ID = UUID("db9f9c42-b7fa-4d61-b5ff-9b71ec3fe31c")
JOB_ID = UUID("ff099832-29a6-48ad-9d42-02bbdd016010")
OTHER_JOB_ID = UUID("8611db23-84e4-4660-a070-ed008f11f37a")


def a_row(**overrides) -> BriefProviderRow:
    """A provider row with the fields the endpoint maps, overridable per test."""
    values = dict(
        provider_id=PROVIDER_ID,
        display_name="OKAFOR KOSISOCHUKWU",
        category_name="Home Services",
        rating_count=3,
        rating_average=4.0,
        completed_jobs=3,
        job_id=JOB_ID,
        job_title="Traditional Private Chef",
        job_price=Decimal("5000.00"),
    )
    values.update(overrides)
    return BriefProviderRow(**values)


@pytest.fixture
def captured(monkeypatch):
    """Replace the query and record exactly what the service asked it for."""
    calls: list[dict] = []

    async def fake_rows(db, *, search=None, limit=20):
        calls.append({"db": db, "search": search, "limit": limit})
        return [a_row()]

    monkeypatch.setattr(brief_module, "list_brief_provider_rows", fake_rows)
    return calls


async def test_a_blank_search_lists_every_provider(captured):
    await list_brief_providers(object(), search="   ", limit=BRIEF_PROVIDER_PAGE_SIZE)

    assert captured[0]["search"] is None


async def test_a_search_is_trimmed_before_it_reaches_the_query(captured):
    await list_brief_providers(object(), search="  orji  ", limit=20)

    assert captured[0]["search"] == "orji"


async def test_a_pasted_search_is_cut_to_the_search_limit(captured):
    await list_brief_providers(object(), search="a" * 500, limit=20)

    assert captured[0]["search"] == "a" * BRIEF_PROVIDER_SEARCH_CHARS


async def test_a_page_size_above_the_ceiling_is_held_to_it(captured):
    await list_brief_providers(object(), search=None, limit=10_000)

    assert captured[0]["limit"] == MAX_BRIEF_PROVIDER_PAGE_SIZE


async def test_a_page_size_below_one_is_raised_to_one(captured):
    await list_brief_providers(object(), search=None, limit=0)

    assert captured[0]["limit"] == 1


@pytest.fixture
async def client(monkeypatch):
    """The agent brief router, in-process, with the query replaced."""
    rows = [
        a_row(),
        a_row(
            provider_id=OTHER_PROVIDER_ID,
            display_name="Orji John",
            category_name="Digital-Tech Services",
            rating_count=1,
            rating_average=4.0,
            completed_jobs=5,
            job_id=OTHER_JOB_ID,
            job_title="Average Joe Web Dev",
            job_price=Decimal("100.00"),
        ),
    ]

    async def fake_list(db, *, search=None, limit=20):
        return rows

    monkeypatch.setattr(router_module, "list_brief_providers", fake_list)

    app = FastAPI()
    app.include_router(router_module.router, prefix="/api/v1/agent")
    app.dependency_overrides[get_db] = lambda: object()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as http:
        yield http


async def test_the_providers_endpoint_returns_each_provider_with_a_job_to_quote(client):
    response = await client.get("/api/v1/agent/brief/providers")

    assert response.status_code == 200
    providers = response.json()["providers"]
    assert len(providers) == 2

    first = providers[0]
    assert first["provider_id"] == str(PROVIDER_ID)
    assert first["name"] == "OKAFOR KOSISOCHUKWU"
    assert first["category"] == "Home Services"
    assert first["rating_count"] == 3
    assert first["rating_average"] == 4.0
    assert first["completed_jobs"] == 3
    # The brief endpoint is keyed by job, so the row must carry one.
    assert first["job_id"] == str(JOB_ID)
    assert first["job_title"] == "Traditional Private Chef"
    assert first["job_price"] == 5000.0


async def test_the_providers_endpoint_passes_the_search_and_the_page_size(
    client, monkeypatch
):
    seen: list[dict] = []

    async def recording(db, *, search=None, limit=20):
        seen.append({"search": search, "limit": limit})
        return []

    monkeypatch.setattr(router_module, "list_brief_providers", recording)

    response = await client.get(
        "/api/v1/agent/brief/providers", params={"q": "okaf", "limit": 5}
    )

    assert response.status_code == 200
    assert response.json() == {"providers": []}
    assert seen == [{"search": "okaf", "limit": 5}]


async def test_a_provider_with_no_rating_and_no_price_still_has_a_row(client, monkeypatch):
    async def one_bare_row(db, *, search=None, limit=20):
        return [
            a_row(
                category_name=None,
                rating_count=0,
                rating_average=None,
                job_price=None,
            )
        ]

    monkeypatch.setattr(router_module, "list_brief_providers", one_bare_row)

    response = await client.get("/api/v1/agent/brief/providers")

    assert response.status_code == 200
    provider = response.json()["providers"][0]
    assert provider["category"] is None
    assert provider["rating_average"] is None
    assert provider["job_price"] is None
