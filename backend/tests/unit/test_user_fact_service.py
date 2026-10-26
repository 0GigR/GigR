"""Facts about a user are built from plain rows, in a stable order, and never
claim anything the rows do not say."""

import re
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.services.user_fact_service import build_fact_identity, build_user_facts

USER_ID = "0b7f9a52-1c4d-4e88-9f31-2a1c5d6e7f80"
OTHER_ID = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f"
PROVIDER_ID = "5e6f7a8b-9c0d-4e1f-8a2b-3c4d5e6f7a8b"
CATEGORY_ID = "7f3a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c"


def _profile(**overrides):
    profile = {
        "id": USER_ID,
        "display_name": "Chinedu Okafor",
        "username": "chinedu",
        "role": "provider",
        "bio": "Plumber",
        "skills": ["plumbing", "pipe fitting", "tiling"],
        "last_location": "Yaba, Lagos",
        "location_lat": 6.5095,
        "location_lng": 3.3711,
        "is_identity_verified": True,
    }
    profile.update(overrides)
    return profile


def _service(**overrides):
    service = {
        "id": "svc-1",
        "provider_id": USER_ID,
        "title": "Emergency pipe repair",
        "price": Decimal("12000.00"),
        "radius_km": Decimal("7.50"),
        "is_active": True,
    }
    service.update(overrides)
    return service


def _client_job(**overrides):
    job = {
        "id": "job-1",
        "client_id": USER_ID,
        "provider_id": PROVIDER_ID,
        "title": "Fix leaking sink",
        "price": Decimal("18000.00"),
        "location": "Yaba, Lagos",
        "category": "Plumbing",
        "status": "completed",
        "created_at": datetime(2024, 3, 12, 9, 30, tzinfo=timezone.utc),
    }
    job.update(overrides)
    return job


def _happy_rows():
    services = [
        _service(id="svc-emergency", title="Emergency pipe repair"),
        _service(
            id="svc-tiling",
            title="Bathroom tiling",
            price=45000,
            radius_km=5,
        ),
        _service(
            id="svc-inactive",
            title="Old listing",
            price=9000,
            radius_km=5,
            is_active=False,
        ),
    ]
    client_jobs = [
        _client_job(),
        _client_job(
            id="job-2",
            title="Replace bathroom tap",
            price=Decimal("16000.00"),
            location="Surulere, Lagos",
            created_at=datetime(2024, 7, 2, 14, 0, tzinfo=timezone.utc),
        ),
        _client_job(
            id="job-3",
            title="Rewire sitting room",
            price=26000,
            location="Yaba, Lagos",
            category="Electrical",
            status="in_progress",
            created_at=datetime(2025, 1, 20, 8, 0, tzinfo=timezone.utc),
        ),
    ]
    provider_jobs = [
        {
            "id": "job-4",
            "client_id": OTHER_ID,
            "provider_id": USER_ID,
            "title": "Leak repair",
            "price": 20000,
            "location": "Ikeja, Lagos",
            "status": "completed",
            "created_at": datetime(2024, 5, 1, 11, 0, tzinfo=timezone.utc),
        }
    ]
    ratings = [
        {"job_id": "job-1", "ratee_id": USER_ID, "score": 5},
        {"job_id": "job-2", "ratee_id": USER_ID, "score": 4},
        {"job_id": "job-3", "ratee_id": USER_ID, "score": 5},
    ]
    disputes = [
        {"client_id": USER_ID, "provider_id": OTHER_ID, "status": "open"},
        {"client_id": OTHER_ID, "provider_id": USER_ID, "status": "resolved"},
    ]
    return services, client_jobs, provider_jobs, ratings, disputes


EXPECTED_HAPPY_FACTS = [
    "Chinedu Okafor is a provider on Gigr.",
    "Chinedu Okafor is based in Yaba, Lagos.",
    "Chinedu Okafor works in plumbing, pipe fitting and tiling.",
    "Chinedu Okafor lists Bathroom tiling at 45000 naira within 5 km.",
    "Chinedu Okafor lists Emergency pipe repair at 12000 naira within 7.5 km.",
    "Chinedu Okafor hired a provider for Fix leaking sink at 18000 naira "
    "in Yaba, Lagos (completed, 2024).",
    "Chinedu Okafor hired a provider for Replace bathroom tap at 16000 naira "
    "in Surulere, Lagos (completed, 2024).",
    "Chinedu Okafor hired a provider for Rewire sitting room at 26000 naira "
    "in Yaba, Lagos (in_progress, 2025).",
    "Chinedu Okafor usually budgets around 17000 naira for Plumbing.",
    "Chinedu Okafor has completed 2 jobs as a client and 1 as a provider.",
    "Chinedu Okafor has an average rating of 4.7 from 3 ratings.",
    "Chinedu Okafor has 1 dispute in progress.",
    "Chinedu Okafor has 1 resolved dispute.",
]


