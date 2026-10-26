"""Render plain user rows as short factual sentences about one user.

The module is pure. It imports no database driver, no ORM model and no session:
the caller gathers the rows and passes mappings in, and these functions only
decide which sentences the data can support and how they read.

A sentence is produced only when every value it needs is present and
meaningful. Nothing is guessed: no placeholder words, no currency symbol, and no
rounding of a source value that would change what it says. A row whose price is
missing, zero, or not a whole naira amount produces no sentence.

One field needs care at the call site, because the database does not store it as
text:

- User.last_location and Job.location are PostGIS points. A sentence needs a
  place name, so pass the name under the key "last_location" or "location" (for
  example the city the point sits in). A geometry value is not a place name and
  produces no sentence.

No sentence names a marketplace side. Gigr has no fixed sides: the same person
can hire and be hired, and switching between the two is normal, so calling
someone "a client" or "a provider" would state something the product does not
have. Every sentence therefore describes what the rows show the user did, never
which side they are on. ``users.role`` is an authorization value and is not read
here at all.
"""

import hashlib
import re
from collections.abc import Iterable, Iterator, Mapping
from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Any

# A sentence is only ever written for the completed state; the other job states
# (open, assigned, funded, in_progress, cancelled, disputed) are not counted.
_COMPLETED_JOB_STATUS = "completed"

# Two jobs in one category are the minimum that says anything about a habit.
_MIN_BUDGET_JOBS = 2

# Characters that would let a value rewrite the sentence it is placed in
# (bidirectional overrides, zero-width marks, C0 and C1 controls). Numeric
# escapes keep this file ASCII.
_UNSAFE_CHARACTERS = dict.fromkeys(
    [
        *range(0x00, 0x20),
        0x7F,
        *range(0x80, 0xA0),
        0x200B,
        0x200E,
        0x200F,
        *range(0x202A, 0x202F),
        *range(0x2066, 0x206A),
        0xFEFF,
    ]
)

# category_id is a foreign key; printing it would put a primary key in a
# sentence a person reads.
_UUID_PATTERN = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)

_KEY_HEX_LENGTH = 16
_UNIT_SEPARATOR = "\x1f"

# Last resort for date text the datetime parsers reject: a leading year.
_ISO_YEAR_PATTERN = re.compile(r"^(\d{4})-\d{2}-\d{2}")


def build_user_facts(
    profile: Mapping[str, Any],
    *,
    services: Iterable[Any] = (),
    client_jobs: Iterable[Any] = (),
    provider_jobs: Iterable[Any] = (),
    ratings: Iterable[Any] = (),
    disputes: Iterable[Any] = (),
) -> list[str]:
    """Return the fact sentences the given rows support, in a stable order.

    profile is the user row (or an equivalent mapping): id, display_name,
    last_location, skills. services are the user's service listings,
    client_jobs the jobs where the user is the client, provider_jobs the jobs
    where the user is the provider, ratings the ratings the user received, and
    disputes the disputes the user is part of. Every collection may be empty.

    The order is fixed: location, skills, service listings, jobs hired,
    category budgets, completed counts, ratings, disputes. Within one group the
    rows are sorted by their own values, never by arrival order, so the same
    rows in any order produce the same list. Identical sentences appear once.

    Raises TypeError when profile is not a mapping. A profile without a usable
    display_name produces an empty list, because no sentence can name the user.
    """
    if not isinstance(profile, Mapping):
        raise TypeError("profile must be a mapping of user fields")

    display_name = clean_fact_text(profile.get("display_name"))
    if not display_name:
        return []

    user_id = profile.get("id")
    facts: list[str] = []
    facts.extend(_location_facts(display_name, profile.get("last_location")))
    facts.extend(_skills_facts(display_name, profile.get("skills")))
    facts.extend(_service_facts(display_name, services, user_id))
    facts.extend(_job_facts(display_name, client_jobs, user_id))
    facts.extend(_budget_facts(display_name, client_jobs, user_id))
    facts.extend(
        _completed_facts(display_name, client_jobs, provider_jobs, user_id)
    )
    facts.extend(_rating_facts(display_name, ratings, user_id))
    facts.extend(_dispute_facts(display_name, disputes, user_id))
    return _deduplicate(facts)


