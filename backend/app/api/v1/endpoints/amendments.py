from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from ....core.dependencies import get_db, get_current_user
from ....crud.scope_amendment import (
    get_amendment_by_id,
    create_amendment,
    accept_amendment,
    reject_amendment,
)
from ....crud.job import get_job_by_id, update_job_status
from ....models.user import User
from ....schemas.scope_amendment import (
    ScopeAmendmentCreate,
    ScopeAmendmentOut,
    ScopeAmendmentAccept,
)
from ....services.solana_client import cancel_escrow
from ....services.wallet import get_user_keypair
from ....core.config import settings
from solders.pubkey import Pubkey
from spl.token.instructions import get_associated_token_address
import uuid
from ....core.config import settings

USDC_MINT = Pubkey.from_string(settings.USDC_MINT_DEVNET)

router = APIRouter()

@router.get("/job/{job_id}", response_model=list[ScopeAmendmentOut])
async def get_amendments_by_job(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    from sqlalchemy.future import select
    from ....models.scope_amendment import ScopeAmendment
    result = await db.execute(
        select(ScopeAmendment).where(ScopeAmendment.job_id == job_id)
    )
    amendments = result.scalars().all()
    return amendments


@router.post("/{job_id}", response_model=ScopeAmendmentOut, status_code=status.HTTP_201_CREATED)
async def propose_amendment(
    job_id: uuid.UUID,
    amendment_in: ScopeAmendmentCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job.provider_id != current_user.id and job.client_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only involved parties can propose amendments")
    if job.status in ("completed", "cancelled", "disputed"):
        raise HTTPException(status_code=400, detail="Cannot amend a job in this state")

    amendment = await create_amendment(
        db,
        job_id=job.id,
        proposed_by=amendment_in.proposed_by,
        reason=amendment_in.reason,
        new_total_price=amendment_in.new_total_price,
        additional_cost=amendment_in.additional_cost,
    )
    await db.commit()
    await db.refresh(amendment)
    return amendment


@router.post("/{amendment_id}/accept", response_model=ScopeAmendmentOut)
async def accept_amendment_route(
    amendment_id: uuid.UUID,
    accept_data: ScopeAmendmentAccept,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    amendment = await get_amendment_by_id(db, amendment_id)
    if not amendment:
        raise HTTPException(status_code=404, detail="Amendment not found")
    job = await get_job_by_id(db, amendment.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Associated job not found")
    if job.client_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the client can approve/reject amendments")
    if amendment.is_accepted is not None:
        raise HTTPException(status_code=400, detail="Amendment already decided")

    if not accept_data.accept:
        await reject_amendment(db, amendment)
        await db.commit()
        return amendment

    # Accept flow
    await accept_amendment(db, amendment)

    # If job was funded, we must cancel the old escrow first
    if job.status in ("funded", "in_progress"):
        # Derive escrow PDA and cancel it
        client_pubkey = Pubkey.from_string(current_user.wallet_public_key)
        job_id_int = int(job.contract_job_id, 16)
        escrow_pubkey = Pubkey.find_program_address(
            [b"escrow", bytes(client_pubkey), job_id_int.to_bytes(8, "little")],
            Pubkey.from_string(settings.GIGR_PROGRAM_ID),
        )[0]
        vault_ata = Pubkey.find_program_address(
            [b"vault", bytes(escrow_pubkey)],
            Pubkey.from_string(settings.GIGR_PROGRAM_ID),
        )[0]
        client_ata = get_associated_token_address(client_pubkey, USDC_MINT)
        client_kp = get_user_keypair(current_user)

        try:
            await cancel_escrow(
                client_kp=client_kp,
                client_ata=str(client_ata),
                vault_ata=str(vault_ata),
                escrow_address=str(escrow_pubkey),
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
            raise HTTPException(status_code=400, detail=detail)

        # Update job with new price and reset status to assigned so client can re‑fund
        job.price = amendment.new_total_price
        job.status = "assigned"
        job.escrow_address = None
    else:
        # Pre‑funding: just update price and reset status
        job.price = amendment.new_total_price
        job.status = "assigned"

    await db.commit()
    await db.refresh(amendment)
    return amendment