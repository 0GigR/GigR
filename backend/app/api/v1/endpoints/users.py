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


@router.get("/{user_id}", response_model=PublicUserOut)
async def get_user_by_id_route(
    user_id: str,
    db: AsyncSession = Depends(get_db),
):
    user = await get_user_by_id(db, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    return user