def build_fact_identity(
    fact_text: str, source_id: Any = None
) -> tuple[str, str]:
    """Return (fact_text, stable_key) for one fact.

    stable_key is the first 16 hex characters of the SHA-256 of the sentence,
    followed by the source row id when one is given, so the same sentence about
    the same row keeps its key across runs while a different row or a reworded
    sentence gets a new one. It is not stored anywhere yet.

    Raises ValueError when fact_text is empty or not a string.
    """
    if not isinstance(fact_text, str) or not fact_text.strip():
        raise ValueError("fact_text must be a non-empty string")

    payload = fact_text
    if source_id is not None:
        source_text = str(source_id).strip()
        if source_text:
            payload = fact_text + _UNIT_SEPARATOR + source_text

    stable_key = hashlib.sha256(payload.encode("utf-8")).hexdigest()
    return fact_text, stable_key[:_KEY_HEX_LENGTH]


def clean_fact_text(value: Any) -> str:
    """Return value as one clean line, or "" when it is not usable text.

    Public because every module that renders a fact sentence needs the same
    answer to "is this real text, and is it safe to put in a sentence": the
    message fact builder uses it, and a second implementation there would drift
    from this one. A non-string (a geometry value, a number) is not a place
    name, a title or a status, so it becomes "" and produces no sentence.
    """
    if not isinstance(value, str):
        return ""
    return " ".join(value.split()).translate(_UNSAFE_CHARACTERS)


def whole_naira(value: Any) -> int | None:
    """Return value as a positive whole naira amount, or None.

    Public for the same reason as :func:`clean_fact_text`: the event sentence
    builder quotes a price too, and two price rules would eventually disagree
    about whether 12500.50 can be written down.

    Prices are stored as numeric(10, 2). A fraction of a naira is not rendered,
    because the sentence only carries whole naira; such a row is skipped rather
    than rounded into a price the user never set.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not amount.is_finite():
        return None
    if amount != amount.to_integral_value():
        return None
    whole = int(amount)
    return whole if whole > 0 else None


def _quantity(value: Any) -> str | None:
    """Return value as a positive plain decimal, or None (7.50 -> "7.5")."""
    if value is None or isinstance(value, bool):
        return None
    try:
        quantity = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not quantity.is_finite() or quantity <= 0:
        return None
    if quantity == quantity.to_integral_value():
        return str(int(quantity))
    return format(quantity.normalize(), "f")


def _year(value: Any) -> int | None:
    """Return the year of a date, datetime, ISO-8601 text, or year number."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        year = _year_from_text(value)
    else:
        year = getattr(value, "year", None)
        if year is None and isinstance(value, int):
            year = value
    if not isinstance(year, int):
        return None
    return year if 1 <= year <= 9999 else None


def _year_from_text(value: str) -> int | None:
    """Parse an ISO-8601 date or datetime, returning its year.

    Rows reach this module both as ORM objects (where created_at is already a
    datetime) and as plain mappings (where it is text). Text that does not parse
    yields None rather than a guess, so the sentence is skipped.
    """
    text = value.strip()
    if not text:
        return None
    candidate = text[:-1] + "+00:00" if text.endswith(("Z", "z")) else text
    for parser in (datetime.fromisoformat, date.fromisoformat):
        try:
            return parser(candidate).year
        except ValueError:
            continue
    match = _ISO_YEAR_PATTERN.match(text)
    return int(match.group(1)) if match else None


def _has_identifier(value: Any) -> bool:
    """Return True when value can name a row, meaning a non-empty identifier."""
    if value is None:
        return False
    return bool(str(value).strip())


def _category(value: Any) -> str:
    """Return a category name, or "" for a missing name or a raw identifier."""
    label = clean_fact_text(value)
    return "" if _UUID_PATTERN.match(label) else label


