"""Background scanner that auto-releases escrow once the client review window lapses.

Started from main.py's startup hook via asyncio.create_task(auto_release_loop()).
Every SCAN_INTERVAL seconds it looks for jobs in `in_progress` whose `auto_release_at`
has passed and releases the escrow to the provider — the same on-chain path as the
manual POST /jobs/{id}/release route. Disputing a job moves it to `disputed`, so it
naturally drops out of this query and is never auto-released.
"""
import asyncio
import logging
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from solders.pubkey import Pubkey
from spl.token.instructions import get_associated_token_address

from ..core.config import settings
from ..core.database import engine
from ..models.job import Job
from ..crud.job import update_job_status
from ..crud.user import get_user_by_id
from .solana_client import release_escrow, ensure_ata_exists, get_platform_payer
from .wallet import get_user_keypair

logger = logging.getLogger(__name__)

SCAN_INTERVAL = 60  # seconds
USDC_MINT = Pubkey.from_string(settings.USDC_MINT_DEVNET)


async def _release_job(db: AsyncSession, job: Job) -> None:
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
    await db.commit()
    logger.info(f"[auto_release] released escrow for job {job.id}: {tx_sig}")


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
                    try:
                        await _release_job(db, job)
                    except Exception as e:
                        # One bad job must not stall the loop or the others.
                        await db.rollback()
                        logger.error(f"[auto_release] failed to release job {job.id}: {e}")
        except Exception as e:
            logger.error(f"[auto_release] scan iteration failed: {e}")
        await asyncio.sleep(SCAN_INTERVAL)
