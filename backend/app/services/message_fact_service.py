"""Render the conversations one user is part of as short factual sentences.

Pure, like ``user_fact_service``: it imports no database driver, no ORM model and
no session. The caller groups the message rows into conversations and passes
mappings in; these functions only decide which sentences the rows can support
and how they read.

A conversation is one (job_id, applicant_id) pair. ``applicant_id`` is NULL for a
contract room, so the two fields together name a thread without ambiguity. The
caller passes one mapping per conversation:

    job_id           identifier of the job the conversation is on (required)
    job_title        the job's title, when the row carries one
    applicant_id     the applicant the thread is with, None for a contract room
    sent_count       how many messages the user sent in that conversation
    last_message_at  timestamp of the conversation's most recent message
    disputed         True when a dispute exists on that job

Every sentence here is derived from a column: a count of rows, a job title, a
boolean that a dispute exists on the job, or a timestamp. Nothing is summarised
from the text of a message. A message-derived fact that these columns cannot
support is not produced, which is why there is no sentence about what was said,
only about the shape of the exchange.

``job_title`` decides whether the job can be named at all: a job with no title
produces no per-job sentence, and a job row that is missing produces no sentence
either.
"""

from collections.abc import Iterable, Iterator, Mapping
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
from typing import Any

from .user_fact_service import clean_fact_text

# A date is rendered from these names rather than strftime("%B"), whose output
# follows the process locale and would change the stored sentence per machine.
_MONTH_NAMES = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)


def build_message_facts(
    profile: Mapping[str, Any], *, threads: Iterable[Any] = ()
) -> list[str]:
    """Return the fact sentences these conversations support, in a stable order.

    ``profile`` is the user row (or an equivalent mapping) and only
    ``display_name`` is read. ``threads`` are the conversation mappings described
    in the module docstring; duplicates of one conversation collapse onto the
    same sentence.

    The order is fixed: conversation count, messages sent, contract rooms, one
    sentence per job named, disputes, most recent activity. Within one group the
    rows are sorted by their own values, never by arrival order, so the same rows
    in any order produce the same list. Identical sentences appear once.

    Raises TypeError when profile is not a mapping. A profile without a usable
    display_name produces an empty list, because no sentence can name the user.
    """
    if not isinstance(profile, Mapping):
        raise TypeError("profile must be a mapping of user fields")

    display_name = clean_fact_text(profile.get("display_name"))
    if not display_name:
        return []

    conversations = _conversations(threads)
    if not conversations:
        return []

    facts: list[str] = []
    facts.extend(_count_facts(display_name, conversations))
    facts.extend(_job_facts(display_name, conversations))
    facts.extend(_dispute_facts(display_name, conversations))
    facts.extend(_recency_facts(display_name, conversations))
    return _deduplicate(facts)


def _conversations(threads: Iterable[Any]) -> dict[tuple[str, str], dict[str, Any]]:
    """Collapse the thread mappings onto one entry per (job_id, applicant_id).

    A conversation is identified by its job and its applicant. Two mappings for
    the same conversation are merged rather than counted twice: the larger sent
    count and the newer timestamp win, and a dispute on either is kept.
    """
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for row in _mappings(threads):
        job_identity = _identifier(row.get("job_id"))
        if not job_identity:
            continue
        applicant_identity = _identifier(row.get("applicant_id")) or ""
        key = (job_identity, applicant_identity)

        entry = grouped.setdefault(
            key,
            {
                "job_id": job_identity,
                "job_title": "",
                "applicant_id": applicant_identity,
                "sent_count": 0,
                "last_message_at": None,
                "disputed": False,
            },
        )
        title = clean_fact_text(row.get("job_title"))
        if title:
            entry["job_title"] = title
        sent = _count(row.get("sent_count"))
        if sent > entry["sent_count"]:
            entry["sent_count"] = sent
        newest = _timestamp(row.get("last_message_at"))
        if newest is not None and (
            entry["last_message_at"] is None
            or newest > entry["last_message_at"]
        ):
            entry["last_message_at"] = newest
        if row.get("disputed") is True:
            entry["disputed"] = True
    return grouped


