"""Follow-up nudges for unanswered applications.

Background loop (started from main.py's startup hook). Every
``NUDGE_INTERVAL_SECONDS`` it scans OPEN jobs that have applications and
sends reminders:

- to the client: providers applied and are waiting for a reply
- to each applicant: their application has been sitting unanswered

A nudge fires only when an application has sat for ``NUDGE_AFTER_HOURS``
without the client having replied in that applicant's discussion thread,
and each (user, job) nudge is sent at most once per
``NUDGE_COOLDOWN_HOURS`` (deduped via the notifications table).
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from ..core.config import settings
from ..core.database import async_session
from ..models.job import Job
from ..models.application import Application
from ..models.message import Message
from ..models.notification import Notification
from ..crud.notification import create_notification

logger = logging.getLogger(__name__)


def _as_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


async def _recent_nudge(db, user_id, link: str) -> bool:
    """True if this user already got this nudge within the cooldown window."""
    cutoff = datetime.now(timezone.utc) - timedelta(hours=settings.NUDGE_COOLDOWN_HOURS)
    result = await db.execute(
        select(Notification.id)
        .where(Notification.user_id == user_id)
        .where(Notification.link == link)
        .where(Notification.created_at >= cutoff)
        .limit(1)
    )
    return result.scalar_one_or_none() is not None


async def _client_replied_to(db, job_id, client_id, applicant_id) -> bool:
    """True if the client has messaged this applicant in their discussion thread."""
    result = await db.execute(
        select(Message.id)
        .where(Message.job_id == job_id)
        .where(Message.applicant_id == applicant_id)
        .where(Message.sender_id == client_id)
        .limit(1)
    )
    return result.scalar_one_or_none() is not None


async def run_nudges() -> None:
    """Scan open jobs with unanswered applications and nudge each side once."""
    async with async_session() as db:
        rows = (await db.execute(
            select(Job, Application)
            .join(Application, Application.job_id == Job.id)
            .where(Job.status == "open")
        )).all()

        by_job: dict[Job, list[Application]] = {}
        for job, app in rows:
            by_job.setdefault(job, []).append(app)

        now = datetime.now(timezone.utc)
        min_age = timedelta(hours=settings.NUDGE_AFTER_HOURS)

        for job, apps in by_job.items():
            ages = [_as_utc(a.created_at) for a in apps if a.created_at]
            if not ages:
                continue
            oldest_app = min(ages)

            # ── Client nudge: providers applied, no reply to anyone ──────────
            if now - oldest_app >= min_age:
                replied_any = False
                for a in apps:
                    if await _client_replied_to(db, job.id, job.client_id, a.applicant_id):
                        replied_any = True
                        break
                if not replied_any:
                    link = f"/dashboard/messages?jobId={job.id}&nudge=client"
                    if not await _recent_nudge(db, job.client_id, link):
                        await create_notification(
                            db,
                            user_id=job.client_id,
                            title="Providers are waiting",
                            message=f"{len(apps)} provider(s) applied to \"{job.title}\" — reply to start a conversation.",
                            link=link,
                            type="application",
                        )
                        await db.commit()
                        logger.info("[nudge] client %s nudged for job %s", job.client_id, job.id)

            # ── Applicant nudges: this specific application unanswered ───────
            for app in apps:
                created = _as_utc(app.created_at)
                if created is None or now - created < min_age:
                    continue
                if await _client_replied_to(db, job.id, job.client_id, app.applicant_id):
                    continue
                link = f"/dashboard/messages?jobId={job.id}&nudge=provider"
                if await _recent_nudge(db, app.applicant_id, link):
                    continue
                await create_notification(
                    db,
                    user_id=app.applicant_id,
                    title="Your application is waiting",
                    message=f"You applied to \"{job.title}\" — the client hasn't replied yet.",
                    link=link,
                    type="job",
                )
                await db.commit()
                logger.info("[nudge] applicant %s nudged for job %s", app.applicant_id, job.id)


async def nudge_loop() -> None:
    """Background loop — mirrors auto_release_loop / vouch_retry_loop."""
    if not settings.NUDGE_ENABLED:
        logger.info("[nudge] disabled (NUDGE_ENABLED=false)")
        return
    while True:
        try:
            await run_nudges()
        except Exception as e:  # never let a scan failure kill the loop
            logger.warning("[nudge] scan failed: %s", e)
        await asyncio.sleep(settings.NUDGE_INTERVAL_SECONDS)
