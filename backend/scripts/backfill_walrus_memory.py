#!/usr/bin/env python3
"""Write every existing user's history to Walrus Memory, once, safely.

Dry run first. It writes nothing at all and prints, per user, the exact sentences
a real run would store, so the wording can be reviewed before anything reaches
the relayer:

    venv/bin/python scripts/backfill_walrus_memory.py

Then, once the output reads correctly and FEATURE_AGENT_WALRUS_MEMORY is on:

    venv/bin/python scripts/backfill_walrus_memory.py --apply

The run is idempotent and resumable: a second run writes nothing new, and a run
that is killed continues from its state file instead of starting over. The state
file path, the pace and the database are printed in the banner of every run.

Exit codes: 0 done (or dry run finished), 1 a write failed or the run was
misconfigured, 2 the run refused to start (flag off, no credentials, bad pace).

Follows house-standard.md: no emoji, ASCII-only output, [OK] / [WARN] / [FAIL]
status tags, machine-friendly exit codes.
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys

# Ensure backend root is on sys.path, the way the other runners here do.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.core.config import settings
from app.core.container import build_fact_memory_service
from app.core.database import async_session, engine
from app.services.memory_backfill_service import (
    DEFAULT_REQUESTS_PER_MINUTE,
    MAX_REQUESTS_PER_MINUTE,
    BackfillState,
    MemoryBackfillService,
)
from app.services.user_history_service import UserHistoryService

DEFAULT_STATE_FILE = os.path.join(BACKEND_DIR, ".walrus_backfill_state.json")

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_REFUSED = 2


def parse_arguments(argv: list[str]) -> argparse.Namespace:
    """Parse the command line. Nothing is written and no database is touched."""
    parser = argparse.ArgumentParser(
        description=(
            "Backfill every user's facts into their Walrus Memory namespace. "
            "Without --apply it only prints what would be written."
        )
    )
    parser.add_argument(
        "--apply",
        action="store_true",
        help="write to Walrus Memory; without this the run only prints",
    )
    parser.add_argument(
        "--requests-per-minute",
        type=int,
        default=DEFAULT_REQUESTS_PER_MINUTE,
        help=(
            f"pace of writes, 1 to {MAX_REQUESTS_PER_MINUTE} "
            f"(default {DEFAULT_REQUESTS_PER_MINUTE}; the relayer allows about 60)"
        ),
    )
    parser.add_argument(
        "--state-file",
        default=DEFAULT_STATE_FILE,
        help=f"where progress is kept between runs (default {DEFAULT_STATE_FILE})",
    )
    arguments = parser.parse_args(argv)
    if not 1 <= arguments.requests_per_minute <= MAX_REQUESTS_PER_MINUTE:
        parser.error(
            f"--requests-per-minute must be between 1 and "
            f"{MAX_REQUESTS_PER_MINUTE}; the relayer allows about 60 per minute "
            f"and this run must stay well under it"
        )
    return arguments


async def run(argv: list[str]) -> int:
    """Run one backfill, or one dry run, and return the process exit code."""
    arguments = parse_arguments(argv)
    dry_run = not arguments.apply
    namespace_prefix = settings.MEMWAL_NAMESPACE_PREFIX

    print("Walrus Memory backfill")
    if dry_run:
        print("  mode: DRY RUN - nothing is written")
    else:
        print("  mode: APPLY - facts are written to Walrus Memory")
    print(f"  namespace prefix: {namespace_prefix}")
    print(f"  state file: {arguments.state_file}")

    memory = build_fact_memory_service()
    if not dry_run and not memory.enabled:
        print(
            "[FAIL] the backfill cannot write: set FEATURE_AGENT_WALRUS_MEMORY=true, "
            "MEMWAL_PRIVATE_KEY and MEMWAL_ACCOUNT_ID first"
        )
        return EXIT_REFUSED

    try:
        state = BackfillState.load(arguments.state_file, namespace_prefix)
    except ValueError as exc:
        print(f"[FAIL] {exc}")
        return EXIT_REFUSED

    async with async_session() as db:
        service = MemoryBackfillService(
            history=UserHistoryService(db),
            memory=memory,
            namespace_prefix=namespace_prefix,
            state=state,
            requests_per_minute=arguments.requests_per_minute,
            emit=print,
        )
        print(f"  pace: {service.describe_pace()}")
        print("")

        try:
            report = await service.run(dry_run=dry_run)
        except Exception as exc:  # noqa: BLE001 - report the dependency failure plainly
            print(
                f"[FAIL] the run stopped after {_progress_note(arguments.state_file)}: "
                f"{type(exc).__name__}: {exc}"
            )
            print(
                "[WARN] progress is saved; run the same command again to continue "
                "where it stopped"
            )
            return EXIT_FAILED

    print("")
    if dry_run:
        pending = report.facts_total - report.facts_recorded
        print(
            f"TOTAL: {_counted(report.users, 'user')}, "
            f"{_counted(report.facts_total, 'fact')}: "
            f"{report.facts_recorded} already recorded, {pending} would be written"
        )
        print("Nothing was written. Re-run with --apply to store these facts.")
        if report.users_missing:
            print(
                f"[WARN] {_counted(report.users_missing, 'user')} no longer existed "
                f"and were skipped"
            )
        return EXIT_OK

    print(
        f"TOTAL: {_counted(report.users, 'user')}, "
        f"{_counted(report.facts_total, 'fact')}: "
        f"{report.facts_recorded} already recorded, {report.facts_written} written, "
        f"{report.users_complete} already complete"
    )
    if report.users_missing:
        print(
            f"[WARN] {_counted(report.users_missing, 'user')} no longer existed "
            f"and were skipped"
        )
    return EXIT_OK


def _counted(value: int, singular: str) -> str:
    """Say a count with its noun, so a one-item run does not read "1 users"."""
    return f"{value} {singular}" if value == 1 else f"{value} {singular}s"


def _progress_note(state_file: str) -> str:
    """Say where the run stopped, or that nothing had been written yet."""
    if os.path.exists(state_file):
        return f"the last recorded fact (progress is in {state_file})"
    return "the first fact (no progress file was written yet)"


def main(argv: list[str] | None = None) -> int:
    """Entry point: run the backfill and always release the database pool."""
    try:
        return asyncio.run(_with_engine_disposed(argv if argv is not None else sys.argv[1:]))
    except KeyboardInterrupt:
        print("\n[WARN] interrupted; progress is saved, run the same command again")
        return EXIT_FAILED


async def _with_engine_disposed(argv: list[str]) -> int:
    try:
        return await run(argv)
    finally:
        await engine.dispose()


if __name__ == "__main__":
    sys.exit(main())
