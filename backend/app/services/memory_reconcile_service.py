"""Per-fact memory controls, implemented by rewriting the user's namespace.

Walrus Memory has no per-fact delete. memwal 0.2.2 exposes ``forget(namespace)``,
which removes every row in one namespace; there is no call that removes one
sentence. Deleting or editing a single memory is therefore a reconcile:

1. read the sentences the namespace holds,
2. compute the sentences that must remain,
3. persist that remainder in a local journal,
4. ``forget(namespace)`` -- this wipes everything,
5. remember every remaining sentence again, with the fact writer's
   namespace-scoped idempotency key.

Step 3 is what makes steps 4 and 5 survivable. They are not one transaction: a
process that dies between them would leave the namespace empty and the user's
memory gone, with no record of what to put back. The journal is written and
flushed to disk before the wipe, and every public operation completes a journal
it finds before it does anything else. The re-write uses the key the original
write used, so completing a restore twice collapses onto the writes that already
landed instead of duplicating every sentence.

Every answer is a :class:`FactReconcileResult`. A flag that is off, a relayer
that is down, a sentence that no longer exists and a restore that failed part
way are all typed answers: none of them raises into the page. A restore that did
not finish is reported with ``partial`` true and reason ``restore_incomplete``,
and it is logged at ERROR: the user must never be told a delete succeeded while
part of their memory is missing.

Two limits are deliberate and stated rather than hidden:

* The read is one broad recall bounded by :data:`RECONCILE_READ_LIMIT`. A
  namespace that fills that read cannot be proven fully read, so the operation
  refuses to wipe it rather than drop sentences it never saw.
* The journal and the per-user lock live in this process. That matches the rest
  of the memory backend, which is deployed as one process per instance; a
  multi-worker deployment would need both shared between workers.

This module never imports a database driver and never builds a gateway.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Iterable, Optional
from uuid import UUID

from ..core.agent_features import agent_feature_enabled
from ..core.memory_namespace import FLAG_NAME
from .fact_memory_service import FactMemoryService, FactWrite
from .memory_fact_category import categorize_fact
from .memory_failure_reason import dependency_failure_reason

if TYPE_CHECKING:  # pragma: no cover - typing only, never imported at runtime
    from ..core.gateways.walrus_memory_gateway import (
        RecalledMemory,
        WalrusMemoryGateway,
    )

logger = logging.getLogger(__name__)

# The recall a reconcile reads the namespace with. A recall ranks by similarity,
# so the query names every subject the fact writers store rather than a single
# topic: a question about one topic would miss the sentences about the others,
# and those are exactly the ones a wipe would then drop.
RECONCILE_READ_QUERY = (
    "this user's preferences, jobs, services, providers, prices, locations, "
    "payments and past activity"
)

# How many sentences one read asks for. A namespace that fills this read cannot
# be proven fully read, so the delete refuses to run: the read is the only proof
# of what must be written back.
RECONCILE_READ_LIMIT = 200

# The deadline one reconcile read may take. It is one recall of up to
# RECONCILE_READ_LIMIT entries and regularly takes longer than the dependency
# policy's short timeout, so it gets the longer one. One attempt only: retrying a
# deadline this long would double what the request waits.
RECONCILE_READ_TIMEOUT_SECONDS = 30.0

# The largest operation the control accepts, so one request cannot ask for an
# unbounded rewrite. The page can only select what one review returned, which is
# smaller.
MAX_FACTS_PER_OPERATION = 100

# The longest sentence a replacement may carry. It matches the length the fact
# writer stores.
MAX_FACT_TEXT_LENGTH = 2000

# The longest category identifier the page can send.
MAX_CATEGORY_LENGTH = 32

JOURNAL_VERSION = 1

OPERATION_DELETE_FACTS = "delete_facts"
OPERATION_DELETE_CATEGORY = "delete_category"
OPERATION_REPLACE_FACT = "replace_fact"

REASON_OK = "ok"
REASON_NOTHING_TO_REMOVE = "nothing_to_remove"
REASON_NOTHING_TO_REPLACE = "nothing_to_replace"
REASON_UNCHANGED = "unchanged"
REASON_INVALID_TEXT = "invalid_text"
REASON_FEATURE_DISABLED = "feature_disabled"
REASON_NOT_CONFIGURED = "not_configured"
REASON_MEMORY_TOO_LARGE = "memory_too_large"
REASON_JOURNAL_FAILED = "journal_failed"
REASON_RESTORE_INCOMPLETE = "restore_incomplete"

# The cause of a failed relayer call, as one clause the detail sentence can
# start or join. The reason codes themselves come from the shared mapping.
_DEPENDENCY_CAUSES = {
    "relayer_busy": "Walrus Memory is busy right now.",
    "relayer_timeout": "Walrus Memory took too long to answer.",
    "relayer_unavailable": "We could not reach Walrus Memory.",
}


@dataclass(frozen=True)
class PendingRestore:
    """One interrupted reconcile and the sentences it still owes the namespace.

    ``facts`` is exactly what must be written back, in the order the wipe read
    them. An empty tuple is meaningful: the user deleted every sentence, and the
    restore is a no-op that still has to clear the journal.
    """

    user_id: str
    namespace: str
    facts: tuple[str, ...]
    operation: str
    created_at: str


@dataclass(frozen=True)
class FactReconcileResult:
    """What one per-fact operation did, in a shape a page can render.

    ``ok`` is true only when the operation completed and the namespace is known
    to hold exactly the sentences that should remain. A no-op (the named memory
    is already gone) is a success with ``removed`` zero: nothing needed doing.

    ``partial`` is the loud case: the wipe was applied and the rewrite did not
    finish, so the namespace may hold only part of the user's memory. It is never
    true together with ``ok``. ``remaining`` is None whenever the count cannot be
    trusted, and the page then prints no count rather than a guess.

    ``recovered`` says a restore left by an earlier, interrupted reconcile was
    completed before this operation ran.
    """

    ok: bool
    reason: str = REASON_OK
    removed: int = 0
    restored: int = 0
    remaining: Optional[int] = None
    partial: bool = False
    recovered: bool = False
    detail: str = ""

    def as_response(self) -> dict[str, Any]:
        """The JSON body the endpoint returns. No internal detail is included."""
        if self.ok:
            status = "ok"
        elif self.partial:
            status = "partial"
        else:
            status = "failed"
        return {
            "status": status,
            "ok": self.ok,
            "reason": self.reason,
            "removed": self.removed,
            "restored": self.restored,
            "remaining": self.remaining,
            "partial": self.partial,
            "recovered": self.recovered,
            "detail": self.detail,
        }


@dataclass(frozen=True)
class _Recovery:
    """The outcome of completing a journal a previous process left behind."""

    found: bool
    completed: bool
    restored: int = 0
    reason: str = REASON_OK


class KeyedLock:
    """One asyncio lock per key, shared by every request in this process.

    Two reconciles for one user must not interleave. Each one wipes the
    namespace before writing it back, so a second wipe would erase the first
    one's restore and lose every sentence neither operation kept. The map is
    never pruned: it holds one small lock per user who has used the control.
    """

    def __init__(self) -> None:
        self._locks: dict[str, asyncio.Lock] = {}

    def lock_for(self, key: str) -> asyncio.Lock:
        """The one lock for ``key``, created on first use."""
        lock = self._locks.get(key)
        if lock is None:
            lock = asyncio.Lock()
            self._locks[key] = lock
        return lock


class MemoryReconcileJournal:
    """The durable list of sentences an interrupted reconcile must write back.

    One JSON file holds every user's pending restore. It is written atomically
    (a sibling file is written, flushed and renamed into place) before a
    namespace is wiped, so a kill at any point leaves either the previous
    complete file or the new complete one, never half a line.

    The file records the namespace prefix it was written under, like the
    backfill state file: a run under a different prefix names namespaces that no
    longer exist, and writing those sentences into the new ones would be wrong.
    A file that cannot be trusted is refused rather than replaced, because
    replacing it would discard the only record of what a crash still owes.
    """

    def __init__(self, path: str, namespace_prefix: str) -> None:
        self.path = path
        self.namespace_prefix = namespace_prefix

    def pending(self, user_id: UUID) -> Optional[PendingRestore]:
        """The restore this user owes, or None when there is nothing pending.

        Raises ValueError when the file exists but cannot be trusted. The caller
        must then refuse to change anything: a corrupt journal may describe a
        restore that has not run.
        """
        payload = self._read()
        entry = payload["users"].get(str(user_id))
        if entry is None:
            return None
        if not isinstance(entry, dict):
            raise ValueError(
                f"{self.path} holds a malformed entry for user_id={user_id}; "
                f"move it aside only after checking that the namespace is intact"
            )
        namespace = entry.get("namespace")
        facts = entry.get("facts")
        if not isinstance(namespace, str) or not namespace.strip():
            raise ValueError(
                f"{self.path} holds an entry for user_id={user_id} without a "
                f"namespace; it cannot be restored safely"
            )
        if not isinstance(facts, list) or any(
            not isinstance(fact, str) or not fact.strip() for fact in facts
        ):
            raise ValueError(
                f"{self.path} holds an entry for user_id={user_id} whose facts "
                f"are not a list of non-empty sentences; it cannot be restored "
                f"safely"
            )
        return PendingRestore(
            user_id=str(user_id),
            namespace=namespace,
            facts=tuple(fact.strip() for fact in facts),
            operation=str(entry.get("operation") or "reconcile"),
            created_at=str(entry.get("created_at") or ""),
        )

    def stage(
        self,
        user_id: UUID,
        namespace: str,
        facts: Iterable[str],
        operation: str,
    ) -> None:
        """Persist the sentences a wipe must write back, before the wipe runs.

        Raises ValueError when a restore is already pending for this user. The
        service completes that restore before it stages another, so this only
        fires on a programming error or a second process writing the same file;
        either way, overwriting the older list would lose it.
        """
        payload = self._read()
        users = payload["users"]
        if str(user_id) in users:
            raise ValueError(
                f"a restore is already pending for user_id={user_id}; it must be "
                f"completed before another change can be staged"
            )
        users[str(user_id)] = {
            "namespace": namespace,
            "operation": operation,
            "facts": list(facts),
            "created_at": _now(),
        }
        self._write(payload)

    def clear(self, user_id: UUID) -> None:
        """Forget this user's pending restore. A no-op when there is none."""
        if not os.path.exists(self.path):
            return
        payload = self._read()
        if payload["users"].pop(str(user_id), None) is None:
            return
        self._write(payload)

    def _read(self) -> dict[str, Any]:
        """The journal, or an empty one when the file does not exist.

        Raises ValueError for anything that cannot be trusted: invalid JSON, an
        unknown version, another namespace prefix, or a users map of the wrong
        shape.
        """
        if not os.path.exists(self.path):
            return self._empty()
        try:
            with open(self.path, encoding="utf-8") as handle:
                payload = json.load(handle)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError(
                f"{self.path} is not a readable restore journal ({exc}); do not "
                f"delete it until the namespace is known to be intact"
            ) from exc
        if not isinstance(payload, dict) or payload.get("version") != JOURNAL_VERSION:
            raise ValueError(
                f"{self.path} is not a version {JOURNAL_VERSION} restore journal"
            )
        if payload.get("namespace_prefix") != self.namespace_prefix:
            raise ValueError(
                f"{self.path} was written for namespace prefix "
                f"{payload.get('namespace_prefix')!r} but MEMWAL_NAMESPACE_PREFIX "
                f"is {self.namespace_prefix!r}; those namespaces are different, "
                f"so it cannot be restored from here"
            )
        if not isinstance(payload.get("users"), dict):
            raise ValueError(f"{self.path} has no users map")
        return payload

    def _empty(self) -> dict[str, Any]:
        return {
            "version": JOURNAL_VERSION,
            "namespace_prefix": self.namespace_prefix,
            "users": {},
        }

    def _write(self, payload: dict[str, Any]) -> None:
        """Write the journal atomically, so a kill cannot leave half a file."""
        directory = os.path.dirname(os.path.abspath(self.path))
        os.makedirs(directory, exist_ok=True)
        temporary = f"{self.path}.tmp"
        with open(temporary, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)


