import logging
from datetime import datetime

from fastapi import FastAPI

logger = logging.getLogger(__name__)
from fastapi.middleware.cors import CORSMiddleware
from .api.v1.endpoints import auth, users, services, jobs, applications, vouches, disputes, messages, categories, location, ai, notifications, push
from .core.database import init_db, engine, Base
from .core.config import settings


app = FastAPI(title="Gigr API", version="1.0.0")
# app = FastAPI(
#     title="Gigr API",
#     version="1.0.0",
#     swagger_ui_init_oauth={
#         "usePkceWithAuthorizationCodeGrant": True,
#     },
#     # Add this to trigger the padlock icon
#     openapi_tags=[],
#     # Actually the simplest way:
# )

async def _dedup_duplicate_jobs():
    """One-time cleanup: collapse redundant chats/jobs.

    Older users sometimes clicked "Request" on the same service multiple times,
    creating several non-terminal jobs (and thus several chat rooms) for a single
    client+service pair. Keep the earliest job for each (client_id, service_listing_id)
    and mark the rest as cancelled so each service shows only one chat per user.
    """
    from sqlalchemy import select
    from sqlalchemy.ext.asyncio import AsyncSession
    from .models.job import Job

    async with AsyncSession(engine) as db:
        result = await db.execute(
            select(Job)
            .where(Job.service_listing_id.isnot(None))
            .where(Job.status.notin_(["completed", "cancelled"]))
            .order_by(Job.created_at.asc())
        )
        jobs = result.scalars().all()

        seen: set = set()
        cancelled = 0
        for job in jobs:
            key = (job.client_id, job.service_listing_id)
            if key in seen:
                job.status = "cancelled"
                cancelled += 1
            else:
                seen.add(key)

        if cancelled:
            await db.commit()
            logger.info("[dedup] Cancelled %d duplicate service-request job(s)", cancelled)


from .services.self_healing_service import run_all_heals, self_healing_loop


@app.on_event("startup")
async def on_startup():
    import asyncio
    from .services.auto_release import auto_release_loop
    from .services.vouch_retry import retry_pending_vouches_loop
    from .services.nudge_loop import nudge_loop
    from .api.v1.endpoints.ai import agent_loop, proactive_loop

    await init_db()

    # System-wide self-healing audit at boot
    try:
        async with async_session() as db:
            await run_all_heals(db, dry_run=False)
    except Exception as e:
        logger.warning("[self_heal] boot audit skipped: %s", e)

    # Fail loudly at boot if the VAPID key is broken — web push was silently
    # dying for weeks because the send path swallowed the exception.
    settings.validate_vapid_key()

    # Same class of problem for the LLM: a retired model name silently degrades
    # every AI feature to its fallback. Validate and self-heal at boot.
    try:
        from .services import groq_client
        await groq_client.ensure_working_model()
    except Exception as e:  # never block startup on an LLM check
        logger.warning("[groq] model validation skipped: %s", e)

    if settings.RUN_STARTUP_CLEANUP:
        try:
            await _dedup_duplicate_jobs()
        except Exception as e:  # never block startup on cleanup
            logger.warning("[dedup] skipped: %s", e)
    else:
        logger.info("[dedup] Skipping duplicate-job cleanup (RUN_STARTUP_CLEANUP not enabled).")

    # Background scanner that auto-releases escrow after the client review window.
    asyncio.create_task(auto_release_loop())

    # AI agent background loop — picks up queued tasks and executes them
    asyncio.create_task(agent_loop())

    # Proactive hunt — what "total" autonomy promises; guarded per user per day
    asyncio.create_task(proactive_loop())

    # Retry loop that heals vouch cNFT mints stuck on 'pending'
    asyncio.create_task(retry_pending_vouches_loop())

    # Follow-up nudges: providers are waiting / your application is unanswered
    asyncio.create_task(nudge_loop())

    # Continuous self-healing loop across all subsystems (jobs, milestones, disputes, timers, tasks, auth)
    if settings.SELF_HEALING_ENABLED:
        asyncio.create_task(self_healing_loop())
    else:
        logger.info("[self_heal] In-process loop disabled (running via external cron/worker).")

