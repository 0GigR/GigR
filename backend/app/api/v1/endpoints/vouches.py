from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from ....core.dependencies import get_db, get_current_user
from sqlalchemy import select
from ....crud.vouch import get_vouch_by_id, get_vouches_by_vouchee, create_vouch
from ....crud.job import get_job_by_id
from ....crud.user import get_user_by_id
from ....crud.notification import create_notification
from ....models.job import Job
from ....models.vouch import Vouch
from ....schemas.vouch import VouchCreate, VouchOut
from ....models.user import User
from ....services.underdog_client import mint_vouch_cnft, UnderdogNotReady
import uuid
import logging
import asyncio as _asyncio

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/", response_model=VouchOut, status_code=status.HTTP_201_CREATED)
async def vouch_for_provider(
    vouch_data: VouchCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, vouch_data.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.client_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the client can vouch")
    if job.status != "completed":
        raise HTTPException(status_code=400, detail="Job must be completed before vouching")

    # Idempotency: one vouch per job
    from ....crud.vouch import get_vouch_by_job
    existing = await get_vouch_by_job(db, job.id)
    if existing:
        # If the existing record still has "pending", we can retry the background mint
        return existing

    provider_user = await get_user_by_id(db, job.provider_id)
    if not provider_user:
        raise HTTPException(status_code=404, detail="Provider not found")
    provider_wallet = provider_user.wallet_public_key

    # PayPal rail: no NFT. The vouch is anchored to the PayPal payout that paid
    # the provider for this job — a real, checkable reference to a completed,
    # paid-for piece of work — and is therefore final immediately.
    from ....services import paypal_escrow
    if paypal_escrow.uses_paypal(job):
        ref = job.paypal_payout_batch_id or job.paypal_capture_id or str(job.id)
        vouch = await create_vouch(
            db, job.id, current_user.id, job.provider_id, f"paypal:{ref}", f"paypal:{ref}"
        )
        await create_notification(
            db,
            user_id=job.provider_id,
            title="New Vouch Received! ⭐",
            message=f"{current_user.display_name or 'A client'} vouched for you for \"{job.title}\"!",
            link="/dashboard/profile",
            type="vouch",
        )
        await db.commit()
        await db.refresh(vouch)
        return vouch

    # Create the vouch record immediately with "pending" status
    vouch = await create_vouch(db, job.id, current_user.id, job.provider_id, "pending", "pending")
    await create_notification(
        db,
        user_id=job.provider_id,
        title="New Vouch Received! ⭐",
        message=f"{current_user.display_name or 'A client'} vouched for you for \"{job.title}\"!",
        link="/dashboard/profile",
        type="vouch",
    )
    await db.commit()
    await db.refresh(vouch)

    # Fire-and-forget the Underdog mint (uses the SAME database session via async_session)
    async def _mint_background(vouch_id):
        try:
            result = await mint_vouch_cnft(
                provider_wallet=provider_wallet,
                job_id=str(job.id)
            )
            logger.info("[vouches] Underdog result: %s", result)

            nft_id = result.get("id") or (result.get("data") or {}).get("id") or str(result)
            tx_sig = result.get("transactionSignature") or "devnet"

            # Update the vouch record using a fresh session from the main engine
            from ....core.database import async_session as _async_session
            async with _async_session() as _db:
                from sqlalchemy import update
                from ....models.vouch import Vouch
                await _db.execute(
                    update(Vouch)
                    .where(Vouch.id == vouch_id)
                    .values(cnf_nft_id=nft_id, transaction_signature=tx_sig)
                )
                await _db.commit()
            logger.info(f"[vouches] Background cNFT minted for job {job.id}: id={nft_id}")
        except UnderdogNotReady as e:
            # Expected: project not confirmed yet. Vouch stays 'pending';
            # the retry_pending_vouches_loop will heal it automatically.
            logger.info("[vouches] mint deferred (project not ready): %s — retry loop will handle it", e)
        except Exception as e:
            logger.warning(f"[vouches] Background cNFT mint failed (non-fatal): {e}")

    _asyncio.create_task(_mint_background(vouch.id))

    return vouch


@router.get("/{vouch_id}", response_model=VouchOut)
async def get_vouch(vouch_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    vouch = await get_vouch_by_id(db, vouch_id)
    if not vouch:
        raise HTTPException(status_code=404, detail="Vouch not found")
    return vouch


@router.get("/user/{user_id}", response_model=list[VouchOut])
async def user_vouches(user_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """All vouches received by a user, each enriched with the title of the job
    it was earned on (so the UI can show who vouched for what)."""
    vouches = await get_vouches_by_vouchee(db, user_id)
    if not vouches:
        return vouches
    # One aggregate query for every job title instead of N lookups.
    rows = (await db.execute(
        select(Job.id, Job.title).where(Job.id.in_([v.job_id for v in vouches]))
    )).all()
    titles = {str(job_id): title for job_id, title in rows}
    for v in vouches:
        v.job_title = titles.get(str(v.job_id))
    return vouches
