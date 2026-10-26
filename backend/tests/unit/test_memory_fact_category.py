"""Unit tests for the fact category rule.

No database, no network and no model. The sentences here are the exact shapes
the three fact writers produce, plus the tricky ones: a message fact whose job
title contains "Post a job", and a dispute fact that also says "messaged
about". Those are the cases where a careless marker or rule order would put a
sentence in the wrong section.
"""

from __future__ import annotations

import pytest

from app.services.memory_fact_category import (
    CATEGORY_ABOUT,
    CATEGORY_JOBS,
    CATEGORY_MESSAGES,
    CATEGORY_OTHER,
    CATEGORY_RATINGS,
    CATEGORY_SERVICES,
    categorize_fact,
)


def test_a_profile_sentence_is_about_the_user():
    assert categorize_fact("Bola Ade is based in Ihiagwa.") == CATEGORY_ABOUT
    assert (
        categorize_fact("Bola Ade works in plumbing and tiling.") == CATEGORY_ABOUT
    )


def test_a_job_sentence_is_a_job():
    """Every job template, including the one whose title carries a colon."""
    for sentence in (
        "Bola Ade hired a provider for Fix sink at 8000 naira (completed, 2026).",
        "Bola Ade hired a provider for Fix sink at 8000 naira in Yaba "
        "(requested, 2026).",
        "Bola Ade has completed 9 jobs as a client and 3 as a provider.",
        "Bola Ade has 2 jobs in progress.",
        "Bola Ade posted a job for Fix sink.",
        "Bola Ade was hired for Fix sink.",
        "Bola Ade completed Fix sink as a provider.",
    ):
        assert categorize_fact(sentence) == CATEGORY_JOBS, sentence


def test_a_listing_or_a_budget_sentence_is_a_service():
    assert (
        categorize_fact("Bola Ade lists Live listing at 12000 naira within 7.5 km.")
        == CATEGORY_SERVICES
    )
    assert (
        categorize_fact("Bola Ade usually budgets around 16000 naira for Plumbing.")
        == CATEGORY_SERVICES
    )


def test_a_message_or_activity_sentence_is_a_message():
    for sentence in (
        "Bola Ade has 20 message conversations on Gigr.",
        "Bola Ade has 1 message conversation on Gigr.",
        "Bola Ade has sent 80 messages.",
        "Bola Ade has 17 contract room conversations.",
        "Bola Ade has messaged about Fix sink.",
        "Bola Ade was last active in messages on 25 October 2026.",
        "Bola Ade has messaged about Post a job: fix my sink.",
        "Bola Ade has messaged about Request for: Masseuse - Massage sessions.",
    ):
        assert categorize_fact(sentence) == CATEGORY_MESSAGES, sentence


def test_a_rating_or_a_dispute_sentence_is_ratings():
    """A dispute sentence mentions messages, so the dispute marker must win."""
    assert (
        categorize_fact("Bola Ade has an average rating of 4.0 from 3 ratings.")
        == CATEGORY_RATINGS
    )
    assert categorize_fact("Bola Ade received a 5 star rating.") == CATEGORY_RATINGS
    assert (
        categorize_fact("Bola Ade had a dispute resolved.") == CATEGORY_RATINGS
    )
    assert categorize_fact("Bola Ade has 1 resolved dispute.") == CATEGORY_RATINGS
    assert (
        categorize_fact("A dispute was raised on a job Bola Ade messaged about.")
        == CATEGORY_RATINGS
    )


def test_an_unrecognised_sentence_is_other_and_is_not_guessed():
    """A mirrored key and a free-form sentence have no template to match.

    Putting either in a real section would claim a classification the product
    cannot support, so both stay in Other.
    """
    assert categorize_fact('last_search: "plumber"') == CATEGORY_OTHER
    assert categorize_fact("Kosi hired a plumber for 15000 naira") == CATEGORY_OTHER
    assert categorize_fact("") == CATEGORY_OTHER


def test_a_non_string_raises_instead_of_becoming_a_category():
    with pytest.raises(TypeError):
        categorize_fact(None)  # type: ignore[arg-type]
