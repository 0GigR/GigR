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


def relevance_score(tokens: list[str], *fields: str) -> int:
    """Count how many query tokens appear across the given text fields."""
    hay = " ".join(f or "" for f in fields).lower()
    return sum(1 for t in tokens if t in hay)