def test_full_user_produces_the_expected_sentences():
    services, client_jobs, provider_jobs, ratings, disputes = _happy_rows()
    facts = build_user_facts(
        _profile(),
        services=services,
        client_jobs=client_jobs,
        provider_jobs=provider_jobs,
        ratings=ratings,
        disputes=disputes,
    )
    assert facts == EXPECTED_HAPPY_FACTS


def test_missing_location_and_skills_and_no_jobs_leave_only_the_role_fact():
    profile = {
        "id": USER_ID,
        "display_name": "Bola Ade",
        "role": "client",
        "last_location": "",
        "skills": [],
    }
    assert build_user_facts(profile) == ["Bola Ade is a client on Gigr."]


def test_one_job_in_a_category_is_not_enough_for_a_budget_habit():
    profile = {"id": USER_ID, "display_name": "Bola Ade", "role": "client"}
    client_jobs = [
        {
            "id": "job-1",
            "client_id": USER_ID,
            "title": "Fix tap",
            "price": 12000,
            "category": "Plumbing",
            "status": "completed",
        }
    ]
    assert build_user_facts(profile, client_jobs=client_jobs) == [
        "Bola Ade is a client on Gigr.",
        "Bola Ade has completed 1 job as a client and 0 as a provider.",
    ]


def test_three_jobs_in_a_category_give_the_median_price():
    profile = {"id": USER_ID, "display_name": "Bola Ade", "role": "client"}
    client_jobs = [
        {"client_id": USER_ID, "title": "A", "price": 12000,
         "category": "Plumbing", "status": "completed"},
        {"client_id": USER_ID, "title": "B", "price": 30000,
         "category": "Plumbing", "status": "completed"},
        {"client_id": USER_ID, "title": "C", "price": 18000,
         "category": "Plumbing", "status": "completed"},
    ]
    assert build_user_facts(profile, client_jobs=client_jobs) == [
        "Bola Ade is a client on Gigr.",
        "Bola Ade usually budgets around 18000 naira for Plumbing.",
        "Bola Ade has completed 3 jobs as a client and 0 as a provider.",
    ]


def test_identical_sentences_appear_once():
    profile = {"id": USER_ID, "display_name": "Bola Ade", "role": "client"}
    services = [
        _service(id="svc-1"),
        _service(id="svc-2"),
    ]
    assert build_user_facts(profile, services=services) == [
        "Bola Ade is a client on Gigr.",
        "Bola Ade lists Emergency pipe repair at 12000 naira within 7.5 km.",
    ]


def test_row_order_does_not_change_the_list():
    services, client_jobs, provider_jobs, ratings, disputes = _happy_rows()
    forwards = build_user_facts(
        _profile(),
        services=services,
        client_jobs=client_jobs,
        provider_jobs=provider_jobs,
        ratings=ratings,
        disputes=disputes,
    )
    backwards = build_user_facts(
        _profile(),
        services=list(reversed(services)),
        client_jobs=list(reversed(client_jobs)),
        provider_jobs=list(reversed(provider_jobs)),
        ratings=list(reversed(ratings)),
        disputes=list(reversed(disputes)),
    )
    assert backwards == forwards
    assert backwards == EXPECTED_HAPPY_FACTS


def test_fact_identity_is_stable_and_follows_the_text():
    fact, stable_key = build_fact_identity("Bola Ade is based in Yaba.", "job-1")
    assert fact == "Bola Ade is based in Yaba."
    assert re.fullmatch(r"[0-9a-f]{16}", stable_key)
    assert build_fact_identity("Bola Ade is based in Yaba.", "job-1") == (
        fact,
        stable_key,
    )
    assert build_fact_identity("Bola Ade is based in Ikeja.", "job-1")[1] != stable_key
    assert build_fact_identity("Bola Ade is based in Yaba.", "job-2")[1] != stable_key
    assert build_fact_identity("Bola Ade is based in Yaba.")[1] != stable_key
    with pytest.raises(ValueError):
        build_fact_identity("   ")


def test_rows_belonging_to_another_user_produce_no_facts():
    profile = {"id": USER_ID, "display_name": "Bola Ade", "role": "client"}
    services = [_service(provider_id=OTHER_ID)]
    client_jobs = [_client_job(client_id=OTHER_ID)]
    ratings = [{"ratee_id": OTHER_ID, "score": 5}]
    disputes = [
        {"client_id": OTHER_ID, "provider_id": PROVIDER_ID, "status": "open"}
    ]
    assert build_user_facts(
        profile,
        services=services,
        client_jobs=client_jobs,
        ratings=ratings,
        disputes=disputes,
    ) == ["Bola Ade is a client on Gigr."]


def test_a_bidirectional_override_cannot_reach_the_sentence():
    profile = {
        "id": USER_ID,
        "display_name": "Bola\u202e Ade",
        "role": "client",
    }
    assert build_user_facts(profile) == ["Bola Ade is a client on Gigr."]


