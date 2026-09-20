"""Shared free-text search helpers.

Naive full-phrase ILIKE matching fails on real queries: searching
"samsung repair guy" would never match a service titled "Samsung phone
repairs" because the whole phrase isn't a substring of the title. These
helpers tokenize the query into meaningful words so any-word matching +
relevance ranking works.
"""
import re

# Common filler words that carry no search signal.
SEARCH_STOPWORDS = {
    "a", "an", "the", "for", "to", "me", "my", "i", "someone", "somebody",
    "guy", "person", "people", "who", "can", "will", "need", "needs", "want",
    "wants", "find", "get", "hire", "some", "any", "and", "or", "of", "with",
    "please", "help", "looking", "look", "service", "services", "job", "jobs",
    "near", "around", "here", "there", "that", "this", "is", "are", "do",
    "does", "you", "your", "am", "in", "on", "at", "good", "best", "great",
}


def tokenize_query(query: str) -> list[str]:
    """Split a free-text query into significant lowercase tokens.

    Drops stopwords and tokens shorter than 3 chars. Returns [] if nothing
    meaningful remains (caller should fall back to raw-phrase matching).
    """
    words = re.split(r"\W+", (query or "").lower())
    return [w for w in words if len(w) >= 3 and w not in SEARCH_STOPWORDS]


def compact(text: str) -> str:
    """Lowercase and keep only alphanumerics.

    Word-spanning queries were failing badly: "woodworks" did not match a listing
    titled "Wood Works, Furniture", because plain substring matching cannot see
    across the space. Comparing both sides with their separators removed fixes
    that class of query, and also makes "woodwork" match "woodworks" for free.
    """
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def relevance_score(tokens: list[str], *fields: str) -> int:
    """Count how many query tokens appear across the given text fields.

    Checks the raw text and the separator-stripped text, so scoring agrees with
    the database's matching.
    """
    hay = " ".join(f or "" for f in fields).lower()
    compact_hay = compact(hay)
    score = 0
    for token in tokens:
        if token in hay or (compact(token) and compact(token) in compact_hay):
            score += 1
    return score
