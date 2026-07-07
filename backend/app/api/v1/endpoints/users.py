from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from ....core.dependencies import get_db, get_current_user
from ....crud.user import (
    get_user_by_id,
    update_user,
    update_user_location,
    delete_user,
)
from ....schemas.user import UserUpdate, UserOut, UserLocationUpdate, PublicUserOut
from ....models.user import User
from fastapi import Body
import logging

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/me", response_model=UserOut)
async def get_my_profile(current_user: User = Depends(get_current_user)):
    return current_user


@router.patch("/me", response_model=UserOut)
async def update_my_profile(
    updates: UserUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user = await update_user(db, current_user, updates)
    return user


@router.post("/me/location", response_model=UserOut)
async def update_my_location(
    loc: UserLocationUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    user = await update_user_location(db, current_user, loc.latitude, loc.longitude)
    return user


@router.delete("/me", status_code=status.HTTP_204_NO_CONTENT)
async def delete_my_account(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    await delete_user(db, current_user)
    return None

@router.get("/me/wallet")
async def my_wallet(current_user: User = Depends(get_current_user)):
    return {"wallet_public_key": current_user.wallet_public_key}


@router.get("/me/balance")
async def get_my_balance(current_user: User = Depends(get_current_user)):
    """
    Returns the user's on-chain SOL and USDC balances from the Helius RPC.
    SOL is returned as a float (e.g. 1.5 SOL).
    USDC is returned as a human-readable string (e.g. "12.50").
    """
    from solana.rpc.async_api import AsyncClient
    from solana.rpc.types import TokenAccountOpts
    from solders.pubkey import Pubkey
    from ....core.config import settings

    USDC_MINT = settings.USDC_MINT_DEVNET

    try:
        pubkey = Pubkey.from_string(current_user.wallet_public_key)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid wallet public key")

    sol_balance = 0.0
    usdc_balance = "0.00"

    try:
        async with AsyncClient(settings.SOLANA_RPC_URL, timeout=30) as client:
            # SOL balance
            sol_resp = await client.get_balance(pubkey)
            lamports = sol_resp.value
            sol_balance = lamports / 1_000_000_000
            logger.info(f"[balance] {current_user.wallet_public_key} SOL={sol_balance}")

            # USDC token accounts (ATA) owned by this wallet, filtered by USDC mint
            mint_pubkey = Pubkey.from_string(USDC_MINT)
            token_resp = await client.get_token_accounts_by_owner_json_parsed(
                pubkey,
                TokenAccountOpts(mint=mint_pubkey),
            )
            accounts = token_resp.value
            if accounts:
                total_usdc_raw = 0.0
                for acct in accounts:
                    ui = acct.account.data.parsed["info"]["tokenAmount"]["uiAmount"]
                    if ui is not None:
                        total_usdc_raw += float(ui)
                usdc_balance = f"{total_usdc_raw:.2f}"
                logger.info(f"[balance] {current_user.wallet_public_key} USDC={usdc_balance}")
            else:
                logger.info(f"[balance] No USDC ATA found for {current_user.wallet_public_key}")
    except Exception as exc:
        logger.warning(f"[balance] RPC query failed for {current_user.wallet_public_key}: {exc}")
        # Return zeros rather than a 500 — the UI can handle this gracefully

    return {"sol": round(sol_balance, 6), "usdc": usdc_balance}


@router.post("/me/verify-identity")
async def verify_identity(
    gateway_token: str = Body(..., embed=True),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    from ....services.civic_client import verify_civic_gateway_token
    is_valid = await verify_civic_gateway_token(gateway_token)
    if not is_valid:
        raise HTTPException(status_code=400, detail="Invalid Civic gateway token")
    current_user.civic_gateway_token = gateway_token
    current_user.is_identity_verified = True
    await db.commit()
    return {"status": "verified"}


@router.post("/me/heartbeat", status_code=204)
async def heartbeat(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update last_seen_at. Frontend calls this every ~60s while in the dashboard."""
    from sqlalchemy import update, func as sqlfunc
    await db.execute(
        update(User).where(User.id == current_user.id).values(last_seen_at=sqlfunc.now())
    )
    await db.commit()



@router.get("/me/activity")
async def my_full_activity(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Full traceable activity history for the logged-in user.
    Returns jobs (client + provider), applications, vouches given/received, disputes."""
    from sqlalchemy import select
    from ....models.job import Job
    from ....models.application import Application
    from ....models.vouch import Vouch
    from ....models.dispute import Dispute

    # Jobs as client
    jobs_client_res = await db.execute(
        select(Job).where(Job.client_id == current_user.id).order_by(Job.created_at.desc())
    )
    jobs_client = jobs_client_res.scalars().all()

    # Jobs as provider
    jobs_provider_res = await db.execute(
        select(Job).where(Job.provider_id == current_user.id).order_by(Job.created_at.desc())
    )
    jobs_provider = jobs_provider_res.scalars().all()

    # Applications submitted
    apps_res = await db.execute(
        select(Application).where(Application.applicant_id == current_user.id).order_by(Application.created_at.desc())
    )
    applications = apps_res.scalars().all()

    # Vouches given
    vouches_given_res = await db.execute(
        select(Vouch).where(Vouch.voucher_id == current_user.id).order_by(Vouch.created_at.desc())
    )
    vouches_given = vouches_given_res.scalars().all()

    # Vouches received
    vouches_received_res = await db.execute(
        select(Vouch).where(Vouch.vouchee_id == current_user.id).order_by(Vouch.created_at.desc())
    )
    vouches_received = vouches_received_res.scalars().all()

    # Disputes involved in
    from sqlalchemy import or_
    disputes_res = await db.execute(
        select(Dispute).where(
            or_(Dispute.client_id == current_user.id, Dispute.provider_id == current_user.id)
        ).order_by(Dispute.created_at.desc())
    )
    disputes = disputes_res.scalars().all()

    def job_dict(j: Job) -> dict:
        return {
            "id": str(j.id), "title": j.title, "status": j.status,
            "price": str(j.price), "created_at": j.created_at.isoformat() if j.created_at else None,
            "client_id": str(j.client_id), "provider_id": str(j.provider_id) if j.provider_id else None,
            "escrow_address": j.escrow_address, "image_url": j.image_url,
        }

    return {
        "jobs_as_client": [job_dict(j) for j in jobs_client],
        "jobs_as_provider": [job_dict(j) for j in jobs_provider],
        "applications": [
            {
                "id": str(a.id), "job_id": str(a.job_id),
                "message": a.message, "proposed_price": str(a.proposed_price) if a.proposed_price else None,
                "created_at": a.created_at.isoformat() if a.created_at else None,
                "portfolio_url": a.portfolio_url,
            }
            for a in applications
        ],
        "vouches_given": [
            {
                "id": str(v.id), "job_id": str(v.job_id), "vouchee_id": str(v.vouchee_id),
                "cnf_nft_id": v.cnf_nft_id, "created_at": v.created_at.isoformat() if v.created_at else None,
            }
            for v in vouches_given
        ],
        "vouches_received": [
            {
                "id": str(v.id), "job_id": str(v.job_id), "voucher_id": str(v.voucher_id),
                "cnf_nft_id": v.cnf_nft_id, "created_at": v.created_at.isoformat() if v.created_at else None,
            }
            for v in vouches_received
        ],
        "disputes": [
            {
                "id": str(d.id), "job_id": str(d.job_id), "reason": d.reason,
                "status": d.status.value if hasattr(d.status, "value") else str(d.status),
                "resolution": d.resolution, "raised_by": str(d.raised_by),
                "created_at": d.created_at.isoformat() if d.created_at else None,
            }
            for d in disputes
        ],
    }


@router.get("/{user_id}", response_model=PublicUserOut)
async def get_user_by_id_route(
    user_id: str,
    db: AsyncSession = Depends(get_db),
):
    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    out = PublicUserOut.model_validate(user)
    if not getattr(user, "location_public", False):
        out.location_lat = None
        out.location_lng = None
    return out
