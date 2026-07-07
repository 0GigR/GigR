from fastapi import APIRouter, Depends, HTTPException, Query, status
from typing import Optional
from sqlalchemy.ext.asyncio import AsyncSession
from ....core.dependencies import get_db, get_current_user
from ....crud.job import (
    get_job_by_id,
    create_job,
    assign_job,
    update_job_status,
    cancel_job_offchain,
    get_jobs_filtered,
    transition_job_status,
)
from ....crud.notification import create_notification
from ....crud.user import get_user_by_id
from ....schemas.job import JobCreate, JobOut, JobAssign
from ....models.user import User
from ....services.solana_client import get_platform_payer, init_escrow, release_escrow, cancel_escrow
from ....services.wallet import get_user_keypair as _get_user_keypair
from ....services.exchange_rate import get_ngn_usd_rate
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
        from ..core.database import engine
        from sqlalchemy.ext.asyncio import AsyncSession
        from ..crud.job import get_job_by_id as _get_job
        from ..crud.notification import create_notification
        from ..models.service import ServiceListing
        from ..models.user import User as _User
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
                await create_notification(
                    db,
                    user_id=svc.provider_id,
                    title="New job matching your services",
                    message=f'{poster_name} posted a job: "{job.title}" for ₦{float(job.price):,.0f}. You might be a great fit!',
                    link="/dashboard/jobs",
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

    job = Job(
        client_id=current_user.id,
        provider_id=service.provider_id,
        title=service.title,
        description=f"Request for service: {service.title}",
        price=service.price,
        status="requested",
        service_listing_id=service.id,
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

    # Background email
    provider = await get_user_by_id(db, service.provider_id)
    if provider and provider.email:
        _send_email_background(
            to_email=provider.email,
            subject=f"New request for {service.title}",
            html_content=f"<p>{current_user.display_name} has requested your service <strong>{service.title}</strong>. <a href='https://gigr.app/dashboard/jobs/{job.id}'>View request</a></p>"
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
        link=f"/dashboard/activity"
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
    return job


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
    q: Optional[str] = Query(None, alias="search"),
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
        status=status_filter,
        category_id=uuid.UUID(category_id) if category_id else None,
        min_price=min_price,
        max_price=max_price,
        latitude=lat,
        longitude=lon,
        radius_km=radius,
        search_text=q,
        sort_by=sort,
        limit=limit,
        offset=offset,
    )
    return result


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
        link=f"/dashboard/activity"
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
    if job.status != "assigned":
        raise HTTPException(status_code=400, detail="Job must be assigned before funding")
    if job.status == "funded":
        return job

    client_user = current_user
    client_kp = _get_user_keypair(client_user)
    provider_user = await get_user_by_id(db, job.provider_id)
    if not provider_user:
        raise HTTPException(status_code=404, detail="Provider not found")
    provider_pubkey = Pubkey.from_string(provider_user.wallet_public_key)

    # Guard: contract_job_id must be set (NULL = job was created before Solana integration)
    if not job.contract_job_id:
        raise HTTPException(
            status_code=400,
            detail="This job has no contract_job_id — it was created before the Solana "
                   "integration. Please delete it and post a new job."
        )

    # Derive escrow PDA
    job_id_int = int(job.contract_job_id, 16)   # reliable hex field
    escrow_pubkey, escrow_bump = Pubkey.find_program_address(
        [b"escrow", bytes(client_kp.pubkey()), job_id_int.to_bytes(8, "little")],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID)
    )

    # Derive vault ATA (custom PDA, not standard SPL ATA)
    vault_ata, _ = Pubkey.find_program_address(
        [b"vault", bytes(escrow_pubkey)],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID)
    )

    # Client ATA (source of USDC)
    client_ata, _ = Pubkey.find_program_address(
        [bytes(client_kp.pubkey()), bytes(Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")), bytes(USDC_MINT)],
        Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
    )

    # Convert job price (Naira) → USDC micro-units (6 decimals) using live exchange rate
    ngn_rate = await get_ngn_usd_rate()
    usd_amount = float(job.price) / ngn_rate
    amount = int(usd_amount * 1_000_000)
    logger.info(f"[fund] NGN rate={ngn_rate:.2f}, price=₦{job.price}, usd={usd_amount:.4f}, lamports={amount}")
    logger.debug(
        "[fund] job=%s client=%s provider=%s ata=%s vault=%s amount=%d (₦%s @ %.2f NGN/USD)",
        job_id, client_kp.pubkey(), provider_pubkey, client_ata, vault_ata, amount, job.price, ngn_rate,
    )

    try:
        tx_sig = await init_escrow(
            client_kp=client_kp,
            client_ata=str(client_ata),
            vault_ata=str(vault_ata),
            provider_pubkey=str(provider_pubkey),
            mint=str(USDC_MINT),
            job_id=job_id_int,
            amount=amount,
            escrow_pubkey=str(escrow_pubkey),   # PDA derived above — must be passed explicitly
        )
    except Exception as e:
        err_str = str(e)
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

    if not await transition_job_status(db, job_id, ["assigned"], "funded", str(escrow_pubkey)):
        raise HTTPException(status_code=409, detail="Job was already funded by a concurrent request")
    db.expire(job)

    # Notification to provider
    await create_notification(
        db,
        user_id=job.provider_id,
        title="Escrow Funded",
        message=f"The client has funded the escrow for \"{job.title}\". You can begin working!",
        link=f"/dashboard/activity"
    )

    await db.commit()
    await db.refresh(job)
    return job


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
    if job.status not in ("funded", "in_progress"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Job is not in a releasable state")

    # Idempotency
    if job.status == "completed":
        return job

    client_user = current_user
    provider_user = await get_user_by_id(db, job.provider_id)
    provider_pubkey = Pubkey.from_string(provider_user.wallet_public_key)

    # Guard: contract_job_id must be set (old jobs won't have it)
    if not job.contract_job_id:
        raise HTTPException(
            status_code=400,
            detail="This job has no contract_job_id — it was created before the Solana "
                   "integration. Please cancel it and create a new job."
        )

    # Derive the escrow PDA using the same contract_job_id used at funding time
    job_id_int = int(job.contract_job_id, 16)
    escrow_pubkey = Pubkey.find_program_address(
        [b"escrow", bytes(Pubkey.from_string(client_user.wallet_public_key)), job_id_int.to_bytes(8, 'little')],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID)
    )[0]

    # Derive vault ATA owned by escrow PDA
    vault_ata = Pubkey.find_program_address(
        [b"vault", bytes(escrow_pubkey)],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID)
    )[0]


    try:
        from spl.token.instructions import get_associated_token_address
        from ....services.solana_client import ensure_ata_exists

        client_kp = _get_user_keypair(client_user)

        # Derive provider ATA the canonical way, then create it if missing
        provider_ata_pubkey = get_associated_token_address(provider_pubkey, USDC_MINT)
        # await ensure_ata_exists(client_kp, provider_pubkey, USDC_MINT)
        await ensure_ata_exists(get_platform_payer(), provider_pubkey, USDC_MINT)

        tx_sig = await release_escrow(
            client_kp=client_kp,
            provider_ata=str(provider_ata_pubkey),
            vault_ata=str(vault_ata),
            escrow_address=str(escrow_pubkey), 
            platform_kp = get_platform_payer()
        )
    except Exception as e:
        err_str = str(e)
        if "3012" in err_str or "AccountNotInitialized" in err_str or "AccountNotFound" in err_str:
            detail = "Account error: One of the token accounts is missing or not initialized."
        elif "insufficient lamports" in err_str.lower() or "0x1" in err_str:
            detail = "Transaction failed: Insufficient SOL for network gas/rent fees in your wallet."
        elif "11001" in err_str or "getaddrinfo failed" in err_str or "ConnectError" in err_str:
            detail = "Network error: Unable to connect to the Solana network. Please try again."
        else:
            detail = f"Solana transaction failed: {err_str}"
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)

    if not await transition_job_status(db, job_id, ["funded", "in_progress"], "completed"):
        raise HTTPException(status_code=409, detail="Job was already completed by a concurrent request")
    db.expire(job)

    # Notification to provider
    await create_notification(
        db,
        user_id=job.provider_id,
        title="Payment Released",
        message=f"The payment for \"{job.title}\" has been released to your wallet.",
        link=f"/dashboard/activity"
    )

    await db.commit()
    await db.refresh(job)
    return job

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
        link=f"/dashboard/activity"
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
                link=f"/dashboard/activity"
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