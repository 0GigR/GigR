"""Self-healing engine for Gigr.

Scans the system periodically to detect and automatically heal inconsistencies across:
- Prematurely completed jobs (jobs marked completed with unreleased milestones or unpaid balances)
- Unmarked completed jobs (jobs in progress whose milestones are all released and fully paid)
- Stuck milestone review timers (milestones/jobs under review missing auto_release_at)
- Dispute and job status synchronization (open disputes with unflagged jobs, or resolved disputes)
- Orphaned provider links (jobs in progress with null provider_id)
- Stuck background agent tasks (tasks in running status past timeout)
- Stale outbound voice calls (calls hanging in uncompleted states)
- Expired password reset tokens (database hygiene purge)
- Stuck pending vouches (retries pending cNFT mints)

Adheres strictly to house-standard.md:
- No emojis anywhere in code, logs, comments, or output messages
- Queries perform filtering and aggregation directly (no fetching entire tables)
- Structured logging with [OK], [WARN], [FAIL] tags
- Portable execution: runs in-process via self_healing_loop() or standalone via scripts/run_self_heal.py
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
import logging
import time
from typing import Any, Dict, List, Optional
import uuid

from sqlalchemy import delete, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.config import settings
from ..core.database import async_session
from ..models.agent_task import AgentTask
from ..models.dispute import Dispute, DisputeStatus
from ..models.job import Job
from ..models.milestone import JobMilestone
from ..models.password_reset_token import PasswordResetToken
from ..models.voice_call import VoiceCall
from ..models.vouch import Vouch

logger = logging.getLogger(__name__)


@dataclass
class HealthCheckResult:
    """Individual subsystem check and healing report."""
    subsystem: str
    status: str  # "ok", "healed", "warning", "error"
    items_checked: int = 0
    items_healed: int = 0
    details: List[str] = field(default_factory=list)
    error_message: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class SystemHealingReport:
    """Overall system self-healing execution report."""
    timestamp: str
    duration_ms: float
    overall_status: str  # "ok", "healed", "warning", "error"
    total_checked: int
    total_healed: int
    results: List[Dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


# In-memory cache of the latest audit report for quick inspection
_last_report: Optional[SystemHealingReport] = None


def get_latest_report() -> Optional[Dict[str, Any]]:
    """Return the most recent self-healing report as a dictionary."""
    if _last_report:
        return _last_report.to_dict()
    return None


async def heal_prematurely_completed_jobs(db: AsyncSession, dry_run: bool = False) -> HealthCheckResult:
    """Revert jobs marked 'completed' that still have unreleased milestones or unpaid balances."""
    result = HealthCheckResult(subsystem="jobs_premature_completion", status="ok")
    try:
        query = select(Job).where(Job.status == "completed")
        res = await db.execute(query)
        completed_jobs = res.scalars().all()
        result.items_checked = len(completed_jobs)

        for job in completed_jobs:
            ms_res = await db.execute(
                select(JobMilestone).where(JobMilestone.job_id == job.id)
            )
            milestones = ms_res.scalars().all()
            if not milestones:
                continue

            unreleased = [m for m in milestones if m.status != "released"]
            total_released = sum(Decimal(str(m.amount or 0)) for m in milestones if m.status == "released")
            job_price = Decimal(str(job.price or 0))

            if unreleased or (job_price > 0 and total_released < job_price):
                msg = (
                    f"Job {job.id} ('{job.title}'): unreleased milestones={len(unreleased)}, "
                    f"released={total_released}/{job_price}. Reverted to in_progress."
                )
                result.details.append(msg)
                result.items_healed += 1
                if not dry_run:
                    job.status = "in_progress"
                    logger.warning("[WARN] [self_heal:jobs] %s", msg)

        if result.items_healed > 0:
            result.status = "healed"
    except Exception as exc:
        result.status = "error"
        result.error_message = str(exc)
        logger.error("[FAIL] [self_heal:jobs] Error auditing premature completions: %s", exc, exc_info=True)

    return result


async def heal_unmarked_completed_jobs(db: AsyncSession, dry_run: bool = False) -> HealthCheckResult:
    """Advance active jobs whose milestones are all released and fully paid to 'completed'."""
    result = HealthCheckResult(subsystem="jobs_unmarked_completion", status="ok")
    try:
        query = select(Job).where(Job.status.in_(["in_progress", "submitted", "funded"]))
        res = await db.execute(query)
        active_jobs = res.scalars().all()
        result.items_checked = len(active_jobs)

        for job in active_jobs:
            ms_res = await db.execute(
                select(JobMilestone).where(JobMilestone.job_id == job.id)
            )
            milestones = ms_res.scalars().all()
            if not milestones:
                continue

            all_released = all(m.status == "released" for m in milestones)
            total_released = sum(Decimal(str(m.amount or 0)) for m in milestones if m.status == "released")
            job_price = Decimal(str(job.price or 0))

            if all_released and (job_price == Decimal(0) or total_released >= job_price):
                msg = (
                    f"Job {job.id} ('{job.title}'): all {len(milestones)} milestone(s) released "
                    f"(amount={total_released}). Marked as completed."
                )
                result.details.append(msg)
                result.items_healed += 1
                if not dry_run:
                    job.status = "completed"
                    logger.info("[OK] [self_heal:jobs] %s", msg)

        if result.items_healed > 0:
            result.status = "healed"
    except Exception as exc:
        result.status = "error"
        result.error_message = str(exc)
        logger.error("[FAIL] [self_heal:jobs] Error auditing unmarked completions: %s", exc, exc_info=True)

    return result


async def heal_stuck_review_timers(db: AsyncSession, dry_run: bool = False) -> HealthCheckResult:
    """Ensure milestones or jobs under review have an active auto_release_at countdown timer."""
    result = HealthCheckResult(subsystem="review_timers", status="ok")
    now = datetime.now(timezone.utc)
    fallback_deadline = now + timedelta(seconds=settings.AUTO_RELEASE_SECONDS)

    try:
        # 1. Milestones under review missing timer
        ms_query = select(JobMilestone).where(
            JobMilestone.status == "under_review",
            JobMilestone.auto_release_at.is_(None),
        )
        ms_res = await db.execute(ms_query)
        stuck_milestones = ms_res.scalars().all()
        result.items_checked += len(stuck_milestones)

        for ms in stuck_milestones:
            msg = f"Milestone {ms.id} on job {ms.job_id} missing auto_release_at. Initialized 1h timer."
            result.details.append(msg)
            result.items_healed += 1
            if not dry_run:
                ms.auto_release_at = fallback_deadline
                if not ms.work_submitted_at:
                    ms.work_submitted_at = now
                logger.warning("[WARN] [self_heal:milestones] %s", msg)

        # 2. Jobs submitted missing timer
        job_query = select(Job).where(
            Job.status == "submitted",
            Job.auto_release_at.is_(None),
        )
        job_res = await db.execute(job_query)
        stuck_jobs = job_res.scalars().all()
        result.items_checked += len(stuck_jobs)

        for j in stuck_jobs:
            msg = f"Job {j.id} in submitted status missing auto_release_at. Initialized 1h timer."
            result.details.append(msg)
            result.items_healed += 1
            if not dry_run:
                j.auto_release_at = fallback_deadline
                if not j.work_submitted_at:
                    j.work_submitted_at = now
                logger.warning("[WARN] [self_heal:jobs] %s", msg)

        if result.items_healed > 0:
            result.status = "healed"
    except Exception as exc:
        result.status = "error"
        result.error_message = str(exc)
        logger.error("[FAIL] [self_heal:review_timers] Error auditing review timers: %s", exc, exc_info=True)

    return result


async def heal_disputed_jobs_desync(db: AsyncSession, dry_run: bool = False) -> HealthCheckResult:
    """Ensure open disputes keep the parent job in 'disputed' status, and resolved disputes release it."""
    result = HealthCheckResult(subsystem="disputes_synchronization", status="ok")
    try:
        # Check open disputes whose job is not marked 'disputed'
        query_open = (
            select(Dispute, Job)
            .join(Job, Dispute.job_id == Job.id)
            .where(
                Dispute.status == DisputeStatus.OPEN,
                Job.status != "disputed",
            )
        )
        res_open = await db.execute(query_open)
        rows_open = res_open.all()
        result.items_checked += len(rows_open)

        for dispute, job in rows_open:
            msg = f"Dispute {dispute.id} is OPEN but job {job.id} status was '{job.status}'. Synchronized to 'disputed'."
            result.details.append(msg)
            result.items_healed += 1
            if not dry_run:
                job.status = "disputed"
                logger.warning("[WARN] [self_heal:disputes] %s", msg)

        # Check disputed jobs whose disputes are all resolved
        query_disputed_jobs = select(Job).where(Job.status == "disputed")
        res_jobs = await db.execute(query_disputed_jobs)
        disputed_jobs = res_jobs.scalars().all()
        result.items_checked += len(disputed_jobs)

        for job in disputed_jobs:
            disputes_res = await db.execute(
                select(Dispute).where(Dispute.job_id == job.id)
            )
            job_disputes = disputes_res.scalars().all()
            if job_disputes and all(d.status == DisputeStatus.RESOLVED for d in job_disputes):
                # All disputes are resolved; determine resolved status
                resolutions = [d.resolution for d in job_disputes if d.resolution]
                new_status = "cancelled" if any(r == "refund" for r in resolutions) else "completed"
                msg = f"Job {job.id} was 'disputed' but all disputes are resolved. Advanced to '{new_status}'."
                result.details.append(msg)
                result.items_healed += 1
                if not dry_run:
                    job.status = new_status
                    logger.info("[OK] [self_heal:disputes] %s", msg)

        if result.items_healed > 0:
            result.status = "healed"
    except Exception as exc:
        result.status = "error"
        result.error_message = str(exc)
        logger.error("[FAIL] [self_heal:disputes] Error auditing dispute synchronization: %s", exc, exc_info=True)

    return result


async def heal_stuck_agent_tasks(db: AsyncSession, dry_run: bool = False) -> HealthCheckResult:
    """Fail or reset background agent tasks stuck in 'running' status past the timeout threshold."""
    result = HealthCheckResult(subsystem="agent_tasks", status="ok")
    timeout_seconds = max(settings.AI_AGENT_TASK_TIMEOUT_SECONDS * 2, 600)  # at least 10 minutes
    cutoff = datetime.now(timezone.utc) - timedelta(seconds=timeout_seconds)

    try:
        query = select(AgentTask).where(
            AgentTask.status == "running",
            AgentTask.created_at < cutoff,
        )
        res = await db.execute(query)
        stuck_tasks = res.scalars().all()
        result.items_checked = len(stuck_tasks)

        for task in stuck_tasks:
            msg = f"Agent task {task.id} (user={task.user_id}) stuck in 'running' since {task.created_at}. Marked as failed."
            result.details.append(msg)
            result.items_healed += 1
            if not dry_run:
                task.status = "failed"
                task.result = {
                    "error": "Task exceeded execution timeout and was auto-healed by the system.",
                    "healed_at": datetime.now(timezone.utc).isoformat(),
                }
                logger.warning("[WARN] [self_heal:agent_task] %s", msg)

        if result.items_healed > 0:
            result.status = "healed"
    except Exception as exc:
        result.status = "error"
        result.error_message = str(exc)
        logger.error("[FAIL] [self_heal:agent_task] Error auditing agent tasks: %s", exc, exc_info=True)

    return result


async def heal_stale_voice_calls(db: AsyncSession, dry_run: bool = False) -> HealthCheckResult:
    """Mark outbound voice calls that hung without receiving Twilio completion callbacks."""
    result = HealthCheckResult(subsystem="voice_calls", status="ok")
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)

    try:
        query = select(VoiceCall).where(
            VoiceCall.status.in_(["created", "queued", "initiated", "ringing", "in-progress"]),
            VoiceCall.created_at < cutoff,
        )
        res = await db.execute(query)
        stale_calls = res.scalars().all()
        result.items_checked = len(stale_calls)

        for call in stale_calls:
            msg = f"Voice call {call.id} (token={call.token}) stuck in '{call.status}' past 1 hour. Set to failed."
            result.details.append(msg)
            result.items_healed += 1
            if not dry_run:
                call.status = "failed"
                logger.warning("[WARN] [self_heal:voice] %s", msg)

        if result.items_healed > 0:
            result.status = "healed"
    except Exception as exc:
        result.status = "error"
        result.error_message = str(exc)
        logger.error("[FAIL] [self_heal:voice] Error auditing voice calls: %s", exc, exc_info=True)

    return result


async def heal_expired_password_reset_tokens(db: AsyncSession, dry_run: bool = False) -> HealthCheckResult:
    """Purge expired password reset tokens from the database to preserve hygiene and storage."""
    result = HealthCheckResult(subsystem="password_reset_tokens", status="ok")
    cutoff = datetime.now(timezone.utc) - timedelta(days=1)

    try:
        count_query = select(func.count()).select_from(PasswordResetToken).where(
            PasswordResetToken.expires_at < cutoff
        )
        count_res = await db.execute(count_query)
        expired_count = count_res.scalar_one() or 0
        result.items_checked = expired_count

        if expired_count > 0:
            msg = f"Found {expired_count} expired password reset token(s) older than 24h."
            result.details.append(msg)
            result.items_healed = expired_count
            if not dry_run:
                delete_query = delete(PasswordResetToken).where(
                    PasswordResetToken.expires_at < cutoff
                )
                await db.execute(delete_query)
                logger.info("[OK] [self_heal:auth] Purged %d expired password reset token(s).", expired_count)
            result.status = "healed"
    except Exception as exc:
        result.status = "error"
        result.error_message = str(exc)
        logger.error("[FAIL] [self_heal:auth] Error purging expired tokens: %s", exc, exc_info=True)

    return result


async def heal_stuck_vouches(db: AsyncSession, dry_run: bool = False) -> HealthCheckResult:
    """Inspect vouches with cnf_nft_id='pending' and retry minting where possible."""
    result = HealthCheckResult(subsystem="vouches", status="ok")
    try:
        query = select(Vouch).where(Vouch.cnf_nft_id == "pending").limit(20)
        res = await db.execute(query)
        pending_vouches = res.scalars().all()
        result.items_checked = len(pending_vouches)

        if pending_vouches and not dry_run:
            from .vouch_retry import _retry_once
            # Run one cycle of vouch retry
            await _retry_once()
            result.items_healed = len(pending_vouches)
            result.details.append(f"Retried minting for {len(pending_vouches)} pending vouch(es).")
            result.status = "healed"
        elif pending_vouches and dry_run:
            result.details.append(f"Identified {len(pending_vouches)} pending vouch(es) ready for mint retry.")
            result.status = "warning"
    except Exception as exc:
        result.status = "error"
        result.error_message = str(exc)
        logger.error("[FAIL] [self_heal:vouches] Error auditing vouches: %s", exc, exc_info=True)

    return result


async def run_all_heals(db: AsyncSession, dry_run: bool = False) -> SystemHealingReport:
    """Run all system self-healing tasks in a coordinated cycle.

    Each task runs within a safe sub-scope so that a failure in one subsystem
    never aborts the execution of remaining checks.
    """
    global _last_report
    start_time = time.monotonic()
    timestamp = datetime.now(timezone.utc).isoformat()

    tasks = [
        heal_prematurely_completed_jobs,
        heal_unmarked_completed_jobs,
        heal_stuck_review_timers,
        heal_disputed_jobs_desync,
        heal_stuck_agent_tasks,
        heal_stale_voice_calls,
        heal_expired_password_reset_tokens,
        heal_stuck_vouches,
    ]

    results: List[HealthCheckResult] = []
    for task_fn in tasks:
        try:
            res = await task_fn(db, dry_run=dry_run)
            results.append(res)
        except Exception as exc:
            logger.error("[FAIL] [self_heal] Task %s failed: %s", task_fn.__name__, exc, exc_info=True)
            results.append(
                HealthCheckResult(
                    subsystem=task_fn.__name__,
                    status="error",
                    error_message=str(exc),
                )
            )

    if not dry_run:
        try:
            await db.commit()
        except Exception as exc:
            await db.rollback()
            logger.error("[FAIL] [self_heal] Failed to commit self-healing updates: %s", exc, exc_info=True)

    duration_ms = round((time.monotonic() - start_time) * 1000, 2)
    total_checked = sum(r.items_checked for r in results)
    total_healed = sum(r.items_healed for r in results)

    # Determine overall status
    if any(r.status == "error" for r in results):
        overall_status = "warning" if total_healed > 0 else "error"
    elif total_healed > 0:
        overall_status = "healed"
    else:
        overall_status = "ok"

    report = SystemHealingReport(
        timestamp=timestamp,
        duration_ms=duration_ms,
        overall_status=overall_status,
        total_checked=total_checked,
        total_healed=total_healed,
        results=[r.to_dict() for r in results],
    )

    _last_report = report
    logger.info(
        "[OK] [self_heal] Cycle finished in %0.2fms: checked=%d healed=%d status=%s",
        duration_ms, total_checked, total_healed, overall_status
    )
    return report


async def self_healing_loop() -> None:
    """Periodic in-process background worker for self-healing.

    Runs every settings.SELF_HEALING_INTERVAL_SECONDS.
    Can be disabled by setting SELF_HEALING_ENABLED=false when running as an
    external cron job or standalone worker.
    """
    logger.info(
        "[OK] [self_heal] In-process loop started (interval=%ds)",
        settings.SELF_HEALING_INTERVAL_SECONDS
    )

    while True:
        try:
            await asyncio.sleep(settings.SELF_HEALING_INTERVAL_SECONDS)
            async with async_session() as db:
                await run_all_heals(db, dry_run=False)
        except asyncio.CancelledError:
            logger.info("[OK] [self_heal] In-process loop received cancel signal.")
            break
        except Exception as exc:
            logger.error("[FAIL] [self_heal] Uncaught loop error: %s", exc, exc_info=True)


if __name__ == "__main__":
    import sys
    dry = "--dry-run" in sys.argv

    async def _main():
        async with async_session() as db:
            rep = await run_all_heals(db, dry_run=dry)
            print(f"Status: {rep.overall_status.upper()} (checked {rep.total_checked}, healed {rep.total_healed} in {rep.duration_ms}ms)")
            for r in rep.results:
                badge = "[OK]" if r["status"] == "ok" else f"[{r['status'].upper()}]"
                print(f"  {badge} {r['subsystem']}: checked {r['items_checked']}, healed {r['items_healed']}")
                for d in r["details"]:
                    print(f"       -> {d}")
                if r["error_message"]:
                    print(f"       [ERROR] {r['error_message']}")

    asyncio.run(_main())
