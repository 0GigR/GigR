"""Message facts are counts, titles, a dispute flag and a date.

Every assertion here is chosen so that a plausible bug in the module breaks it:
a count that includes duplicate rows, a contract-room count that counts every
conversation, a job sentence without a title, a dispute fact that is not tied to
a discussed job, or a date that is not the newest one.
"""

from datetime import datetime, timedelta, timezone

import pytest

from app.services.message_fact_service import build_message_facts

PROFILE = {"display_name": "Bola Ade"}


def _thread(**overrides):
    thread = {
        "job_id": "job-1",
        "job_title": "Fix leaking sink",
        "applicant_id": None,
        "sent_count": 2,
        "last_message_at": datetime(2026, 3, 12, 9, 30, tzinfo=timezone.utc),
        "disputed": False,
    }
    thread.update(overrides)
    return thread


def test_two_threads_on_one_job_are_two_conversations():
    threads = [
        _thread(job_id="job-1", applicant_id=None),
        _thread(job_id="job-1", applicant_id="applicant-7"),
    ]
    facts = build_message_facts(PROFILE, threads=threads)
    assert "Bola Ade has 2 message conversations on Gigr." in facts


def test_duplicate_rows_for_one_conversation_count_once():
    threads = [
        _thread(job_id="job-1", applicant_id="applicant-7", sent_count=1),
        _thread(job_id="job-1", applicant_id="applicant-7", sent_count=3),
    ]
    facts = build_message_facts(PROFILE, threads=threads)
    assert "Bola Ade has 1 message conversation on Gigr." in facts
    # The larger count wins, so the same conversation seen twice is not summed.
    assert "Bola Ade has sent 3 messages." in facts


def test_contract_rooms_count_only_the_threads_without_an_applicant():
    threads = [
        _thread(job_id="job-1", applicant_id=None),
        _thread(job_id="job-2", applicant_id="applicant-7"),
        _thread(job_id="job-3", applicant_id="applicant-8"),
    ]
    facts = build_message_facts(PROFILE, threads=threads)
    assert "Bola Ade has 1 contract room conversation." in facts


def test_no_contract_room_sentence_when_every_thread_has_an_applicant():
    facts = build_message_facts(
        PROFILE, threads=[_thread(applicant_id="applicant-7")]
    )
    assert not any("contract room" in fact for fact in facts)


def test_sent_messages_are_the_users_own_sends_not_every_message():
    threads = [
        _thread(job_id="job-1", sent_count=1),
        _thread(job_id="job-2", sent_count=0),
    ]
    facts = build_message_facts(PROFILE, threads=threads)
    assert "Bola Ade has sent 1 message." in facts
    assert "Bola Ade has 2 message conversations on Gigr." in facts


def test_a_conversation_the_user_never_wrote_in_produces_no_message_count():
    facts = build_message_facts(PROFILE, threads=[_thread(sent_count=0)])
    assert not any(fact.startswith("Bola Ade has sent") for fact in facts)


def test_one_sentence_per_distinct_job_sorted_by_title():
    threads = [
        _thread(job_id="job-1", job_title="Wall painting"),
        _thread(job_id="job-2", job_title="Gas cooker repair"),
        _thread(job_id="job-3", job_title="Gas cooker repair"),
    ]
    facts = build_message_facts(PROFILE, threads=threads)
    assert [
        fact for fact in facts if fact.startswith("Bola Ade has messaged about")
    ] == [
        "Bola Ade has messaged about Gas cooker repair.",
        "Bola Ade has messaged about Wall painting.",
    ]


def test_a_job_without_a_title_produces_no_job_sentence_but_still_counts():
    threads = [
        _thread(job_id="job-1", job_title=None),
        _thread(job_id="job-2", job_title="   "),
    ]
    facts = build_message_facts(PROFILE, threads=threads)
    assert "Bola Ade has 2 message conversations on Gigr." in facts
    assert not any("messaged about" in fact for fact in facts)