def _relation(row: Mapping[str, Any], key: str, user_id: Any) -> bool | None:
    """True when the row's id matches the user, False when it is someone else, None when unknown."""
    value = row.get(key)
    if value is None or user_id is None:
        return None
    row_identity = str(value).strip()
    user_identity = str(user_id).strip()
    if not row_identity or not user_identity:
        return None
    return row_identity == user_identity


def _owned_by(
    row: Mapping[str, Any], identity_keys: tuple[str, ...], user_id: Any
) -> bool:
    """True unless the row names a different owner.

    A row that carries no identifier is trusted: the caller is expected to have
    queried the user's own rows. A row that carries an identifier naming
    someone else is never turned into a fact about this user.
    """
    relations = [
        relation
        for relation in (_relation(row, key, user_id) for key in identity_keys)
        if relation is not None
    ]
    return not relations or any(relations)


def _mappings(rows: Iterable[Any]) -> Iterator[Mapping[str, Any]]:
    """Yield only the mapping rows; anything else in the collection is ignored."""
    if rows is None:
        return
    for row in rows:
        if isinstance(row, Mapping):
            yield row


def _location_facts(display_name: str, last_location: Any) -> list[str]:
    place = clean_fact_text(last_location)
    if not place:
        return []
    return [f"{display_name} is based in {place}."]


def _skills_facts(display_name: str, skills: Any) -> list[str]:
    if isinstance(skills, str):
        candidates: Iterable[Any] = [skills]
    elif isinstance(skills, Mapping) or not isinstance(skills, Iterable):
        candidates = []
    else:
        candidates = skills

    cleaned: list[str] = []
    seen: set[str] = set()
    for item in candidates:
        skill = clean_fact_text(item)
        identity = skill.casefold()
        if skill and identity not in seen:
            seen.add(identity)
            cleaned.append(skill)

    if not cleaned:
        return []
    if len(cleaned) == 1:
        listed = cleaned[0]
    else:
        listed = ", ".join(cleaned[:-1]) + " and " + cleaned[-1]
    return [f"{display_name} works in {listed}."]


def _service_facts(
    display_name: str, services: Iterable[Any], user_id: Any
) -> list[str]:
    rendered: list[tuple[tuple[str, int, str], str]] = []
    for row in _mappings(services):
        if row.get("is_active") is not True:
            continue
        if not _owned_by(row, ("provider_id",), user_id):
            continue
        title = clean_fact_text(row.get("title"))
        price = whole_naira(row.get("price"))
        radius = _quantity(row.get("radius_km"))
        if not title or price is None or radius is None:
            continue
        sentence = (
            f"{display_name} lists {title} at {price} naira within {radius} km."
        )
        rendered.append(((title.casefold(), price, radius), sentence))
    rendered.sort(key=lambda item: item[0])
    return [sentence for _, sentence in rendered]


def _job_facts(
    display_name: str, client_jobs: Iterable[Any], user_id: Any
) -> list[str]:
    rendered: list[tuple[tuple[int, str, int, str, str], str]] = []
    for row in _mappings(client_jobs):
        if not _owned_by(row, ("client_id",), user_id):
            continue
        # "hired a provider" is only true once a provider is on the job.
        if not _has_identifier(row.get("provider_id")):
            continue
        title = clean_fact_text(row.get("title"))
        price = whole_naira(row.get("price"))
        place = clean_fact_text(row.get("location"))
        status = clean_fact_text(row.get("status"))
        year = _year(row.get("created_at"))
        if not title or price is None or not status or year is None:
            continue
        where = f" in {place}" if place else ""
        sentence = (
            f"{display_name} hired a provider for {title} at {price} naira"
            f"{where} ({status}, {year})."
        )
        rendered.append(
            ((year, title.casefold(), price, place.casefold(), status.casefold()), sentence)
        )
    rendered.sort(key=lambda item: item[0])
    return [sentence for _, sentence in rendered]