class MemoryReconcileService:
    """Delete or edit single memories by rewriting one user's namespace.

    ``memory`` owns the namespace, the fact keys and the relayer write; it is
    injected from the composition root, as is ``gateway`` for the read and the
    wipe. ``locks`` is shared by every instance in the process so two requests
    for one user serialize, and ``journal`` is the durable restore point.

    No method takes a namespace or a user id from the caller other than the
    authenticated user's own id: the namespace is always derived from it by
    :func:`core.memory_namespace.memory_namespace`, so an operation can only ever
    touch the caller's memory.
    """

    def __init__(
        self,
        *,
        memory: FactMemoryService,
        gateway: Optional["WalrusMemoryGateway"],
        journal: MemoryReconcileJournal,
        locks: KeyedLock,
    ) -> None:
        self._memory = memory
        self._gateway = gateway
        self._journal = journal
        self._locks = locks

    async def delete_facts(
        self, user_id: UUID, facts: Iterable[str]
    ) -> FactReconcileResult:
        """Remove the named sentences and write back the rest.

        Matching is by exact text, after trimming outer whitespace. A sentence
        that is not stored is ignored, and an operation whose sentences are all
        gone is a clean no-op: nothing is wiped, nothing is rewritten. Raises
        nothing: every outcome is a :class:`FactReconcileResult`.
        """
        texts = _clean_texts(facts)
        if not texts:
            return _invalid("Select at least one memory to delete.")
        if len(texts) > MAX_FACTS_PER_OPERATION:
            return _invalid(
                f"Select at most {MAX_FACTS_PER_OPERATION} memories at a time."
            )
        if any(len(text) > MAX_FACT_TEXT_LENGTH for text in texts):
            return _invalid("One of those memories is too long to delete.")
        return await self._reconcile(
            user_id, OPERATION_DELETE_FACTS, remove=frozenset(texts)
        )

    async def delete_category(
        self, user_id: UUID, category: str
    ) -> FactReconcileResult:
        """Remove every stored sentence in one display category.

        The category is classified here, from the stored text, with the same
        rule the page groups by, so the count the page showed and the count the
        delete removes come from one classifier. An unknown or empty category
        matches nothing and is a clean no-op.
        """
        cleaned = (category or "").strip()
        if not cleaned or len(cleaned) > MAX_CATEGORY_LENGTH:
            return _invalid("Choose a group of memories to delete.")
        return await self._reconcile(
            user_id, OPERATION_DELETE_CATEGORY, category=cleaned
        )

    async def replace_fact(
        self, user_id: UUID, old_text: str, new_text: str
    ) -> FactReconcileResult:
        """Replace one stored sentence with another, in the same position.

        This is a delete plus a re-add over the whole namespace, which is why
        the page presents it as an edit and says that the remaining memories are
        rewritten. When the old sentence is no longer stored, nothing is changed
        and the new sentence is not added: the user asked to edit a memory, and
        saving an orphan would put back a sentence a previous delete removed.
        """
        old = (old_text or "").strip()
        new = (new_text or "").strip()
        if not old or not new:
            return _invalid("Enter the replacement text.")
        if len(old) > MAX_FACT_TEXT_LENGTH or len(new) > MAX_FACT_TEXT_LENGTH:
            return _invalid(
                f"That text is too long. Keep it to {MAX_FACT_TEXT_LENGTH} "
                f"characters."
            )
        return await self._reconcile(
            user_id, OPERATION_REPLACE_FACT, old_text=old, new_text=new
        )

    async def _reconcile(
        self,
        user_id: UUID,
        operation: str,
        *,
        remove: Optional[frozenset[str]] = None,
        category: Optional[str] = None,
        old_text: Optional[str] = None,
        new_text: Optional[str] = None,
    ) -> FactReconcileResult:
        """Run one reconcile: recover first, then read, stage, wipe, restore."""
        if not agent_feature_enabled(FLAG_NAME):
            return FactReconcileResult(
                ok=False,
                reason=REASON_FEATURE_DISABLED,
                detail="Memory is turned off in this environment, so nothing "
                "was changed.",
            )
        if self._gateway is None or not self._gateway.configured:
            return FactReconcileResult(
                ok=False,
                reason=REASON_NOT_CONFIGURED,
                detail="Walrus Memory is not set up in this environment, so "
                "nothing was changed.",
            )

        namespace = self._memory.namespace(user_id)
        async with self._locks.lock_for(str(user_id)):
            recovery = await self._complete_pending_restore(user_id, namespace)
            if not recovery.completed:
                return FactReconcileResult(
                    ok=False,
                    reason=recovery.reason,
                    restored=recovery.restored,
                    partial=True,
                    detail=_recovery_detail(recovery.reason),
                )
            # The check above proved the gateway is usable; naming it here is
            # what lets the locked half take it as a non-optional argument.
            gateway = self._gateway
            return await self._reconcile_locked(
                user_id,
                namespace,
                operation,
                gateway=gateway,
                remove=remove,
                category=category,
                old_text=old_text,
                new_text=new_text,
                recovered=recovery.found,
            )

    async def _reconcile_locked(
        self,
        user_id: UUID,
        namespace: str,
        operation: str,
        *,
        gateway: "WalrusMemoryGateway",
        remove: Optional[frozenset[str]],
        category: Optional[str],
        old_text: Optional[str],
        new_text: Optional[str],
        recovered: bool,
    ) -> FactReconcileResult:
        """The reconcile itself, with the per-user lock already held."""
        try:
            memories = await gateway.recall(
                RECONCILE_READ_QUERY,
                namespace,
                RECONCILE_READ_LIMIT,
                timeout_seconds=RECONCILE_READ_TIMEOUT_SECONDS,
                retry=False,
            )
        except Exception as exc:  # noqa: BLE001 - an outbound dependency may fail any way
            reason = dependency_failure_reason(exc)
            logger.warning(
                "[memory-reconcile] could not read namespace=%s for user_id=%s "
                "(operation=%s): %s: %s; nothing was wiped",
                namespace,
                user_id,
                operation,
                type(exc).__name__,
                exc,
            )
            return FactReconcileResult(
                ok=False,
                reason=reason,
                recovered=recovered,
                detail=f"{_dependency_cause(reason)} Nothing was removed. "
                f"Try again in a moment.",
            )

        all_facts = _unique_texts(memories)
        if len(all_facts) >= RECONCILE_READ_LIMIT:
            # A bounded read that came back full is not proof of the whole
            # namespace. Wiping now could drop sentences this operation never
            # saw, so it refuses instead.
            return FactReconcileResult(
                ok=False,
                reason=REASON_MEMORY_TOO_LARGE,
                recovered=recovered,
                detail="Walrus Memory holds more memories than this control "
                "reads in one pass, so nothing was removed. Use Forget "
                "everything, or try again after removing some memories.",
            )

        kept = list(all_facts)
        removed = 0
        if old_text is not None:
            if old_text not in all_facts:
                return _noop(
                    REASON_NOTHING_TO_REPLACE,
                    len(all_facts),
                    recovered,
                    "That memory is not in Walrus Memory any more, so nothing "
                    "was changed. The new text was not saved.",
                )
            if new_text == old_text:
                return _noop(
                    REASON_UNCHANGED,
                    len(all_facts),
                    recovered,
                    "The new text is the same as the old text, so nothing was "
                    "changed.",
                )
            kept = [new_text if fact == old_text else fact for fact in all_facts]
            removed = 1
        else:
            if category is not None:
                targets = {
                    fact for fact in all_facts if categorize_fact(fact) == category
                }
                missing_detail = (
                    "There are no memories in that group any more, so nothing "
                    "was removed and nothing was rewritten."
                )
            else:
                targets = frozenset(all_facts) & (remove or frozenset())
                missing_detail = (
                    "Those memories are not in Walrus Memory any more, so "
                    "nothing was removed and nothing was rewritten."
                )
            if not targets:
                return _noop(
                    REASON_NOTHING_TO_REMOVE,
                    len(all_facts),
                    recovered,
                    missing_detail,
                )
            removed = len(targets)
            kept = [fact for fact in all_facts if fact not in targets]

        try:
            writes = self._memory.plan(user_id, kept)
        except ValueError as exc:
            logger.error(
                "[memory-reconcile] could not plan the rewrite for user_id=%s "
                "(operation=%s): %s; nothing was wiped",
                user_id,
                operation,
                exc,
            )
            return FactReconcileResult(
                ok=False,
                reason=REASON_JOURNAL_FAILED,
                recovered=recovered,
                detail="We could not prepare the change safely, so nothing was "
                "removed. Try again in a moment.",
            )

        try:
            self._journal.stage(
                user_id,
                namespace,
                (write.text for write in writes),
                operation,
            )
        except Exception as exc:  # noqa: BLE001 - the disk may fail any way
            # Without a journal there is no restore point, and a wipe now could
            # not be undone. Refusing is the only safe answer.
            logger.error(
                "[memory-reconcile] could not write the restore journal for "
                "user_id=%s namespace=%s (operation=%s): %s: %s; nothing was "
                "wiped",
                user_id,
                namespace,
                operation,
                type(exc).__name__,
                exc,
            )
            return FactReconcileResult(
                ok=False,
                reason=REASON_JOURNAL_FAILED,
                recovered=recovered,
                detail="We could not prepare the change safely, so nothing was "
                "removed. Try again in a moment.",
            )

        try:
            await gateway.forget(namespace)
        except Exception as exc:  # noqa: BLE001 - an outbound dependency may fail any way
            # The outcome is unknown: the rows may have been deleted before the
            # error was returned. Writing the kept sentences back is safe either
            # way: the wipe that did not land leaves them collapsing onto their
            # own idempotency keys instead of duplicating them.
            reason = dependency_failure_reason(exc)
            logger.error(
                "[memory-reconcile] the wipe failed for user_id=%s namespace=%s "
                "(operation=%s): %s: %s; writing the kept memories back before "
                "answering",
                user_id,
                namespace,
                operation,
                type(exc).__name__,
                exc,
            )
            restored, failed = await self._restore(user_id, writes)
            if failed:
                return FactReconcileResult(
                    ok=False,
                    reason=REASON_RESTORE_INCOMPLETE,
                    restored=restored,
                    partial=True,
                    detail=_partial_detail(restored, len(writes)),
                )
            self._clear_journal(user_id)
            return FactReconcileResult(
                ok=False,
                reason=reason,
                restored=restored,
                remaining=len(writes),
                recovered=recovered,
                detail="Walrus Memory did not confirm the delete. "
                f"{_plural(restored, 'memory was', 'memories were')} written "
                "back, so what you kept is still stored. Try again if the "
                "memories are still listed.",
            )

        restored, failed = await self._restore(user_id, writes)
        if failed:
            # The journal stays: it is the only record of what is still missing,
            # and the next call retries it before doing anything else.
            logger.error(
                "[memory-reconcile] RESTORE INCOMPLETE for user_id=%s "
                "namespace=%s (operation=%s): %d of %d memories were written "
                "back before a write failed; partial=true, the restore journal "
                "is kept, and the next call retries it (operation=%s)",
                user_id,
                namespace,
                operation,
                restored,
                len(writes),
                operation,
            )
            return FactReconcileResult(
                ok=False,
                reason=REASON_RESTORE_INCOMPLETE,
                removed=removed,
                restored=restored,
                partial=True,
                recovered=recovered,
                detail=_partial_detail(restored, len(writes)),
            )

        self._clear_journal(user_id)
        logger.info(
            "[memory-reconcile] user_id=%s operation=%s namespace=%s "
            "removed=%d restored=%d recovered=%s",
            user_id,
            operation,
            namespace,
            removed,
            len(writes),
            recovered,
        )
        if old_text is not None:
            detail = _replace_detail(len(writes))
        else:
            detail = _delete_detail(removed, len(writes))
        return FactReconcileResult(
            ok=True,
            reason=REASON_OK,
            removed=removed,
            restored=len(writes),
            remaining=len(writes),
            recovered=recovered,
            detail=detail,
        )

    async def _complete_pending_restore(
        self, user_id: UUID, namespace: str
    ) -> _Recovery:
        """Write back a restore an earlier process left unfinished.

        Called first by every operation, before a new wipe can run. When there
        is nothing pending this is one file read. When there is, the whole list
        is written back with the writer's idempotency keys, so sentences that
        already made it back collapse instead of being stored twice, and the
        journal is cleared only after every write succeeded.
        """
        try:
            pending = self._journal.pending(user_id)
        except Exception as exc:  # noqa: BLE001 - the disk may fail any way
            logger.error(
                "[memory-reconcile] could not read the restore journal for "
                "user_id=%s (operation=recover_pending): %s: %s; refusing to "
                "change anything",
                user_id,
                type(exc).__name__,
                exc,
            )
            return _Recovery(
                found=True, completed=False, reason=REASON_JOURNAL_FAILED
            )
        if pending is None:
            return _Recovery(found=False, completed=True)
        if pending.namespace != namespace:
            logger.error(
                "[memory-reconcile] the restore journal for user_id=%s names "
                "namespace=%s but the caller's namespace is %s "
                "(operation=recover_pending); refusing to write into the wrong "
                "namespace",
                user_id,
                pending.namespace,
                namespace,
            )
            return _Recovery(
                found=True, completed=False, reason=REASON_JOURNAL_FAILED
            )

        logger.warning(
            "[memory-reconcile] completing an interrupted restore for "
            "user_id=%s namespace=%s (operation=%s): writing %d memories back",
            user_id,
            namespace,
            pending.operation,
            len(pending.facts),
        )
        try:
            writes = self._memory.plan(user_id, pending.facts)
        except ValueError as exc:
            logger.error(
                "[memory-reconcile] the restore journal for user_id=%s holds "
                "sentences that cannot be written back (operation=%s): %s",
                user_id,
                pending.operation,
                exc,
            )
            return _Recovery(
                found=True,
                completed=False,
                reason=REASON_JOURNAL_FAILED,
            )
        restored, failed = await self._restore(user_id, writes)
        if failed:
            logger.error(
                "[memory-reconcile] the interrupted restore for user_id=%s "
                "namespace=%s is still incomplete: %d of %d memories were "
                "written back; the journal is kept and this operation did not "
                "run",
                user_id,
                namespace,
                restored,
                len(writes),
            )
            return _Recovery(
                found=True,
                completed=False,
                restored=restored,
                reason=REASON_RESTORE_INCOMPLETE,
            )
        if not self._clear_journal(user_id):
            # The memory is correct; the stale entry only causes another
            # idempotent restore on the next call.
            logger.warning(
                "[memory-reconcile] restored user_id=%s but could not clear the "
                "journal; the next call will write the same memories again",
                user_id,
            )
        return _Recovery(found=True, completed=True, restored=restored)

    async def _restore(
        self, user_id: UUID, writes: Iterable[FactWrite]
    ) -> tuple[int, bool]:
        """Write the kept sentences back and report how many landed.

        Stops at the first failure: a relayer that refuses one write is usually
        refusing all of them (its minute budget), and spending the rest of the
        budget on calls that cannot land would only make the request longer. The
        journal keeps the full list, so the next call retries all of it.

        A BaseException, which is how a dying process surfaces, is not caught
        here on purpose: nothing after a crash should pretend to be a handled
        failure. The journal is already on disk.
        """
        restored = 0
        for write in writes:
            try:
                await self._memory.write(user_id, write)
            except Exception as exc:  # noqa: BLE001 - an outbound dependency may fail any way
                logger.error(
                    "[memory-reconcile] could not write a kept memory back for "
                    "user_id=%s (operation=restore): %s: %s; the journal keeps "
                    "the full list so the next call retries it",
                    user_id,
                    type(exc).__name__,
                    exc,
                )
                return restored, True
            restored += 1
        return restored, False

    def _clear_journal(self, user_id: UUID) -> bool:
        """Clear this user's journal entry, reporting whether it worked."""
        try:
            self._journal.clear(user_id)
            return True
        except Exception as exc:  # noqa: BLE001 - the disk may fail any way
            logger.error(
                "[memory-reconcile] could not clear the restore journal for "
                "user_id=%s (operation=reconcile): %s: %s; the memories are "
                "restored but the next call will restore them again",
                user_id,
                type(exc).__name__,
                exc,
            )
            return False


