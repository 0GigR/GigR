"""Advisory Sui verification for a memory's Walrus reference.

The agent's long-term memory lives in Walrus, whose blob registrations are Sui
objects. This service answers one read-only question: "does the reference this
memory points at exist on Sui, and is it a certified Walrus blob?"

It is advisory by construction:

* With FEATURE_TATUM_SUI off, or Tatum unconfigured, it answers without any
  network call and ``available`` is False.
* A timeout, transport error or breaker-open is caught and reported as
  ``verification_unavailable``. Nothing is raised to the caller.
* No memory read or write calls this service, so a Sui outage cannot change,
  delay or fail a memory operation. There is no stored verification state and
  therefore no badge to go stale: the caller asks for the badge or does not.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING, Optional
from uuid import UUID

from ..core.config import settings

if TYPE_CHECKING:  # pragma: no cover - typing only, never imported at runtime
    from ..core.gateways.tatum_sui_gateway import TatumSuiGateway

logger = logging.getLogger(__name__)

FEATURE_FLAG = "FEATURE_TATUM_SUI"

# A Sui object id: 0x followed by 1-64 hex characters.
_OBJECT_ID = re.compile(r"^0x[0-9a-fA-F]{1,64}$")
# A Walrus blob id is a 32-byte value in unpadded base64url: 43 characters.
_BLOB_ID = re.compile(r"^[A-Za-z0-9_-]{43}$")
# The on-chain Move type of a Walrus blob object.
_BLOB_TYPE_MARKER = "::blob::blob"

REASON_FEATURE_DISABLED = "feature_disabled"
REASON_NOT_CONFIGURED = "tatum_not_configured"
REASON_EMPTY = "empty_reference"
REASON_UNRECOGNISED = "unrecognised_reference"
REASON_BLOB_ID_UNRESOLVED = "blob_id_not_resolvable_without_indexer"
REASON_UNAVAILABLE = "verification_unavailable"
REASON_NOT_FOUND = "object_not_found"
REASON_RPC_ERROR = "rpc_error"
REASON_NOT_A_BLOB = "not_a_walrus_blob"
REASON_NOT_CERTIFIED = "blob_not_certified"
REASON_CERTIFIED = "certified_blob"


@dataclass(frozen=True)
class MemoryVerification:
    """The advisory answer for one reference. Never an exception, never a write."""

    reference: str
    available: bool
    checked: bool
    verified: bool
    reason: str
    object_id: Optional[str] = None
    object_type: Optional[str] = None
    certified_epoch: Optional[int] = None
    end_epoch: Optional[int] = None
    deletable: Optional[bool] = None

    def as_response(self) -> dict:
        """The JSON body the read-only endpoint returns.

        ``advisory`` is always True and no field is ever used to mutate memory.
        ``available`` False is the "no badge" answer, not an error.
        """
        return {
            "reference": self.reference,
            "advisory": True,
            "available": self.available,
            "checked": self.checked,
            "verified": self.verified,
            "reason": self.reason,
            "object_id": self.object_id,
            "object_type": self.object_type,
            "certified_epoch": self.certified_epoch,
            "end_epoch": self.end_epoch,
            "deletable": self.deletable,
        }


def _classify(reference: str) -> tuple[str, str]:
    """What kind of reference this is: an object id, a blob id, or unknown.

    An explicit ``sui:`` / ``object:`` / ``walrus:`` / ``blob:`` prefix wins, so
    a caller that knows what it holds is never second-guessed. A bare value is
    classified by shape. This only classifies; it never guesses a blob id's
    on-chain object id.
    """
    lowered = reference.lower()
    for prefix in ("sui:", "object:"):
        if lowered.startswith(prefix):
            candidate = reference[len(prefix) :].strip()
            return ("object", candidate) if _OBJECT_ID.match(candidate) else ("unknown", "")
    for prefix in ("walrus:", "blob:"):
        if lowered.startswith(prefix):
            return "blob", reference[len(prefix) :].strip()

    if _OBJECT_ID.match(reference):
        return "object", reference
    if _BLOB_ID.match(reference):
        return "blob", reference
    return "unknown", ""


def _as_int(value: object) -> Optional[int]:
    """Read a Move integer that Sui may render as a string or a number."""
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _as_option_int(value: object) -> Optional[int]:
    """Read a Move ``Option<u32>`` in the shapes Sui's JSON-RPC renders.

    Older nodes wrap the value in ``{"type": ..., "fields": {"vec": [n]}}``;
    newer ones render the value itself or ``null``. All three mean the same
    thing here: the epoch, or None when the option is empty.
    """
    if value is None:
        return None
    if isinstance(value, dict):
        inner = value.get("fields") if isinstance(value.get("fields"), dict) else value
        if isinstance(inner, dict) and "vec" in inner:
            vector = inner["vec"]
            if isinstance(vector, list) and vector:
                return _as_int(vector[0])
            return None
        return None
    return _as_int(value)


def _field(fields: dict, *names: str) -> object:
    """Read the first present key, so snake_case and camelCase both resolve."""
    for name in names:
        if name in fields:
            return fields[name]
    return None


class MemoryVerificationService:
    """Verify a Walrus reference on Sui through the injected Tatum gateway."""

    def __init__(self, verifier: Optional["TatumSuiGateway"] = None) -> None:
        self._verifier = verifier

    async def verify_reference(self, user_id: UUID, reference: str) -> MemoryVerification:
        """Return the advisory verification for ``reference``.

        Never raises: every failure is reported as an unverified result, so a
        caller rendering a badge cannot turn a Sui problem into a broken page.
        """
        try:
            return await self._verify(reference)
        except Exception as exc:  # noqa: BLE001 - advisory check, must never raise
            message = str(exc)
            api_key = settings.tatum_sui_api_key
            if api_key and api_key in message:
                message = message.replace(api_key, "[redacted]")
            logger.warning(
                "[memory-verification] verification failed for user_id=%s "
                "(operation=verify_reference): %s: %s",
                user_id,
                type(exc).__name__,
                message,
            )
            return MemoryVerification(
                reference=reference,
                available=True,
                checked=True,
                verified=False,
                reason=REASON_UNAVAILABLE,
            )

    async def _verify(self, reference: str) -> MemoryVerification:
        cleaned = (reference or "").strip()
        if not cleaned:
            return MemoryVerification(
                reference="",
                available=False,
                checked=False,
                verified=False,
                reason=REASON_EMPTY,
            )

        if not settings.FEATURE_TATUM_SUI:
            return MemoryVerification(
                reference=cleaned,
                available=False,
                checked=False,
                verified=False,
                reason=REASON_FEATURE_DISABLED,
            )

        if self._verifier is None or not self._verifier.configured:
            return MemoryVerification(
                reference=cleaned,
                available=False,
                checked=False,
                verified=False,
                reason=REASON_NOT_CONFIGURED,
            )

        kind, value = _classify(cleaned)
        if kind == "blob":
            # A blob id is a content commitment, not an object id. Resolving it
            # to its Blob objects needs the Walrus indexer, which this advisory
            # capability deliberately does not depend on. Report that plainly
            # instead of claiming a verification that did not happen.
            return MemoryVerification(
                reference=cleaned,
                available=True,
                checked=False,
                verified=False,
                reason=REASON_BLOB_ID_UNRESOLVED,
            )
        if kind == "unknown":
            return MemoryVerification(
                reference=cleaned,
                available=True,
                checked=False,
                verified=False,
                reason=REASON_UNRECOGNISED,
            )

        result = await self._verifier.get_object(value)
        if result.error == "object_not_found":
            return MemoryVerification(
                reference=cleaned,
                available=True,
                checked=True,
                verified=False,
                reason=REASON_NOT_FOUND,
                object_id=value,
            )
        if result.error:
            return MemoryVerification(
                reference=cleaned,
                available=True,
                checked=True,
                verified=False,
                reason=REASON_RPC_ERROR,
                object_id=value,
            )

        object_type = result.object_type or ""
        if _BLOB_TYPE_MARKER not in object_type.lower():
            return MemoryVerification(
                reference=cleaned,
                available=True,
                checked=True,
                verified=False,
                reason=REASON_NOT_A_BLOB,
                object_id=result.object_id,
                object_type=result.object_type,
            )

        fields = result.fields or {}
        certified_epoch = _as_option_int(
            _field(fields, "certified_epoch", "certifiedEpoch")
        )
        storage = _field(fields, "storage")
        end_epoch = None
        if isinstance(storage, dict):
            storage_fields = (
                storage["fields"]
                if isinstance(storage.get("fields"), dict)
                else storage
            )
            end_epoch = _as_option_int(_field(storage_fields, "end_epoch", "endEpoch"))
        deletable = _field(fields, "deletable")
        deletable_flag = deletable if isinstance(deletable, bool) else None

        return MemoryVerification(
            reference=cleaned,
            available=True,
            checked=True,
            verified=certified_epoch is not None,
            reason=(
                REASON_CERTIFIED if certified_epoch is not None else REASON_NOT_CERTIFIED
            ),
            object_id=result.object_id,
            object_type=result.object_type,
            certified_epoch=certified_epoch,
            end_epoch=end_epoch,
            deletable=deletable_flag,
        )