# CORS
# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=["http://localhost:5173", "https://gigr.onrender.com", "http://127.0.0.1:5500/*"],
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
# )

import os

ALLOWED_ORIGINS = [
    "http://localhost:5173",   # Vite dev server
    "http://localhost:5174",   # Vite fallback port
    "http://localhost:3000",
    "http://localhost:5500",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5500",
    "http://localhost",
    "https://gigr-work.vercel.app",  # NOTE: comma was missing before — was broken!
]
# In production, set FRONTEND_URL env var to your deployed frontend URL
if os.getenv("FRONTEND_URL"):
    ALLOWED_ORIGINS.append(os.getenv("FRONTEND_URL"))
# Further frontends on this backend (e.g. a second deploy with another VITE_PAYMENT_RAIL).
ALLOWED_ORIGINS.extend(u.strip().rstrip("/") for u in settings.EXTRA_FRONTEND_URLS.split(",") if u.strip())

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def payment_rail_middleware(request, call_next):
    """Remember the caller's chosen payment rail (X-Payment-Rail) for this request."""
    from .core.rail import RAIL_HEADER, set_request_rail, reset_request_rail, set_request_origin
    token = set_request_rail(request.headers.get(RAIL_HEADER))
    origin = (request.headers.get("origin") or "").rstrip("/")
    set_request_origin(origin if origin in ALLOWED_ORIGINS else None)
    try:
        return await call_next(request)
    finally:
        reset_request_rail(token)


# Include routers
app.include_router(auth.router, prefix="/api/v1/auth", tags=["auth"])
app.include_router(users.router, prefix="/api/v1/users", tags=["users"])
app.include_router(services.router, prefix="/api/v1/services", tags=["services"])
app.include_router(jobs.router, prefix="/api/v1/jobs", tags=["jobs"])
app.include_router(applications.router, prefix="/api/v1/applications", tags=["applications"])
app.include_router(vouches.router, prefix="/api/v1/vouches", tags=["vouches"])
app.include_router(disputes.router, prefix="/api/v1/disputes", tags=["disputes"])
app.include_router(messages.router, prefix="/api/v1/messages", tags=["messages"])
app.include_router(categories.router, prefix="/api/v1/categories", tags=["categories"])
app.include_router(location.router, prefix="/api/v1/location", tags=["location"])
app.include_router(notifications.router, prefix="/api/v1/notifications", tags=["notifications"])
app.include_router(push.router, prefix="/api/v1/push", tags=["push"])

from .api.v1.endpoints import admin
app.include_router(admin.router, prefix="/api/v1/admin", tags=["admin"])

# The paid agent brief. Inert unless FEATURE_X402_AGENT_BRIEF is on and the
# endpoint has a mint and a recipient; with the flag off the route answers 404.
from .api.v1.endpoints import agent_brief
app.include_router(agent_brief.router, prefix="/api/v1/agent", tags=["agent"])

from .api.v1.endpoints import announcements
app.include_router(announcements.router, prefix="/api/v1/announcements", tags=["announcements"])

from .api.v1.endpoints import amendments
app.include_router(amendments.router, prefix="/api/v1/amendments", tags=["amendments"])

from .api.v1.endpoints import ratings
app.include_router(ratings.router, prefix="/api/v1/ratings", tags=["ratings"])

from .api.v1.endpoints import upload
app.include_router(upload.router, prefix="/api/v1/upload", tags=["upload"])

from .api.v1.endpoints import ws_messages
app.include_router(ws_messages.router)

from .api.v1.endpoints import ai
app.include_router(ai.router, prefix="/api/v1", tags=["ai"])

from .api.v1.endpoints import voice
app.include_router(voice.router, prefix="/api/v1", tags=["voice"])

from .api.v1.endpoints import payments
app.include_router(payments.config_router, prefix="/api/v1/config", tags=["config"])
app.include_router(payments.router, prefix="/api/v1/payments", tags=["payments"])


@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "version": "1.0.0",
        "timestamp": datetime.utcnow().isoformat()
    }