def _clean_texts(facts: Iterable[str]) -> tuple[str, ...]:
    """Trim the named sentences and drop exact duplicates, keeping the order."""
    seen: set[str] = set()
    cleaned: list[str] = []
    for fact in facts:
        text = (fact or "").strip()
        if not text or text in seen:
            continue
        seen.add(text)
        cleaned.append(text)
    return tuple(cleaned)


def _unique_texts(memories: Iterable["RecalledMemory"]) -> tuple[str, ...]:
    """The distinct stored sentences, trimmed, in the order the relayer ranked.

    Exact duplicates collapse because a namespace can hold the same sentence
    twice (a write that timed out may still have been stored). Blank text is
    dropped: an empty row is not a memory.
    """
    seen: set[str] = set()
    texts: list[str] = []
    for memory in memories:
        text = memory.text.strip()
        if not text or text in seen:
            continue
        seen.add(text)
        texts.append(text)
    return tuple(texts)


def _plural(count: int, singular: str, plural: str) -> str:
    """Render a count with the noun that agrees with it."""
    return f"{count} {singular if count == 1 else plural}"


def _dependency_cause(reason: str) -> str:
    """The one-clause cause of a relayer failure, for a detail sentence."""
    return _DEPENDENCY_CAUSES.get(
        reason, "We could not reach Walrus Memory."
    )