def _count_facts(
    display_name: str, conversations: Mapping[tuple[str, str], dict[str, Any]]
) -> list[str]:
    """How many conversations the user is part of, and how much they wrote."""
    facts: list[str] = []
    total = len(conversations)
    noun = "conversation" if total == 1 else "conversations"
    facts.append(f"{display_name} has {total} message {noun} on Gigr.")

    sent = sum(entry["sent_count"] for entry in conversations.values())
    if sent:
        noun = "message" if sent == 1 else "messages"
        facts.append(f"{display_name} has sent {sent} {noun}.")

    rooms = sum(
        1 for entry in conversations.values() if not entry["applicant_id"]
    )
    if rooms:
        noun = "conversation" if rooms == 1 else "conversations"
        facts.append(f"{display_name} has {rooms} contract room {noun}.")
    return facts


def _job_facts(
    display_name: str, conversations: Mapping[tuple[str, str], dict[str, Any]]
) -> list[str]:
    """One sentence per distinct job that carries a usable title."""
    titles: dict[str, str] = {}
    for entry in conversations.values():
        title = entry["job_title"]
        job_id = entry["job_id"]
        if title and job_id not in titles:
            titles[job_id] = title
    rendered = sorted(
        titles.items(), key=lambda item: (item[1].casefold(), item[0])
    )
    return [
        f"{display_name} has messaged about {title}." for _, title in rendered
    ]


def _dispute_facts(
    display_name: str, conversations: Mapping[tuple[str, str], dict[str, Any]]
) -> list[str]:
    """One sentence when a job the user discussed carries a dispute.

    The row says a dispute exists on that job; it does not say in which order
    the messages and the dispute happened, so the sentence claims no order.
    """
    disputed_jobs = {
        entry["job_id"] for entry in conversations.values() if entry["disputed"]
    }
    if not disputed_jobs:
        return []
    return [f"A dispute was raised on a job {display_name} messaged about."]


def _recency_facts(
    display_name: str, conversations: Mapping[tuple[str, str], dict[str, Any]]
) -> list[str]:
    """The date of the user's most recent message, from the newest timestamp."""
    newest = None
    for entry in conversations.values():
        stamp = entry["last_message_at"]
        if stamp is not None and (newest is None or stamp > newest):
            newest = stamp
    when = _fact_date(newest)
    if not when:
        return []
    return [f"{display_name} was last active in messages on {when}."]


def _fact_date(value: Any) -> str:
    """Return "5 October 2026" for a date or datetime, or "" when unreadable.

    A timestamp is reduced to its UTC date: message times are stored with a time
    zone, and the sentence carries a date, so the conversion has to be named
    rather than left to the machine's local zone. A naive timestamp is used as
    given, which for a date-only row is already the date the caller meant.
    """
    moment = _timestamp(value)
    if moment is None:
        return ""
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc)
    return f"{moment.day} {_MONTH_NAMES[moment.month - 1]} {moment.year}"


def _timestamp(value: Any) -> datetime | None:
    """Return value as a datetime, or None when it is not one.

    Rows reach this module both as ORM objects (already datetimes) and as plain
    mappings (ISO-8601 text), the same two shapes the user fact extractor reads.
    """
    if isinstance(value, datetime):
        return value
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
    if isinstance(value, str):
        return _timestamp_from_text(value)
    return None


def _timestamp_from_text(value: str) -> datetime | None:
    """Parse ISO-8601 date or datetime text; anything else yields None."""
    text = value.strip()
    if not text:
        return None
    candidate = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
    for parser in (datetime.fromisoformat, date.fromisoformat):
        try:
            return parser(candidate)
        except ValueError:
            continue
    return None


def _count(value: Any) -> int:
    """Return value as a non-negative count, or 0 when it is not one."""
    if value is None or isinstance(value, bool):
        return 0
    try:
        number = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return 0
    if not number.is_finite() or number <= 0:
        return 0
    return int(number)


def _identifier(value: Any) -> str:
    """Return a non-empty identifier as text, or "" when there is none."""
    if value is None:
        return ""
    text = str(value).strip()
    return text


def _mappings(rows: Iterable[Any]) -> Iterator[Mapping[str, Any]]:
    """Yield only the mapping rows; anything else in the collection is ignored."""
    if rows is None:
        return
    for row in rows:
        if isinstance(row, Mapping):
            yield row


def _deduplicate(facts: list[str]) -> list[str]:
    """Keep the first occurrence of each sentence, preserving the order."""
    seen: set[str] = set()
    unique: list[str] = []
    for fact in facts:
        if fact not in seen:
            seen.add(fact)
            unique.append(fact)
    return unique
