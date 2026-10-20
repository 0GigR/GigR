"""Background scanner that auto-releases escrow once the client review window lapses.

Started from main.py's startup hook via asyncio.create_task(auto_release_loop()).
Every SCAN_INTERVAL seconds it looks for jobs in `in_progress` whose `auto_release_at`
has passed and releases the escrow to the provider — the same on-chain path as the
manual POST /jobs/{id}/release route. Disputing a job moves it to `disputed`, so it
naturally drops out of this query and is never auto-released.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from solders.pubkey import Pubkey
from spl.token.instructions import get_associated_token_address

from ..core.config import settings
from ..core.database import engine
from ..models.job import Job
from ..models.milestone import JobMilestone
from ..crud.job import update_job_status, get_job_by_id
from ..crud.user import get_user_by_id
from ..crud.notification import create_notification
from .solana_client import release_escrow, ensure_ata_exists, get_platform_payer
from .wallet import get_user_keypair
from . import paypal_escrow

logger = logging.getLogger(__name__)

SCAN_INTERVAL = 60  # seconds
# Solana rail only — unset when Solana is not configured
USDC_MINT = Pubkey.from_string(settings.USDC_MINT_DEVNET) if settings.USDC_MINT_DEVNET else None


async def _release_job(db: AsyncSession, job: Job) -> None:
    if paypal_escrow.uses_paypal(job):
        # Review window lapsed with no release/dispute: pay the provider via PayPal.
        job_id = job.id
        client_id = job.client_id
        job_title = job.title
        summary = await paypal_escrow.release_to_provider(db, job, reason="auto_release")
        await create_notification(
            db,
            user_id=client_id,
            title="Escrow Auto-Released",
            message=f'The 1-hour review window for "{job_title}" has expired. Payment has been sent to the provider.',
            link="/dashboard/activity",
            type="payment",
        )
        await db.commit()  # expires the ORM row — only use plain values below
        logger.info(f"[auto_release] paid out job {job_id} via PayPal batch {summary.get('payout_batch_id')}")
        return

    if not job.contract_job_id:
        logger.warning(f"[auto_release] job {job.id} has no contract_job_id; skipping")
        return

    client_user = await get_user_by_id(db, job.client_id)
    provider_user = await get_user_by_id(db, job.provider_id)
    if not client_user or not provider_user:
        logger.warning(f"[auto_release] job {job.id} missing client/provider; skipping")
        return

    client_kp = get_user_keypair(client_user)
    platform_kp = get_platform_payer()
    client_pubkey = Pubkey.from_string(client_user.wallet_public_key)
    provider_pubkey = Pubkey.from_string(provider_user.wallet_public_key)

    job_id_int = int(job.contract_job_id, 16)
    escrow_pubkey = Pubkey.find_program_address(
        [b"escrow", bytes(client_pubkey), job_id_int.to_bytes(8, "little")],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID),
    )[0]
    vault_ata = Pubkey.find_program_address(
        [b"vault", bytes(escrow_pubkey)],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID),
    )[0]
    provider_ata = get_associated_token_address(provider_pubkey, USDC_MINT)

    await ensure_ata_exists(client_kp, provider_pubkey, USDC_MINT)
    tx_sig = await release_escrow(
        client_kp=client_kp,
        platform_kp=platform_kp,
        provider_ata=str(provider_ata),
        vault_ata=str(vault_ata),
        escrow_address=str(escrow_pubkey),
    )
    await update_job_status(db, job, "completed")
    await create_notification(
        db,
        user_id=job.provider_id,
        title="Escrow Auto-Released",
        message=f'The 1-hour review window for "{job.title}" expired. Funds have been released to your wallet!',
        link="/dashboard/activity",
        type="payment",
    )
    await create_notification(
        db,
        user_id=job.client_id,
        title="Job Auto-Completed",
        message=f'The 1-hour review window for "{job.title}" expired. Escrow has been released to the provider.',
        link="/dashboard/activity",
        type="payment",
    )
    await db.commit()
    logger.info(f"[auto_release] released escrow for job {job.id}: {tx_sig}")


async def _release_milestone(db: AsyncSession, ms: JobMilestone, job: Job) -> None:
    if ms.paypal_capture_id:
        await paypal_escrow.release_milestone(db, job, ms, reason="auto_release")
        await create_notification(
            db,
            user_id=job.client_id,
            title="Milestone Auto-Released",
            message=f'The review window for milestone "{ms.title}" expired. Funds have been sent to the provider.',
            link=f"/dashboard/messages?jobId={job.id}",
            type="payment",
        )
        await db.commit()
        logger.info(f"[auto_release] auto-released PayPal milestone {ms.id} for job {job.id}")
        return

    if not ms.escrow_address:
        logger.warning(f"[auto_release] milestone {ms.id} has no escrow_address; skipping")
        return

    client_user = await get_user_by_id(db, job.client_id)
    provider_user = await get_user_by_id(db, job.provider_id)
    if not client_user or not provider_user:
        return

    client_kp = get_user_keypair(client_user)
    platform_kp = get_platform_payer()
    client_pubkey = Pubkey.from_string(client_user.wallet_public_key)
    provider_pubkey = Pubkey.from_string(provider_user.wallet_public_key)

    provider_ata = get_associated_token_address(provider_pubkey, USDC_MINT)
    escrow_pubkey = Pubkey.from_string(ms.escrow_address)
    vault_ata = Pubkey.find_program_address(
        [b"vault", bytes(escrow_pubkey)],
        Pubkey.from_string(settings.GIGR_PROGRAM_ID),
    )[0]

    await ensure_ata_exists(client_kp, provider_pubkey, USDC_MINT)
    try:
        tx_sig = await release_escrow(
            client_kp=client_kp,
            platform_kp=platform_kp,
            provider_ata=str(provider_ata),
            vault_ata=str(vault_ata),
            escrow_address=str(escrow_pubkey),
        )
    except Exception as e:
        err_str = str(e)
        if "already closed" in err_str.lower() or "not found" in err_str.lower():
            pass
        else:
            raise

    ms.status = "released"
    ms.released_at = datetime.now(timezone.utc)
    ms.auto_release_at = None

    amount_str = f"₦{float(ms.amount or 0):,.0f}"
    await create_notification(
        db,
        user_id=job.provider_id,
        title="Milestone Auto-Released",
        message=f'Milestone "{ms.title}" ({amount_str}) has been auto-released to your wallet!',
        link=f"/dashboard/messages?jobId={job.id}",
        type="payment",
    )
    await create_notification(
        db,
        user_id=job.client_id,
        title="Milestone Auto-Released",
        message=f'The review window for milestone "{ms.title}" ({amount_str}) expired. Escrow has been released to the provider.',
        link=f"/dashboard/messages?jobId={job.id}",
        type="payment",
    )

    # Check if all milestones released
    all_ms_res = await db.execute(select(JobMilestone).where(JobMilestone.job_id == job.id))
    all_ms = all_ms_res.scalars().all()
    from decimal import Decimal
    total_released = sum(Decimal(str(m.amount or 0)) for m in all_ms if m.status == "released")
    job_price = Decimal(str(job.price or 0))
    if all_ms and all(m.status == "released" for m in all_ms) and (job_price <= 0 or total_released >= job_price):
        job.status = "completed"

    await db.commit()
    logger.info(f"[auto_release] auto-released Solana milestone {ms.id} for job {job.id}")


async def auto_release_loop() -> None:
    logger.info(f"[auto_release] scanner started (interval={SCAN_INTERVAL}s)")
    while True:
        try:
            async with AsyncSession(engine) as db:
                now = datetime.now(timezone.utc)
                result = await db.execute(
                    select(Job)
                    .where(Job.status == "in_progress")
                    .where(Job.auto_release_at.isnot(None))
                    .where(Job.auto_release_at <= now)
                )
                jobs = result.scalars().all()
                for job in jobs:
                    # Plain local: after a rollback the ORM row is expired and
                    # touching its attributes would lazy-load (MissingGreenlet).
                    job_id = job.id
                    try:
                        await _release_job(db, job)
                    except Exception as e:
                        # One bad job must not stall the loop or the others.
                        await db.rollback()
                        logger.error(f"[auto_release] failed to release job {job_id}: {e}")
                        # Back off so a persistent failure (provider has no PayPal
                        # linked, PayPal outage) isn't retried every minute.
                        try:
                            await db.execute(
                                update(Job)
                                .where(Job.id == job_id)
                                .values(auto_release_at=datetime.now(timezone.utc) + timedelta(minutes=15))
                            )
                            await db.commit()
                        except Exception:
                            await db.rollback()

                # Scan individual milestones under review
                ms_result = await db.execute(
                    select(JobMilestone)
                    .where(JobMilestone.status.in_(["under_review", "submitted"]))
                    .where(JobMilestone.auto_release_at.isnot(None))
                    .where(JobMilestone.auto_release_at <= now)
                )
                milestones = ms_result.scalars().all()
                for ms in milestones:
                    ms_id = ms.id
                    try:
                        job = await get_job_by_id(db, ms.job_id)
                        if job:
                            await _release_milestone(db, ms, job)
                    except Exception as e:
                        await db.rollback()
                        logger.error(f"[auto_release] failed to auto-release milestone {ms_id}: {e}")
                        try:
                            await db.execute(
                                update(JobMilestone)
                                .where(JobMilestone.id == ms_id)
                                .values(auto_release_at=datetime.now(timezone.utc) + timedelta(minutes=15))
                            )
                            await db.commit()
                        except Exception:
                            await db.rollback()
        except Exception as e:
            logger.error(f"[auto_release] scan iteration failed: {e}")
        await asyncio.sleep(SCAN_INTERVAL)