def _invalid(detail: str) -> FactReconcileResult:
    """A request this service refuses, with the sentence the page shows."""
    return FactReconcileResult(ok=False, reason=REASON_INVALID_TEXT, detail=detail)


def _noop(
    reason: str, remaining: int, recovered: bool, detail: str
) -> FactReconcileResult:
    """A clean no-op: nothing matched, so nothing was wiped or rewritten."""
    return FactReconcileResult(
        ok=True,
        reason=reason,
        remaining=remaining,
        recovered=recovered,
        detail=detail,
    )


def _delete_detail(removed: int, remaining: int) -> str:
    head = f"Removed {_plural(removed, 'memory', 'memories')}."
    if remaining == 0:
        return head + " Nothing else was stored, so your memory is now empty."
    return (
        head
        + f" Walrus Memory now holds {_plural(remaining, 'memory', 'memories')},"
        + " so everything you kept is still remembered."
    )


def _replace_detail(remaining: int) -> str:
    return (
        "Saved your edit. Walrus Memory now holds "
        f"{_plural(remaining, 'memory', 'memories')}, including the new text."
    )


def _partial_detail(restored: int, expected: int) -> str:
    return (
        "Your memory may be restored incompletely: "
        f"{restored} of {expected} memories were written back. Nothing else was "
        "changed. Try again to finish restoring them."
    )


def _recovery_detail(reason: str) -> str:
    head = "An earlier change did not finish restoring your memory."
    if reason == REASON_JOURNAL_FAILED:
        return (
            head
            + " We could not read the record of what to write back, so nothing new "
            "was removed. Contact support if this keeps happening."
        )
    cause = _DEPENDENCY_CAUSES.get(reason)
    if cause:
        return (
            f"{head} {cause} Nothing new was removed. Try again in a moment to "
            f"finish restoring it."
        )
    return (
        head
        + " Nothing new was removed. Try again in a moment to finish restoring it."
    )


def _now() -> str:
    """An ISO-8601 UTC timestamp for the journal entry."""
    return datetime.now(timezone.utc).isoformat()