def _median(values: list[int]) -> int:
    """Return the median of sorted values as a whole naira amount."""
    middle = len(values) // 2
    if len(values) % 2 == 1:
        return values[middle]
    # An even count can land on half a naira; the sentence carries whole naira,
    # so round half up to the nearest one.
    average = Decimal(values[middle - 1] + values[middle]) / Decimal(2)
    return int(average.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _budget_facts(
    display_name: str, client_jobs: Iterable[Any], user_id: Any
) -> list[str]:
    grouped: dict[str, list[tuple[int, str, int, str]]] = {}
    for row in _mappings(client_jobs):
        if not _owned_by(row, ("client_id",), user_id):
            continue
        category = _category(row.get("category"))
        price = whole_naira(row.get("price"))
        if not category or price is None:
            continue
        title = clean_fact_text(row.get("title"))
        year = _year(row.get("created_at")) or 0
        grouped.setdefault(category.casefold(), []).append(
            (year, title.casefold(), price, category)
        )

    facts: list[str] = []
    for identity in sorted(grouped):
        entries = sorted(grouped[identity])
        amounts = sorted(price for _, _, price, _ in entries)
        if len(amounts) < _MIN_BUDGET_JOBS:
            continue
        # One spelling per category: the first in the deterministic order wins.
        category = entries[0][3]
        facts.append(
            f"{display_name} usually budgets around {_median(amounts)} naira "
            f"for {category}."
        )
    return facts


def _completed_count(
    jobs: Iterable[Any], identity_keys: tuple[str, ...], user_id: Any
) -> int:
    completed = 0
    for row in _mappings(jobs):
        if not _owned_by(row, identity_keys, user_id):
            continue
        if clean_fact_text(row.get("status")).casefold() == _COMPLETED_JOB_STATUS:
            completed += 1
    return completed


def _completed_facts(
    display_name: str,
    client_jobs: Iterable[Any],
    provider_jobs: Iterable[Any],
    user_id: Any,
) -> list[str]:
    as_client = _completed_count(client_jobs, ("client_id",), user_id)
    as_provider = _completed_count(provider_jobs, ("provider_id",), user_id)
    if as_client + as_provider == 0:
        return []
    noun = "job" if as_client == 1 else "jobs"
    return [
        f"{display_name} has completed {as_client} {noun} as a client "
        f"and {as_provider} as a provider."
    ]


def _rating_facts(
    display_name: str, ratings: Iterable[Any], user_id: Any
) -> list[str]:
    scores: list[int] = []
    for row in _mappings(ratings):
        if not _owned_by(row, ("ratee_id",), user_id):
            continue
        score = whole_naira(row.get("score"))
        if score is None or score > 5:
            continue
        scores.append(score)
    if not scores:
        return []
    average = (Decimal(sum(scores)) / Decimal(len(scores))).quantize(
        Decimal("0.1"), rounding=ROUND_HALF_UP
    )
    noun = "rating" if len(scores) == 1 else "ratings"
    return [
        f"{display_name} has an average rating of {average} from "
        f"{len(scores)} {noun}."
    ]


def _dispute_facts(
    display_name: str, disputes: Iterable[Any], user_id: Any
) -> list[str]:
    in_progress = 0
    resolved = 0
    for row in _mappings(disputes):
        if not _owned_by(row, ("client_id", "provider_id"), user_id):
            continue
        status = clean_fact_text(row.get("status")).casefold()
        if status == "open":
            in_progress += 1
        elif status == "resolved":
            resolved += 1

    facts: list[str] = []
    if in_progress:
        noun = "dispute" if in_progress == 1 else "disputes"
        facts.append(f"{display_name} has {in_progress} {noun} in progress.")
    if resolved:
        noun = "resolved dispute" if resolved == 1 else "resolved disputes"
        facts.append(f"{display_name} has {resolved} {noun}.")
    return facts


def _deduplicate(facts: list[str]) -> list[str]:
    """Keep the first occurrence of each sentence, preserving the order."""
    seen: set[str] = set()
    unique: list[str] = []
    for fact in facts:
        if fact not in seen:
            seen.add(fact)
            unique.append(fact)
    return unique
