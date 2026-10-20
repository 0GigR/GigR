#!/usr/bin/env python3
"""Standalone runner for the Gigr Self-Healing Engine.

Can be run as a one-shot cron job or a persistent background worker:
    # Run once (ideal for Linux crontab, Kubernetes CronJob, or Render cron):
    python scripts/run_self_heal.py --once

    # Run in dry-run mode (audit only, no database mutations):
    python scripts/run_self_heal.py --dry-run

    # Run as a continuous worker every 60 seconds:
    python scripts/run_self_heal.py --interval 60

Follows house-standard.md:
- No emojis anywhere in output or logs
- Machine-friendly exit codes (0 = healthy/healed, 1 = failure)
- Standard status tags: [OK], [WARN], [FAIL]
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
import time

# Ensure backend root is on sys.path
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.abspath(os.path.join(SCRIPT_DIR, ".."))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

from app.core.database import async_session
from app.services.self_healing_service import run_all_heals


async def execute_cycle(dry_run: bool, verbose: bool) -> int:
    """Execute a single self-healing cycle and output results.

    Returns:
        0 on success (healthy or successfully healed)
        1 on severe error
    """
    mode = "[DRY-RUN]" if dry_run else "[LIVE]"
    print(f"{mode} Initiating system self-healing scan...")

    async with async_session() as db:
        try:
            report = await run_all_heals(db, dry_run=dry_run)
        except Exception as exc:
            print(f"[FAIL] Self-healing cycle failed: {exc}", file=sys.stderr)
            return 1

    status_tag = f"[{report.overall_status.upper()}]"
    print(
        f"{status_tag} Scan completed in {report.duration_ms}ms "
        f"| Checked: {report.total_checked} | Repaired: {report.total_healed}"
    )

    for item in report.results:
        sub_status = f"[{item['status'].upper()}]"
        print(f"  {sub_status:<8} {item['subsystem']}: checked={item['items_checked']}, healed={item['items_healed']}")
        if verbose or item["items_healed"] > 0 or item["status"] in ("warning", "error"):
            for detail in item.get("details", []):
                print(f"           -> {detail}")
        if item.get("error_message"):
            print(f"           [ERROR] {item['error_message']}", file=sys.stderr)

    if report.overall_status == "error":
        return 1
    return 0


async def main() -> int:
    parser = argparse.ArgumentParser(description="Gigr Self-Healing Service CLI Runner")
    parser.add_argument(
        "--once",
        action="store_true",
        default=True,
        help="Run one scan cycle and exit immediately (default: True)",
    )
    parser.add_argument(
        "--interval",
        type=int,
        default=0,
        help="Run continuously every N seconds (if > 0, overrides --once)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Detect inconsistencies without committing database updates",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        default=False,
        help="Print detailed breakdown for all subsystems",
    )

    args = parser.parse_args()

    if args.interval > 0:
        print(f"[OK] Starting continuous self-healing loop (interval={args.interval}s)...")
        while True:
            await execute_cycle(dry_run=args.dry_run, verbose=args.verbose)
            await asyncio.sleep(args.interval)
        return 0

    return await execute_cycle(dry_run=args.dry_run, verbose=args.verbose)


if __name__ == "__main__":
    exit_code = asyncio.run(main())
    sys.exit(exit_code)
