from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from .api.v1.endpoints import auth, users, services, jobs, applications, vouches, disputes, messages, categories, location, ai
from .core.database import init_db, engine, Base


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
            print(f"[dedup] Cancelled {cancelled} duplicate service-request job(s)")


@app.on_event("startup")
async def on_startup():
    import asyncio
    from .services.auto_release import auto_release_loop
    from .api.v1.endpoints.ai import agent_loop

    await init_db()
    try:
        await _dedup_duplicate_jobs()
    except Exception as e:  # never block startup on cleanup
        print(f"[dedup] skipped: {e}")

    # Background scanner that auto-releases escrow after the client review window.
    asyncio.create_task(auto_release_loop())

    # AI agent background loop — picks up queued tasks and executes them
    asyncio.create_task(agent_loop())

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
    "http://localhost:5500",   # test HTML
    "http://127.0.0.1:5500",
    "http://localhost",
    "https://gigr-work.vercel.app",
]
# In production, set FRONTEND_URL env var to your Render URL, e.g. https://gigr.onrender.com
if os.getenv("FRONTEND_URL"):
    ALLOWED_ORIGINS.append(os.getenv("FRONTEND_URL"))

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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

from .api.v1.endpoints import admin

app.include_router(admin.router, prefix="/api/v1/admin", tags=["admin"])

from .api.v1.endpoints import amendments
app.include_router(amendments.router, prefix="/api/v1/amendments", tags=["amendments"])

from .api.v1.endpoints import upload
app.include_router(upload.router, prefix="/api/v1/upload", tags=["upload"])

from .api.v1.endpoints import ws_messages
app.include_router(ws_messages.router)

from .api.v1.endpoints import ai
app.include_router(ai.router, prefix="/api/v1", tags=["ai"])


@app.get("/health")
def health_check():
    return {
        "status": "healthy",
        "version": "1.0.0",
        "timestamp": datetime.utcnow().isoformat()
    }