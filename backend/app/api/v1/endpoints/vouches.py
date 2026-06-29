from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from ....core.dependencies import get_db, get_current_user
from ....crud.vouch import get_vouch_by_id, get_vouches_by_vouchee, create_vouch
from ....crud.job import get_job_by_id
from ....schemas.vouch import VouchCreate, VouchOut
from ....models.user import User
from ....services.underdog_client import mint_vouch_cnft
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

    # Create the vouch record immediately with "pending" status
    vouch = await create_vouch(db, job.id, current_user.id, job.provider_id, "pending", "pending")
    await db.commit()
    await db.refresh(vouch)

    # Fire-and-forget the Underdog mint (uses the SAME database session via async_session)
    async def _mint_background(vouch_id):
        try:
            result = await mint_vouch_cnft(
                provider_wallet=str(job.provider_id),
                job_id=str(job.id)
            )
            print(f"[vouches] Underdog result: {result}")  # visible in uvicorn terminal

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
    return await get_vouches_by_vouchee(db, user_id)