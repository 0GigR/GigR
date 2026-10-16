from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import Optional, List
from sqlalchemy import select, and_
from sqlalchemy.ext.asyncio import AsyncSession
from ....models.milestone import JobMilestone
from ....schemas.milestone import MilestoneCreate, MilestoneOut
from ....core.dependencies import get_db, get_current_user
from ....crud.job import (
    get_job_by_id,
    create_job,
    assign_job,
    update_job_status,
    cancel_job_offchain,
    get_jobs_filtered,
    get_open_jobs_nearby,
    transition_job_status,
)
from ....crud.notification import create_notification
from ....crud.user import get_user_by_id
from ....schemas.job import JobCreate, JobOut, JobAssign
from ....models.user import User
from ....services.solana_client import get_platform_payer, init_escrow, release_escrow, cancel_escrow
from ....services.wallet import get_user_keypair as _get_user_keypair
from ....services.exchange_rate import get_ngn_usd_rate
from ....services.agent_policy import resolve_policy, within_guardrails
from ....core.config import settings
from solders.pubkey import Pubkey
from solders.keypair import Keypair
from anchorpy import Program, Provider, Wallet, Idl
import uuid
import logging
import asyncio
from datetime import datetime, timedelta, timezone
from ....models.job import Job

logger = logging.getLogger(__name__)
# ------------------------------------------------------------------
# Idempotency helper – check if a Solana account exists
# ------------------------------------------------------------------
from solana.rpc.async_api import AsyncClient as SolanaAsyncClient

async def _get_solana_account(pubkey: Pubkey) -> bool:
    """Return True if the account exists on-chain and has data."""
    try:
        async with SolanaAsyncClient(settings.SOLANA_RPC_URL) as client:
            resp = await client.get_account_info(pubkey)
            if resp.value is not None and resp.value.data:
                return True
    except Exception:
        pass
    return False

# USDC Devnet mint
USDC_MINT = Pubkey.from_string(settings.USDC_MINT_DEVNET)

router = APIRouter()


# ------------------------------------------------------------------
# Background email helper (C1 fix)
# ------------------------------------------------------------------
def _send_email_background(to_email: str, subject: str, html_content: str):
    """Fire‑and‑forget email sending. Does NOT block or fail the current request."""
    async def _send():
        try:
            from ....services.brevo_client import send_email
            await send_email(to_email, subject, html_content)
        except Exception as e:
            logger.warning(f"Background email failed: {e}")
    asyncio.create_task(_send())


