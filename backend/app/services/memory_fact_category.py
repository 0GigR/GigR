"""Assign a display category to one recalled memory sentence.

Walrus Memory stores text, not categories: a recall returns the sentences the
fact writers produced, ranked by similarity. This module owns the one
classification rule the memory page needs, so every client gets the same
grouping and the rule is tested without a database or a model.

The rules are deterministic on purpose. Gigr writes facts from a fixed set of
sentence templates (``user_fact_service``, ``message_fact_service`` and
``event_fact_service``), so matching those templates is exact for the facts the
product produces. It costs no network call, adds no latency to the page, and
never sends a user's memory text to an AI provider. A sentence that matches no
known template becomes ``other`` instead of being guessed at: when free-form
facts are added later, they land in their own section rather than in a wrong
one.

Categories are stable identifiers, never display text. The client owns the
labels and their order, which is what lets the wording change without changing
the contract.
"""

from __future__ import annotations

from typing import Final

CATEGORY_ABOUT: Final = "about"
CATEGORY_JOBS: Final = "jobs"
CATEGORY_SERVICES: Final = "services"
CATEGORY_MESSAGES: Final = "messages"
CATEGORY_RATINGS: Final = "ratings"
CATEGORY_OTHER: Final = "other"

# Display order is the client's decision; this tuple names every category and is
# what a client can rely on. A new category is added here once and the client
# renders it when it appears.
CATEGORY_ORDER: Final[tuple[str, ...]] = (
    CATEGORY_ABOUT,
    CATEGORY_JOBS,
    CATEGORY_SERVICES,
    CATEGORY_MESSAGES,
    CATEGORY_RATINGS,
    CATEGORY_OTHER,
)

# Ordered rules: the first category whose marker appears in the sentence wins.
# The ratings category covers ratings and disputes and comes first because a
# dispute sentence can mention messages ("A dispute was raised on a job ...
# messaged about"), and a job sentence can mention a dispute. The other rules
# follow from most specific phrase to least; "received a 5 star rating" needs no
# special place, only a place after the dispute rule.
_RULES: Final[tuple[tuple[str, tuple[str, ...]], ...]] = (
    (
        CATEGORY_RATINGS,
        ("dispute", "average rating", "star rating"),
    ),
    (
        CATEGORY_JOBS,
        (
            "hired a provider",
            "has completed",
            "posted a job for",
            "was hired for",
            "job in progress",
            "jobs in progress",
            # The event writer's completed sentences say who completed the job:
            # "Kosi completed Fix sink as a provider." The trailing role keeps a
            # message title that merely contains "completed" from matching.
            " as a client.",
            " as a provider.",
        ),
    ),
    (
        CATEGORY_SERVICES,
        (" lists ", "usually budgets around"),
    ),
    (
        CATEGORY_MESSAGES,
        (
            "has messaged about",
            "message conversation",
            "message conversations",
            "contract room",
            "has sent ",
            "last active in messages",
        ),
    ),
    (
        CATEGORY_ABOUT,
        (" is based in ", " works in "),
    ),
)


def categorize_fact(text: str) -> str:
    """Return the category of one fact sentence, or ``other`` when unknown.

    Matching is case-insensitive and substring-based because the sentence
    templates put a user's display name and a free-form title in the middle,
    while the marker phrase around them is fixed. A blank string is ``other``: a
    category must never be invented for text that is not a fact.

    Raises TypeError when text is not a string, which is a programming error at
    the call site, not a fact to classify.
    """
    if not isinstance(text, str):
        raise TypeError("categorize_fact requires the fact text as a string")
    lowered = text.casefold()
    for category, markers in _RULES:
        if any(marker in lowered for marker in markers):
            return category
    return CATEGORY_OTHER