def test_a_single_skill_string_is_not_split_into_letters():
    profile = {"id": USER_ID, "display_name": "Bola Ade", "skills": "plumbing"}
    assert build_user_facts(profile) == ["Bola Ade works in plumbing."]


def test_zero_and_missing_prices_produce_no_price_sentence():
    profile = {"id": USER_ID, "display_name": "Bola Ade", "role": "provider"}
    services = [
        _service(id="svc-zero", title="Free consult", price=0),
        _service(id="svc-null", title="No price yet", price=None),
    ]
    assert build_user_facts(profile, services=services) == [
        "Bola Ade is a provider on Gigr."
    ]


def test_a_fractional_naira_price_is_not_rounded_into_a_sentence():
    profile = {"id": USER_ID, "display_name": "Bola Ade", "role": "provider"}
    services = [
        _service(id="svc-cents", title="Tap repair", price=Decimal("12000.50"))
    ]
    assert build_user_facts(profile, services=services) == [
        "Bola Ade is a provider on Gigr."
    ]


def test_a_category_id_is_never_printed_as_a_category_name():
    profile = {"id": USER_ID, "display_name": "Bola Ade"}
    client_jobs = [
        {"client_id": USER_ID, "price": 12000, "category": CATEGORY_ID,
         "status": "open"},
        {"client_id": USER_ID, "price": 18000, "category": CATEGORY_ID,
         "status": "open"},
    ]
    assert build_user_facts(profile, client_jobs=client_jobs) == []


def test_a_job_without_a_provider_is_not_a_hiring():
    profile = {"id": USER_ID, "display_name": "Bola Ade"}
    client_jobs = [_client_job(provider_id=None)]
    assert build_user_facts(profile, client_jobs=client_jobs) == [
        "Bola Ade has completed 1 job as a client and 0 as a provider."
    ]


def test_a_missing_row_in_a_collection_is_ignored():
    profile = {"id": USER_ID, "display_name": "Bola Ade", "role": "client"}
    assert build_user_facts(
        profile,
        services=[None],
        client_jobs=[None],
        ratings=[None],
        disputes=[None],
    ) == ["Bola Ade is a client on Gigr."]


def test_a_geometry_value_is_not_a_place_name():
    profile = {
        "id": USER_ID,
        "display_name": "Bola Ade",
        "role": "client",
        "last_location": object(),
    }
    assert build_user_facts(profile) == ["Bola Ade is a client on Gigr."]


def test_a_service_without_a_usable_radius_produces_no_listing():
    profile = {"id": USER_ID, "display_name": "Bola Ade", "role": "provider"}
    services = [
        _service(id="svc-zero", title="Tap repair", radius_km=0),
        _service(id="svc-null", title="Sink repair", radius_km=None),
    ]
    assert build_user_facts(profile, services=services) == [
        "Bola Ade is a provider on Gigr."
    ]


def test_a_job_missing_a_sentence_field_produces_no_hiring_sentence():
    profile = {"id": USER_ID, "display_name": "Bola Ade"}
    client_jobs = [
        _client_job(id="job-1", location=None, category=None),
        _client_job(id="job-2", status="", category=None),
        _client_job(id="job-3", created_at=None, category=None),
    ]
    assert build_user_facts(profile, client_jobs=client_jobs) == [
        "Bola Ade has completed 2 jobs as a client and 0 as a provider."
    ]


def test_a_profile_without_a_name_produces_nothing():
    profile = {
        "id": USER_ID,
        "display_name": "  ",
        "role": "client",
        "last_location": "Yaba, Lagos",
    }
    assert build_user_facts(profile, services=[_service()]) == []


def test_a_non_mapping_profile_is_rejected():
    with pytest.raises(TypeError):
        build_user_facts([("display_name", "Bola Ade")])


def test_a_job_with_an_iso_text_date_still_produces_its_fact():
    """Rows read as plain mappings carry created_at as text, not a datetime.

    The backfill reads rows that way, so an ISO-8601 string must yield the same
    sentence an ORM datetime would. Text that is not a date yields no sentence.
    """
    profile = {"id": USER_ID, "display_name": "Bola Ade", "role": "client"}
    job = {
        "id": "job-1",
        "client_id": USER_ID,
        "provider_id": "provider-1",
        "title": "leaking pipe",
        "price": 15000,
        "location": "Akoka",
        "status": "completed",
        "created_at": "2026-03-14T10:00:00Z",
    }
    facts = build_user_facts(profile, client_jobs=[job])
    assert (
        "Bola Ade hired a provider for leaking pipe at 15000 naira "
        "in Akoka (completed, 2026)."
    ) in facts

    job["created_at"] = "not a date"
    facts_without_date = build_user_facts(profile, client_jobs=[job])
    assert not any("hired a provider" in fact for fact in facts_without_date)