def test_a_geometry_value_is_not_a_job_title():
    """A PostGIS value is not text and must not be rendered as a title."""
    try:
        from geoalchemy2.elements import WKBElement
    except ImportError:  # pragma: no cover - geoalchemy2 is a hard dependency
        pytest.skip("geoalchemy2 is not installed")

    point = WKBElement(
        bytes.fromhex("0101000020E61000000000000000001C400000000000001040"),
        srid=4326,
    )
    threads = [_thread(job_id="job-1", job_title=point)]
    facts = build_message_facts(PROFILE, threads=threads)
    assert not any("messaged about" in fact for fact in facts)


def test_a_dispute_on_a_discussed_job_produces_one_sentence():
    threads = [
        _thread(job_id="job-1", disputed=True),
        _thread(job_id="job-2", disputed=True),
        _thread(job_id="job-3", disputed=False),
    ]
    facts = build_message_facts(PROFILE, threads=threads)
    assert [
        fact for fact in facts if fact.startswith("A dispute was raised")
    ] == ["A dispute was raised on a job Bola Ade messaged about."]


def test_no_dispute_sentence_without_a_disputed_job():
    facts = build_message_facts(PROFILE, threads=[_thread(disputed=False)])
    assert not any("dispute" in fact for fact in facts)


def test_last_active_uses_the_newest_message_date_in_utc():
    threads = [
        _thread(
            job_id="job-1",
            last_message_at=datetime(2026, 3, 12, 9, 30, tzinfo=timezone.utc),
        ),
        _thread(
            job_id="job-2",
            last_message_at=datetime(2026, 9, 1, 23, 30, tzinfo=timezone.utc),
        ),
    ]
    facts = build_message_facts(PROFILE, threads=threads)
    assert "Bola Ade was last active in messages on 1 September 2026." in facts


def test_a_time_zone_offset_is_reduced_to_the_utc_date():
    """23:30 in Lagos on 1 September is 22:30 UTC on the same day, but 00:30 in
    Lagos on 2 September is still 23:30 UTC on 1 September, and the sentence
    must say the date the stored timestamp actually falls on."""
    threads = [
        _thread(
            job_id="job-1",
            last_message_at=datetime(
                2026, 9, 2, 0, 30, tzinfo=timezone(timedelta(hours=1))
            ),
        )
    ]
    facts = build_message_facts(PROFILE, threads=threads)
    assert "Bola Ade was last active in messages on 1 September 2026." in facts


def test_no_recency_sentence_without_a_readable_timestamp():
    facts = build_message_facts(
        PROFILE, threads=[_thread(last_message_at=None)]
    )
    assert "Bola Ade has 1 message conversation on Gigr." in facts
    assert not any("last active" in fact for fact in facts)


def test_a_profile_without_a_display_name_produces_nothing():
    assert build_message_facts({"display_name": "   "}, threads=[_thread()]) == []
    assert build_message_facts({}, threads=[_thread()]) == []


def test_threads_without_a_job_identifier_are_ignored():
    threads = [_thread(job_id=None), _thread(job_id=""), _thread(job_id="job-9")]
    facts = build_message_facts(PROFILE, threads=threads)
    assert "Bola Ade has 1 message conversation on Gigr." in facts


def test_no_threads_means_no_facts():
    assert build_message_facts(PROFILE) == []
    assert build_message_facts(PROFILE, threads=[]) == []


def test_row_order_does_not_change_the_list():
    threads = [
        _thread(job_id="job-1", job_title="Wall painting", applicant_id=None),
        _thread(job_id="job-2", job_title="Gas cooker repair", applicant_id="a-1"),
        _thread(job_id="job-3", job_title="Roof repair", applicant_id="a-2"),
    ]
    forwards = build_message_facts(PROFILE, threads=threads)
    backwards = build_message_facts(PROFILE, threads=list(reversed(threads)))
    assert backwards == forwards


def test_non_mapping_rows_are_ignored():
    facts = build_message_facts(PROFILE, threads=[_thread(), "not a row", 42])
    assert "Bola Ade has 1 message conversation on Gigr." in facts


def test_profile_must_be_a_mapping():
    with pytest.raises(TypeError):
        build_message_facts(["not", "a", "mapping"], threads=[_thread()])