@router.post("/", response_model=JobOut, status_code=status.HTTP_201_CREATED)
async def create_job_route(
    job_in: JobCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await create_job(db, current_user.id, job_in)
    await db.commit()
    await db.refresh(job)

    # Proactive agent: notify nearby providers with matching services (non-blocking)
    asyncio.create_task(_notify_matching_providers(str(job.id), current_user.display_name))

    return job


async def _notify_matching_providers(job_id: str, poster_name: str):
    """Find providers with matching services and send them a proactive notification."""
    try:
        from ....core.database import engine
        from sqlalchemy.ext.asyncio import AsyncSession
        from ....crud.job import get_job_by_id as _get_job
        from ....crud.notification import create_notification
        from ....models.service import ServiceListing
        from ....models.user import User as _User
        import re as _re
        

        async with AsyncSession(engine) as db:
            from sqlalchemy import select as _sel, or_ as _or
            job = await _get_job(db, __import__('uuid').UUID(job_id))
            if not job:
                return

            # Text-match against service titles and descriptions
            words = [w for w in _re.split(r'\W+', job.title.lower()) if len(w) > 3]
            if not words:
                return

            conditions = _or(*[
                ServiceListing.title.ilike(f"%{w}%") for w in words[:5]
            ])
            result = await db.execute(
                _sel(ServiceListing)
                .where(conditions)
                .where(ServiceListing.is_active == True)
                .where(ServiceListing.provider_id != job.client_id)
                .limit(10)
            )
            services = result.scalars().all()

            notified: set = set()
            for svc in services:
                if svc.provider_id in notified:
                    continue
                notified.add(svc.provider_id)
                
                provider = await get_user_by_id(db, svc.provider_id)
                policy = resolve_policy(provider.ai_settings if provider else None)

                if policy.can_auto_apply and await within_guardrails(
                    db, provider.id, feature="auto_apply", cap=policy.daily_apply_cap
                ):
                    # A real, typed task with structured params. This used to be
                    # task_type="generic" with the text "select_job:<id>", which
                    # the executor never parsed — it answered conversationally
                    # instead of applying, so "high" autonomy did nothing.
                    from ....models.agent_task import AgentTask
                    from ....services.agent_policy import AUTONOMY_MARKER
                    db.add(AgentTask(
                        user_id=provider.id,
                        command_text=f"Apply to “{job.title}”",
                        task_type="apply_job",
                        params={
                            "job_id": str(job_id),
                            "title": job.title,
                            AUTONOMY_MARKER: "auto_apply",
                        },
                        status="queued",
                    ))
                    logger.info(
                        "[proactive] queued auto-apply for provider=%s job=%s",
                        provider.id, job_id,
                    )
                else:
                    await create_notification(
                        db,
                        user_id=svc.provider_id,
                        title="New job matching your services",
                        message=f'{poster_name} posted a job: "{job.title}" for ₦{float(job.price):,.0f}. You might be a great fit!',
                        link=f"/dashboard/jobs?jobId={job_id}",
                        type="job",
                    )
            if notified:
                await db.commit()
                logger.info("[proactive] Notified %d providers about job %s", len(notified), job_id)
    except Exception as exc:
        logger.warning("[proactive] Failed to notify providers: %s", exc)


@router.post("/request-service/{service_id}", response_model=JobOut, status_code=status.HTTP_201_CREATED)
async def request_service(
    service_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from ....crud.service import get_service_by_id
    service = await get_service_by_id(db, service_id)
    if not service:
        raise HTTPException(status_code=404, detail="Service not found")
    if service.provider_id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot request your own service")

    # Redundancy guard: return existing active job for this service
    from sqlalchemy import select as _select
    existing_result = await db.execute(
        _select(Job)
        .where(Job.client_id == current_user.id)
        .where(Job.service_listing_id == service.id)
        .where(Job.status.notin_(["completed", "cancelled"]))
        .order_by(Job.created_at.asc())
    )
    existing_job = existing_result.scalars().first()
    if existing_job:
        return existing_job

    # Carry the listing's location onto the job so requested jobs appear on the
    # map and in radius search. These jobs used to be created location-less and
    # were therefore invisible to every geo feature.
    request_location = None
    if service.latitude is not None and service.longitude is not None:
        request_location = f"SRID=4326;POINT({service.longitude} {service.latitude})"

    job = Job(
        client_id=current_user.id,
        provider_id=service.provider_id,
        title=service.title,
        description=f"Request for service: {service.title}",
        price=service.price,
        status="requested",
        service_listing_id=service.id,
        category_id=service.category_id,
        location=request_location,
        contract_job_id=hex(uuid.uuid4().int & 0xFFFFFFFFFFFFFFFF)
    )
    db.add(job)
    await db.commit()
    await db.refresh(job)

    # Auto‑message in the chat room
    from ....crud.message import create_message
    from ....services.ws_manager import manager
    auto = await create_message(
        db, job.id, current_user.id,
        f"{current_user.display_name or 'Someone'} requested this service. Let's discuss the details!"
    )
    await manager.broadcast_new_message(auto)

    # Notify the provider so both the message-nav badge AND the bell light up.
    # (Only reached for a freshly-created job — the redundancy guard returns early.)
    await create_notification(
        db,
        user_id=service.provider_id,
        title=f"New request from {current_user.display_name or 'Someone'}",
        message=f"Someone requested your service “{service.title}”.",
        link=f"/dashboard/messages?jobId={job.id}",
        type="request",
    )
    await db.commit()

    # Background email
    provider = await get_user_by_id(db, service.provider_id)
    if provider and provider.email:
        from ....core.config import settings
        frontend_url = settings.FRONTEND_URL.rstrip('/') if settings.FRONTEND_URL else "https://gigrr.vercel.app"
        _send_email_background(
            to_email=provider.email,
            subject=f"New request for {service.title}",
            html_content=f"<p>{current_user.display_name} has requested your service <strong>{service.title}</strong>. <a href='{frontend_url}/dashboard/jobs/{job.id}'>View request</a></p>"
        )

    return job


@router.post("/{job_id}/accept-request", response_model=JobOut)
async def accept_request(
    job_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.provider_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the provider can accept")
    if job.status != "requested":
        raise HTTPException(status_code=400, detail="This job is not in a requested state")

    job.status = "assigned"
    await db.commit()
    await db.refresh(job)

    # In‑app notification via chat
    from ....crud.message import create_message
    from ....services.ws_manager import manager
    auto = await create_message(
        db, job.id, current_user.id,
        f">> {current_user.display_name or 'The provider'} accepted your request for \"{job.title}\". You can now fund the escrow."   
        )
    await manager.broadcast_new_message(auto)

    # Bell Notification to the client
    await create_notification(
        db,
        user_id=job.client_id,
        title="Request Accepted",
        message=f"{current_user.display_name or 'A provider'} accepted your request for \"{job.title}\". You can now fund the escrow.",
        link=f"/dashboard/activity",
        type="accepted",
    )

    # Background email
    client = await get_user_by_id(db, job.client_id)
    if client and client.email:
        _send_email_background(
            to_email=client.email,
            subject="Your service request was accepted",
            html_content=f"<p>{current_user.display_name} accepted your request for <strong>{job.title}</strong>. You can now fund the escrow.</p>"
        )

    return job


@router.get("/exchange-rate")
async def get_exchange_rate():
    """Returns the current NGN/USD exchange rate (cached 60 min)."""
    rate = await get_ngn_usd_rate()
    logger.info(f"[jobs] Exchange rate endpoint: {rate} NGN/USD")
    return {"ngn_per_usd": rate}


@router.get("/my-conversations", response_model=list[JobOut])
async def my_conversations(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """All jobs the user has a chat in."""
    from sqlalchemy import select as _select, or_ as _or
    from ....models.message import Message
    msg_jobs = _select(Message.job_id).where(Message.sender_id == current_user.id)
    result = await db.execute(
        _select(Job).where(_or(
            Job.client_id == current_user.id,
            Job.provider_id == current_user.id,
            Job.id.in_(msg_jobs),
        )).order_by(Job.created_at.desc())
    )
    return result.scalars().unique().all()


@router.get("/{job_id}", response_model=JobOut)
async def get_job_route(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    await _attach_application_counts(db, [job])
    return job


@router.delete("/{job_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_job(
    job_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Let the owner delete their OWN job — users own their data. Only allowed
    before any money is in escrow (open / requested / cancelled), and it cleans
    up the attached applications, messages, and scope amendments."""
    from sqlalchemy import delete as _delete
    from ....models.message import Message
    from ....models.application import Application
    from ....models.scope_amendment import ScopeAmendment
    from ....models.notification import Notification

    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    if job.client_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the job owner can delete it")
    if job.status not in ("open", "requested", "cancelled"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Only jobs without funds in escrow can be deleted — cancel it first if it's active",
        )

    for model in (Message, Application, ScopeAmendment):
        await db.execute(_delete(model).where(model.job_id == job_id))
    # Drop notifications pointing at this job's chat room.
    await db.execute(_delete(Notification).where(Notification.tag == f"chat:{job_id}"))
    await db.delete(job)
    await db.commit()
    return None


@router.get("/search/nearby", response_model=list[JobOut])
async def search_nearby_jobs(
    lat: float = Query(..., ge=-90, le=90, description="Latitude"),
    lon: float = Query(..., ge=-180, le=180, description="Longitude"),
    radius: float = Query(10.0, ge=0, le=500, description="Radius in km; 0 means no limit"),
    category_id: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Open jobs within a radius of a point, nearest first.

    The job-side twin of ``/services/search/nearby``. ``radius`` is in
    KILOMETRES (the map used to send 100000 here, which disabled filtering
    entirely). The caller's own jobs are excluded — they belong under "My Jobs".
    """
    try:
        cat = uuid.UUID(category_id) if category_id else None
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid category_id")

    return await get_open_jobs_nearby(
        db,
        latitude=lat,
        longitude=lon,
        radius_km=radius,
        exclude_user_id=current_user.id,
        category_id=cat,
        limit=limit,
        offset=offset,
    )


@router.get("/", response_model=list[JobOut])
async def list_jobs(
    status_filter: Optional[str] = Query(None, alias="status"),
    lat: Optional[float] = Query(None),
    lon: Optional[float] = Query(None),
    radius: float = Query(10.0),
    category_id: Optional[str] = Query(None),
    my: Optional[str] = Query(None),
    min_price: Optional[float] = Query(None),
    max_price: Optional[float] = Query(None),
    search: Optional[str] = Query(None, alias="search"),
    q: Optional[str] = Query(None, alias="q"),
    sort: Optional[str] = Query(None),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    client_id = None
    provider_id = None
    if my == "client":
        client_id = current_user.id
    elif my == "provider":
        provider_id = current_user.id

    result = await get_jobs_filtered(
        db,
        client_id=client_id,
        provider_id=provider_id,
        # Public browse (no "my" filter): hide the caller's own jobs — they
        # belong under "My Jobs", not in the open marketplace.
        exclude_user_id=None if (client_id or provider_id) else current_user.id,
        status=status_filter,
        category_id=uuid.UUID(category_id) if category_id else None,
        min_price=min_price,
        max_price=max_price,
        latitude=lat,
        longitude=lon,
        radius_km=radius,
        search_text=search or q,
        sort_by=sort,
        limit=limit,
        offset=offset,
    )
    # The hotness path already attached counts; fill them in for the others
    # (search, geo, "my") so the client always gets the applicant badge.
    if any(getattr(j, "applications_count", None) is None for j in result):
        await _attach_application_counts(db, result)
    return result


async def _attach_application_counts(db: AsyncSession, jobs: list) -> None:
    """Set ``applications_count`` on each job in one aggregate query."""
    from sqlalchemy import func as _func
    from ....models.application import Application
    if not jobs:
        return
    rows = (await db.execute(
        select(Application.job_id, _func.count(Application.id))
        .where(Application.job_id.in_([j.id for j in jobs]))
        .group_by(Application.job_id)
    )).all()
    counts = dict(rows)
    for j in jobs:
        j.applications_count = counts.get(j.id, 0)


@router.post("/{job_id}/assign", response_model=JobOut)
async def assign_job_route(
    job_id: uuid.UUID,
    assign_data: JobAssign,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    if job.client_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the client can assign")
    if job.status != "open":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Job is not open")

    job = await assign_job(db, job, assign_data.provider_id)
    await db.commit()
    await db.refresh(job)

    from ....crud.application import get_applications_for_job
    from ....crud.message import create_message
    from ....services.ws_manager import manager

    # In‑app notification for the hired provider
    auto = await create_message(
        db, job.id, current_user.id,
        f">> {current_user.display_name or 'The client'} hired you for \"{job.title}\"! Once they fund the escrow you can begin work."    
        )
    await manager.broadcast_new_message(auto)

    # Bell Notification to provider
    await create_notification(
        db,
        user_id=assign_data.provider_id,
        title="You're Hired!",
        message=f"{current_user.display_name or 'The client'} assigned you to \"{job.title}\".",
        link=f"/dashboard/activity",
        type="accepted",
    )

    # Background emails to rejected applicants
    try:
        all_apps = await get_applications_for_job(db, job_id)
        for app in all_apps:
            if app.applicant_id != assign_data.provider_id:
                applicant = await get_user_by_id(db, app.applicant_id)
                if applicant and applicant.email:
                    _send_email_background(
                        to_email=applicant.email,
                        subject="Job update – you were not selected",
                        html_content=f"<p>Unfortunately, another provider was chosen for the job <strong>{job.title}</strong>. Keep browsing other jobs!</p>"
                    )
    except Exception:
        pass  # non‑critical

    return job

@router.post("/{job_id}/fund", response_model=JobOut)
async def fund_job_route(
    job_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.client_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the client can fund")
    if job.status not in ("assigned", "funded"):
        raise HTTPException(status_code=400, detail="Job must be assigned before funding")
    if job.status == "funded":
        return job

    client_user = current_user
    client_kp = _get_user_keypair(client_user)
    # Capture what we need as plain locals up front — never touch ORM lazy
    # attributes after a commit/refresh (that caused MissingGreenlet 500s).
    provider_id = job.provider_id
    job_title = job.title
    provider_user = await get_user_by_id(db, provider_id)
    if not provider_user:
        raise HTTPException(status_code=404, detail="Provider not found")
    provider_pubkey = Pubkey.from_string(provider_user.wallet_public_key)

    # Guard: contract_job_id must be set
    if not job.contract_job_id:
        raise HTTPException(
            status_code=400,
            detail="This job has no contract_job_id — it was created before the Solana "
                   "integration. Please delete it and post a new job."
        )

    # Derive escrow PDA using same seeds as contract
    job_id_int = int(job.contract_job_id, 16)
    escrow_pubkey, escrow_bump = Pubkey.find_program_address(
        [b"escrow", bytes(client_kp.pubkey()), job_id_int.to_bytes(8, "little")],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID)
    )

    async def _mark_funded_and_return():
        """Idempotently flip the DB to funded, notify, and return the fresh job.
        Safe to call whether or not the row was already funded."""
        await transition_job_status(db, job_id, ["assigned", "funded"], "funded", str(escrow_pubkey))
        await create_notification(
            db,
            user_id=provider_id,
            title="Escrow Funded",
            message=f'The client has funded the escrow for "{job_title}". You can begin working!',
            link="/dashboard/activity",
            type="payment",
        )
        await db.commit()
        await db.refresh(job)
        return job

    # --- IDEMPOTENCY CHECK ---
    # If the escrow PDA already exists on-chain, the money is already escrowed.
    if await _get_solana_account(escrow_pubkey):
        return await _mark_funded_and_return()

    # Derive vault ATA
    vault_ata, _ = Pubkey.find_program_address(
        [b"vault", bytes(escrow_pubkey)],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID)
    )

    # Client ATA (source of USDC)
    client_ata, _ = Pubkey.find_program_address(
        [bytes(client_kp.pubkey()), bytes(Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")), bytes(USDC_MINT)],
        Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    )

    # Convert job price (Naira) → USDC micro-units (6 decimals)
    ngn_rate = await get_ngn_usd_rate()
    usd_amount = float(job.price) / ngn_rate
    amount = int(usd_amount * 1_000_000)
    logger.info(f"[fund] NGN rate={ngn_rate:.2f}, price=₦{job.price}, usd={usd_amount:.4f}, lamports={amount}")

    try:
        tx_sig = await init_escrow(
            client_kp=client_kp,
            client_ata=str(client_ata),
            vault_ata=str(vault_ata),
            provider_pubkey=str(provider_pubkey),
            mint=str(USDC_MINT),
            job_id=job_id_int,
            amount=amount,
            escrow_pubkey=str(escrow_pubkey),
        )
    except Exception as e:
        err_str = str(e)
        # The escrow was already created on-chain (a prior attempt succeeded
        # on-chain but failed to save). init fails with "already in use" /
        # custom program error 0x0. The money is escrowed — sync DB and succeed.
        if "already in use" in err_str or "custom program error: 0x0" in err_str:
            if await _get_solana_account(escrow_pubkey):
                return await _mark_funded_and_return()
        if "3012" in err_str or "AccountNotInitialized" in err_str or "AccountNotFound" in err_str:
            detail = "Insufficient USDC: Your wallet lacks the required USDC or the token account is not initialized. Please fund your wallet."
        elif "insufficient lamports" in err_str.lower() or "0x1" in err_str:
            detail = "Transaction failed: Insufficient SOL for network gas fees (platform wallet)."
        elif "3006" in err_str or "ConstraintSeeds" in err_str:
            detail = "Transaction failed: Incorrect PDA derivation for escrow accounts."
        elif "11001" in err_str or "getaddrinfo failed" in err_str or "ConnectError" in err_str:
            detail = "Network error: Unable to connect to the Solana network. Please try again."
        else:
            detail = f"Solana transaction failed: {err_str}"
        raise HTTPException(status_code=400, detail=detail)

    return await _mark_funded_and_return()


@router.post("/{job_id}/release", response_model=JobOut)
async def release_job_route(
    job_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    if job.client_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only the client can release")
    if job.status not in ("funded", "in_progress", "completed"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Job is not in a releasable state")
    if job.status == "completed":
        return job

    client_user = current_user
    provider_id = job.provider_id
    job_title = job.title
    provider_user = await get_user_by_id(db, provider_id)
    provider_pubkey = Pubkey.from_string(provider_user.wallet_public_key)

    # Guard: contract_job_id must be set
    if not job.contract_job_id:
        raise HTTPException(
            status_code=400,
            detail="This job has no contract_job_id — it was created before the Solana "
                   "integration. Please cancel it and create a new job."
        )

    # Derive escrow PDA and vault ATA
    job_id_int = int(job.contract_job_id, 16)
    escrow_pubkey, _ = Pubkey.find_program_address(
        [b"escrow", bytes(Pubkey.from_string(client_user.wallet_public_key)), job_id_int.to_bytes(8, 'little')],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID)
    )
    vault_ata, _ = Pubkey.find_program_address(
        [b"vault", bytes(escrow_pubkey)],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID)
    )

    async def _mark_completed_and_return():
        """Idempotently flip the DB to completed, notify, and return the fresh job."""
        await transition_job_status(db, job_id, ["funded", "in_progress"], "completed")
        await create_notification(
            db,
            user_id=provider_id,
            title="Payment Released",
            message=f'The payment for "{job_title}" has been released to your wallet.',
            link="/dashboard/activity",
            type="payment",
        )
        await db.commit()
        await db.refresh(job)
        return job

    # --- IDEMPOTENCY CHECK ---
    # If the escrow PDA no longer exists, the funds were already released.
    if not await _get_solana_account(escrow_pubkey):
        return await _mark_completed_and_return()

    # Provider ATA – derive and ensure it exists
    from spl.token.instructions import get_associated_token_address
    from ....services.solana_client import ensure_ata_exists

    provider_ata_pubkey = get_associated_token_address(provider_pubkey, USDC_MINT)
    await ensure_ata_exists(get_platform_payer(), provider_pubkey, USDC_MINT)

    try:
        client_kp = _get_user_keypair(client_user)
        tx_sig = await release_escrow(
            client_kp=client_kp,
            provider_ata=str(provider_ata_pubkey),
            vault_ata=str(vault_ata),
            escrow_address=str(escrow_pubkey),
            platform_kp=get_platform_payer()
        )
    except Exception as e:
        err_str = str(e)
        # Escrow already closed => already released on-chain. Sync DB and succeed.
        if "3012" in err_str or "AccountNotInitialized" in err_str or "AccountNotFound" in err_str:
            return await _mark_completed_and_return()
        elif "insufficient lamports" in err_str.lower() or "0x1" in err_str:
            detail = "Transaction failed: Insufficient SOL for network gas/rent fees in your wallet."
        elif "11001" in err_str or "getaddrinfo failed" in err_str or "ConnectError" in err_str:
            detail = "Network error: Unable to connect to the Solana network. Please try again."
        else:
            detail = f"Solana transaction failed: {err_str}"
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)

    return await _mark_completed_and_return()

@router.post("/{job_id}/submit-work", response_model=JobOut)
async def submit_work_route(
    job_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Provider marks the job's work as completed. This moves the job to
    in_progress and starts the auto-release timer: if the client doesn't release
    or dispute within AUTO_RELEASE_SECONDS, the background scanner releases the
    escrow to the provider automatically."""
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.provider_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the provider can submit work")
    if job.status != "funded":
        raise HTTPException(status_code=400, detail="Job must be funded before submitting work")

    now = datetime.now(timezone.utc)
    job.status = "in_progress"
    job.work_submitted_at = now
    job.auto_release_at = now + timedelta(seconds=settings.AUTO_RELEASE_SECONDS)
    await db.commit()
    await db.refresh(job)

    # In-app + email notification to the client
    from ....crud.message import create_message
    from ....services.ws_manager import manager
    auto = await create_message(
        db, job.id, current_user.id,
        f">> {current_user.display_name or 'The provider'} marked \"{job.title}\" as complete. Please review and release the escrow -- it will auto-release if no action is taken."
    )
    await manager.broadcast_new_message(auto)

    # Notification to client
    await create_notification(
        db,
        user_id=job.client_id,
        title="Work Submitted",
        message=f"{current_user.display_name or 'The provider'} submitted work for \"{job.title}\". Please review it.",
        link=f"/dashboard/activity",
        type="work",
    )

    # from ....services.brevo_client import send_email
    # Background email
    client = await get_user_by_id(db, job.client_id)
    if client and client.email:
        _send_email_background(
            to_email=client.email,
            subject=f"Work submitted for {job.title}",
            html_content=f"<p>{current_user.display_name} marked <strong>{job.title}</strong> as complete. "
                         f"Review and release the escrow, or it will auto-release after the review window.</p>"
        )
    return job

@router.post("/{job_id}/cancel", response_model=JobOut)
async def cancel_job_route(
    job_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.client_id != current_user.id and job.provider_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only involved parties can cancel")
    if job.status in ("completed", "cancelled", "disputed"):
        raise HTTPException(status_code=400, detail="Job cannot be cancelled")

    # Pre‑funding cancellation (either party)
    if job.status not in ("funded", "in_progress"):
        job = await cancel_job_offchain(db, job)

        # Notify the other party
        other_party_id = job.provider_id if current_user.id == job.client_id else job.client_id
        if other_party_id:
            await create_notification(
                db,
                user_id=other_party_id,
                title="Job Cancelled",
                message=f"\"{job.title}\" was cancelled by {current_user.display_name or 'the other party'}.",
                link=f"/dashboard/activity",
                type="cancelled",
            )

        await db.commit()
        await db.refresh(job)
        return job

    # Post‑funding: only client can cancel on‑chain
    if job.client_id != current_user.id:
        raise HTTPException(status_code=400, detail="Only client can cancel after funding")

    client_user = current_user

    # Guard: contract_job_id must be set
    if not job.contract_job_id:
        raise HTTPException(
            status_code=400,
            detail="This job has no contract_job_id — it was created before the Solana "
                   "integration. Please delete it and post a new job."
        )

    job_id_int = int(job.contract_job_id, 16)
    escrow_pubkey, _ = Pubkey.find_program_address(
        [b"escrow", bytes(Pubkey.from_string(client_user.wallet_public_key)), job_id_int.to_bytes(8, "little")],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID)
    )
    vault_ata, _ = Pubkey.find_program_address(
        [b"vault", bytes(escrow_pubkey)],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID)
    )
    from spl.token.instructions import get_associated_token_address
    client_ata = get_associated_token_address(
        Pubkey.from_string(client_user.wallet_public_key), USDC_MINT
    )

    try:
        # await cancel_escrow(
        #     client_pubkey=str(Pubkey.from_string(client_user.wallet_public_key)),
        #     client_ata=str(client_ata),
        #     vault_ata=str(vault_ata),
        #     escrow_address=str(escrow_pubkey),
        # )
        client_kp = _get_user_keypair(client_user)
        await cancel_escrow(
            client_kp=client_kp,
            client_ata=str(client_ata),
            vault_ata=str(vault_ata),
            escrow_address=str(escrow_pubkey),
            platform_kp=get_platform_payer(),      #
        )
    except Exception as e:
        err_str = str(e)
        if "3012" in err_str or "AccountNotInitialized" in err_str or "AccountNotFound" in err_str:
            detail = "Account error: One of the token accounts is missing or not initialized."
        elif "insufficient lamports" in err_str.lower() or "0x1" in err_str:
            detail = "Transaction failed: Insufficient SOL for network gas fees (platform wallet)."
        elif "11001" in err_str or "getaddrinfo failed" in err_str or "ConnectError" in err_str:
            detail = "Network error: Unable to connect to the Solana network. Please try again."
        else:
            detail = f"Solana transaction failed: {err_str}"
        raise HTTPException(status_code=400, detail=detail)

    job = await update_job_status(db, job, "cancelled")
    await db.commit()
    await db.refresh(job)
    return job


# ── Milestone / Incremental Escrow Endpoints ─────────────────────────────────

@router.get("/{job_id}/milestones", response_model=List[MilestoneOut])
async def list_job_milestones(
    job_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List all milestone escrows for a given job."""
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    result = await db.execute(
        select(JobMilestone)
        .where(JobMilestone.job_id == job_id)
        .order_by(JobMilestone.milestone_index.asc())
    )
    return result.scalars().all()


@router.post("/{job_id}/milestones", response_model=MilestoneOut, status_code=status.HTTP_201_CREATED)
async def create_job_milestone(
    job_id: uuid.UUID,
    milestone_in: MilestoneCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a new staged milestone escrow for a job."""
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if current_user.id not in (job.client_id, job.provider_id):
        raise HTTPException(status_code=403, detail="Only parties to the job can add milestones")

    existing_res = await db.execute(
        select(JobMilestone.milestone_index).where(JobMilestone.job_id == job_id)
    )
    indices = existing_res.scalars().all()
    next_index = max(indices, default=0) + 1
    idx = milestone_in.milestone_index or next_index

    milestone = JobMilestone(
        job_id=job_id,
        milestone_index=idx,
        title=milestone_in.title,
        description=milestone_in.description,
        amount=milestone_in.amount,
        status="pending",
        contract_milestone_id=hex(uuid.uuid4().int & 0xFFFFFFFFFFFFFFFF),
    )
    db.add(milestone)
    await db.commit()
    await db.refresh(milestone)

    other_user_id = job.provider_id if current_user.id == job.client_id else job.client_id
    if other_user_id:
        await create_notification(
            db,
            user_id=other_user_id,
            title="New Milestone Added",
            message=f'Milestone "{milestone.title}" (₦{float(milestone.amount):,.0f}) added to "{job.title}".',
            link=f"/dashboard/jobs",
            type="job",
        )
        await db.commit()

    return milestone


@router.post("/{job_id}/milestones/{milestone_id}/fund", response_model=MilestoneOut)
async def fund_job_milestone(
    job_id: uuid.UUID,
    milestone_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Fund an incremental milestone escrow on Solana."""
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.client_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the client can fund a milestone")
    if not job.provider_id:
        raise HTTPException(status_code=400, detail="Job must be assigned to a provider before funding milestones")

    result = await db.execute(
        select(JobMilestone).where(and_(JobMilestone.id == milestone_id, JobMilestone.job_id == job_id))
    )
    milestone = result.scalar_one_or_none()
    if not milestone:
        raise HTTPException(status_code=404, detail="Milestone not found")
    if milestone.status == "funded":
        return milestone
    if milestone.status != "pending":
        raise HTTPException(status_code=400, detail=f"Cannot fund milestone with status '{milestone.status}'")

    client_kp = _get_user_keypair(current_user)
    provider_user = await get_user_by_id(db, job.provider_id)
    if not provider_user or not provider_user.wallet_public_key:
        raise HTTPException(status_code=404, detail="Provider wallet not configured")
    provider_pubkey = Pubkey.from_string(provider_user.wallet_public_key)

    milestone_id_int = int(milestone.contract_milestone_id, 16)
    escrow_pubkey, _ = Pubkey.find_program_address(
        [b"escrow", bytes(client_kp.pubkey()), milestone_id_int.to_bytes(8, "little")],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID),
    )

    vault_ata, _ = Pubkey.find_program_address(
        [b"vault", bytes(escrow_pubkey)],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID),
    )

    client_ata, _ = Pubkey.find_program_address(
        [bytes(client_kp.pubkey()), bytes(Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")), bytes(USDC_MINT)],
        Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"),
    )

    ngn_rate = await get_ngn_usd_rate()
    usd_amount = float(milestone.amount) / ngn_rate
    amount = int(usd_amount * 1_000_000)

    account_exists = await _get_solana_account(escrow_pubkey)
    if not account_exists:
        try:
            await init_escrow(
                client_kp=client_kp,
                client_ata=str(client_ata),
                vault_ata=str(vault_ata),
                provider_pubkey=str(provider_pubkey),
                mint=str(USDC_MINT),
                job_id=milestone_id_int,
                amount=amount,
                escrow_pubkey=str(escrow_pubkey),
            )
        except Exception as e:
            err_str = str(e)
            if "already in use" in err_str or "custom program error: 0x0" in err_str:
                pass
            elif "3012" in err_str or "AccountNotInitialized" in err_str or "AccountNotFound" in err_str:
                raise HTTPException(status_code=400, detail="Insufficient USDC: Your wallet lacks the required USDC. Please fund your wallet.")
            elif "insufficient lamports" in err_str.lower() or "0x1" in err_str:
                raise HTTPException(status_code=400, detail="Transaction failed: Insufficient SOL for network gas fees.")
            else:
                raise HTTPException(status_code=400, detail=f"Solana transaction failed: {err_str}")

    milestone.status = "funded"
    milestone.escrow_address = str(escrow_pubkey)
    milestone.funded_at = datetime.now(timezone.utc)

    if job.status in ("open", "assigned"):
        job.status = "in_progress"

    await create_notification(
        db,
        user_id=job.provider_id,
        title="Milestone Escrow Funded",
        message=f'Milestone "{milestone.title}" (₦{float(milestone.amount):,.0f}) has been funded on-chain!',
        link="/dashboard/jobs",
        type="payment",
    )
    await db.commit()
    await db.refresh(milestone)
    return milestone


@router.post("/{job_id}/milestones/{milestone_id}/release", response_model=MilestoneOut)
async def release_job_milestone(
    job_id: uuid.UUID,
    milestone_id: uuid.UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Release an individual milestone escrow on Solana to the provider."""
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.client_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the client can release milestone payments")

    result = await db.execute(
        select(JobMilestone).where(and_(JobMilestone.id == milestone_id, JobMilestone.job_id == job_id))
    )
    milestone = result.scalar_one_or_none()
    if not milestone:
        raise HTTPException(status_code=404, detail="Milestone not found")
    if milestone.status == "released":
        return milestone
    if milestone.status != "funded" or not milestone.escrow_address:
        raise HTTPException(status_code=400, detail=f"Milestone is not in funded state (status={milestone.status})")

    client_kp = _get_user_keypair(current_user)
    provider_user = await get_user_by_id(db, job.provider_id)
    provider_pubkey = Pubkey.from_string(provider_user.wallet_public_key)

    from spl.token.instructions import get_associated_token_address
    provider_ata = get_associated_token_address(provider_pubkey, USDC_MINT)
    escrow_pubkey = Pubkey.from_string(milestone.escrow_address)
    vault_ata, _ = Pubkey.find_program_address(
        [b"vault", bytes(escrow_pubkey)],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID),
    )

    if await _get_solana_account(escrow_pubkey):
        try:
            await release_escrow(
                client_kp=client_kp,
                platform_kp=get_platform_payer(),
                provider_ata=str(provider_ata),
                vault_ata=str(vault_ata),
                escrow_address=str(escrow_pubkey),
            )
        except Exception as e:
            err_str = str(e)
            if "already closed" in err_str.lower() or "not found" in err_str.lower():
                pass
            else:
                raise HTTPException(status_code=400, detail=f"Solana release failed: {err_str}")

    milestone.status = "released"
    milestone.released_at = datetime.now(timezone.utc)

    # Check if all milestones are released
    all_milestones_res = await db.execute(select(JobMilestone).where(JobMilestone.job_id == job_id))
    all_milestones = all_milestones_res.scalars().all()
    if all_milestones and all(m.status == "released" for m in all_milestones):
        job.status = "completed"

    await create_notification(
        db,
        user_id=job.provider_id,
        title="Milestone Released",
        message=f'Milestone "{milestone.title}" (₦{float(milestone.amount):,.0f}) released to your wallet!',
        link="/dashboard/jobs",
        type="payment",
    )
    await db.commit()
    await db.refresh(milestone)
    return milestone