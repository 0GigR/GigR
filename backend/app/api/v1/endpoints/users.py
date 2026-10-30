from fastapi import APIRouter, Depends, HTTPException, status, Body
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
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
    user = await update_user_location(
        db, current_user, loc.latitude, loc.longitude, loc.sync_services_mode or "all"
    )
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
    # Only meaningful on the Solana rail; on PayPal there is no wallet to show.
    from ....core.rail import current_rail
    if current_rail() != "solana":
        return {"wallet_public_key": None}
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

    from ....core.rail import current_rail
    if current_rail() != "solana":
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Wallet balances only exist on the Solana rail. Payments run through PayPal.",
        )

    USDC_MINT = settings.USDC_MINT_DEVNET

    try:
        pubkey = Pubkey.from_string(current_user.wallet_public_key)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid wallet public key")

    sol_balance = 0.0
    usdc_balance = "0.00"

    try:
        async with AsyncClient(settings.SOLANA_RPC_URL, timeout=8) as client:
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


class WalletTransferIn(BaseModel):
    recipient: str
    amount: float
    currency: str = "SOL"


@router.post("/me/transfer")
async def transfer_funds(
    data: WalletTransferIn,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Transfer SOL or USDC from user's in-app Solana wallet to another user or external address."""
    from ....core.rail import current_rail
    from ....core.config import settings
    from ....services.wallet import get_user_keypair
    from ....crud.notification import create_notification
    from solders.pubkey import Pubkey
    from solders.system_program import TransferParams, transfer
    from solders.transaction import VersionedTransaction
    from solders.message import MessageV0
    from solana.rpc.async_api import AsyncClient
    from solana.rpc.commitment import Confirmed
    from solana.rpc.types import TxOpts
    from sqlalchemy import or_ as _or

    if current_rail() != "solana":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Wallet transfers are only supported on the Solana rail.",
        )

    if data.amount <= 0:
        raise HTTPException(status_code=400, detail="Transfer amount must be greater than zero.")

    recipient_clean = data.recipient.strip().lstrip("@")
    target_user = None

    # Check if recipient is a Gigr user (by username, email, display_name, or wallet pubkey)
    user_q = await db.execute(
        select(User).where(
            _or(
                User.username == recipient_clean,
                User.email == recipient_clean,
                User.display_name == recipient_clean,
                User.wallet_public_key == recipient_clean,
            )
        )
    )
    target_user = user_q.scalar_one_or_none()

    if target_user:
        recipient_pubkey_str = target_user.wallet_public_key
    else:
        try:
            Pubkey.from_string(recipient_clean)
            recipient_pubkey_str = recipient_clean
        except Exception:
            raise HTTPException(
                status_code=404,
                detail="Recipient not found. Provide a valid Solana address or Gigr username.",
            )

    if not recipient_pubkey_str:
        raise HTTPException(status_code=400, detail="Recipient has no Solana wallet address configured.")

    if recipient_pubkey_str == current_user.wallet_public_key:
        raise HTTPException(status_code=400, detail="Cannot transfer funds to your own wallet.")

    sender_kp = get_user_keypair(current_user)
    recipient_pk = Pubkey.from_string(recipient_pubkey_str)

    currency_upper = data.currency.upper().strip()
    if currency_upper not in ("SOL", "USDC"):
        raise HTTPException(status_code=400, detail="Supported currencies are SOL and USDC.")

    tx_sig = None

    async with AsyncClient(settings.SOLANA_RPC_URL, timeout=30) as client:
        if currency_upper == "SOL":
            lamports = int(data.amount * 1_000_000_000)
            bal_res = await client.get_balance(sender_kp.pubkey())
            current_lamports = bal_res.value
            fee_lamports = 5000
            if current_lamports < (lamports + fee_lamports):
                raise HTTPException(
                    status_code=400,
                    detail=f"Insufficient SOL balance. Required: {data.amount + (fee_lamports/1e9):.6f} SOL, Available: {current_lamports/1e9:.6f} SOL",
                )

            ix = transfer(
                TransferParams(
                    from_pubkey=sender_kp.pubkey(),
                    to_pubkey=recipient_pk,
                    lamports=lamports,
                )
            )
            blockhash_resp = await client.get_latest_blockhash()
            recent_blockhash = blockhash_resp.value.blockhash
            msg = MessageV0.try_compile(
                payer=sender_kp.pubkey(),
                instructions=[ix],
                address_lookup_table_accounts=[],
                recent_blockhash=recent_blockhash,
            )
            tx = VersionedTransaction(msg, [sender_kp])
            send_res = await client.send_transaction(
                tx, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed)
            )
            tx_sig = str(send_res.value)
        else:
            # USDC transfer via SPL token.
            #
            # Every refusal below is an HTTPException with a sentence that names
            # the step that stopped it. The previous version raised a TypeError
            # here (transfer_checked was called with keyword arguments this
            # spl.token does not take); nothing caught it, so the browser got a
            # 500 with no CORS headers and reported "network request failed".
            from spl.token.instructions import get_associated_token_address
            from solana.rpc.core import RPCException
            from ....services.solana_client import ensure_ata_exists, get_platform_payer
            from ....services.wallet_transfer_service import (
                build_usdc_transfer_instruction,
                usdc_amount_atomic,
            )

            if not settings.USDC_MINT_DEVNET:
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=(
                        "USDC is not configured on this deployment, so a USDC transfer "
                        "cannot be sent. Nothing left your wallet. Use SOL instead."
                    ),
                )

            try:
                amount_base_units = usdc_amount_atomic(data.amount)
            except ValueError as exc:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        "That USDC amount cannot be sent. Enter an amount greater than "
                        "zero, no more than 1000000, with at most six decimal places. "
                        "Nothing left your wallet."
                    ),
                ) from exc

            mint_pubkey = Pubkey.from_string(settings.USDC_MINT_DEVNET)
            sender_ata = get_associated_token_address(sender_kp.pubkey(), mint_pubkey)

            # A wallet that has never held USDC has no token account for this
            # mint, and the transfer would fail at preflight with a message that
            # names no next step. Say that here instead.
            sender_account = await client.get_account_info(sender_ata)
            if sender_account.value is None:
                raise HTTPException(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    detail=(
                        "Your Gigr wallet has no USDC token account yet, so there is "
                        "nothing to send. Add USDC to this wallet first, then try again. "
                        "Nothing left your wallet."
                    ),
                )

            try:
                payer_kp = get_platform_payer()
                recipient_ata = await ensure_ata_exists(
                    payer_kp, recipient_pk, mint_pubkey
                )
            except Exception:
                logger.exception(
                    "[wallet-transfer] could not prepare the recipient USDC account "
                    "user_id=%s recipient=%s",
                    current_user.id,
                    recipient_pubkey_str,
                )
                raise HTTPException(
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                    detail=(
                        "We could not open a USDC account for the recipient, so the "
                        "transfer was not sent. Nothing left your wallet. Try again in a "
                        "moment."
                    ),
                )

            ix = build_usdc_transfer_instruction(
                source=sender_ata,
                mint=mint_pubkey,
                dest=recipient_ata,
                owner=sender_kp.pubkey(),
                amount_atomic=amount_base_units,
            )
            try:
                blockhash_resp = await client.get_latest_blockhash()
                recent_blockhash = blockhash_resp.value.blockhash
                msg = MessageV0.try_compile(
                    payer=sender_kp.pubkey(),
                    instructions=[ix],
                    address_lookup_table_accounts=[],
                    recent_blockhash=recent_blockhash,
                )
                tx = VersionedTransaction(msg, [sender_kp])
                send_res = await client.send_transaction(
                    tx, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed)
                )
                tx_sig = str(send_res.value)
            except RPCException:
                # A preflight rejection means the node simulated the transfer and
                # refused it, so nothing was submitted and nothing can move.
                logger.exception(
                    "[wallet-transfer] Solana refused the USDC transfer before sending "
                    "user_id=%s recipient=%s",
                    current_user.id,
                    recipient_pubkey_str,
                )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=(
                        "Solana refused the USDC transfer before it was sent, so no money "
                        "moved. Check the amount and the recipient address, then try "
                        "again."
                    ),
                )
            except Exception:
                # Past a preflight rejection the answer is genuinely unknown: the
                # node may have accepted the transfer and the reply may have been
                # lost. Say exactly that instead of claiming nothing was sent.
                logger.exception(
                    "[wallet-transfer] USDC transfer outcome unknown user_id=%s recipient=%s",
                    current_user.id,
                    recipient_pubkey_str,
                )
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=(
                        "We lost Solana's answer while sending the USDC transfer. Do not "
                        "send it again yet: check your wallet activity first, then try "
                        "again if nothing moved."
                    ),
                )

    if target_user:
        await create_notification(
            db,
            user_id=target_user.id,
            title="Wallet Transfer Received",
            message=f"You received {data.amount} {currency_upper} from {current_user.display_name or 'a user'}!",
            link="/dashboard/profile",
            type="wallet",
        )
        await db.commit()

    return {
        "status": "success",
        "tx_hash": tx_sig,
        "amount": data.amount,
        "currency": currency_upper,
        "recipient": recipient_pubkey_str,
    }


@router.post("/me/verify-identity")
async def verify_identity(
    turnstile_token: str = Body(..., embed=True),
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # In production, verify the turnstile_token with Cloudflare API using your SECRET_KEY
    # https://challenges.cloudflare.com/turnstile/v0/siteverify
    if not turnstile_token:
        raise HTTPException(status_code=400, detail="Invalid Turnstile token")
    
    current_user.is_verified = True
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
        select(Application, Job.title)
        .outerjoin(Job, Application.job_id == Job.id)
        .where(Application.applicant_id == current_user.id)
        .order_by(Application.created_at.desc())
    )
    applications = apps_res.all()

    # Vouches given
    vouches_given_res = await db.execute(
        select(Vouch, Job.title)
        .outerjoin(Job, Vouch.job_id == Job.id)
        .where(Vouch.voucher_id == current_user.id)
        .order_by(Vouch.created_at.desc())
    )
    vouches_given = vouches_given_res.all()

    # Vouches received
    vouches_received_res = await db.execute(
        select(Vouch, Job.title)
        .outerjoin(Job, Vouch.job_id == Job.id)
        .where(Vouch.vouchee_id == current_user.id)
        .order_by(Vouch.created_at.desc())
    )
    vouches_received = vouches_received_res.all()

    # Disputes involved in
    from sqlalchemy import or_
    disputes_res = await db.execute(
        select(Dispute, Job.title)
        .outerjoin(Job, Dispute.job_id == Job.id)
        .where(
            or_(Dispute.client_id == current_user.id, Dispute.provider_id == current_user.id)
        ).order_by(Dispute.created_at.desc())
    )
    disputes = disputes_res.all()

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
                "id": str(a.id), "job_id": str(a.job_id), "job_title": t,
                "message": a.message, "proposed_price": str(a.proposed_price) if a.proposed_price else None,
                "created_at": a.created_at.isoformat() if a.created_at else None,
                "portfolio_url": a.portfolio_url,
            }
            for a, t in applications
        ],
        "vouches_given": [
            {
                "id": str(v.id), "job_id": str(v.job_id), "job_title": t, "vouchee_id": str(v.vouchee_id),
                "cnf_nft_id": v.cnf_nft_id, "created_at": v.created_at.isoformat() if v.created_at else None,
            }
            for v, t in vouches_given
        ],
        "vouches_received": [
            {
                "id": str(v.id), "job_id": str(v.job_id), "job_title": t, "voucher_id": str(v.voucher_id),
                "cnf_nft_id": v.cnf_nft_id, "created_at": v.created_at.isoformat() if v.created_at else None,
            }
            for v, t in vouches_received
        ],
        "disputes": [
            {
                "id": str(d.id), "job_id": str(d.job_id), "job_title": t, "reason": d.reason,
                "status": d.status.value if hasattr(d.status, "value") else str(d.status),
                "resolution": d.resolution, "raised_by": str(d.raised_by),
                "created_at": d.created_at.isoformat() if d.created_at else None,
            }
            for d, t in disputes
        ],
    }


@router.get("/{user_id}", response_model=PublicUserOut)
async def get_user_by_id_route(
    user_id: str,
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import func as sqlfunc
    from ....models.rating import Rating  # noqa: keep import local to avoid circular
    from ....models.vouch import Vouch  # noqa: keep import local to avoid circular
    from ....crud.user import get_user_by_id_or_username
    import re

    user = await get_user_by_id_or_username(db, user_id)
    if not user:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="User not found")
    out = PublicUserOut.model_validate(user)
    if not getattr(user, "location_public", False):
        out.location_lat = None
        out.location_lng = None

    # Compute handle for clean portfolio URLs
    if getattr(user, "username", None):
        out.username = user.username
        out.handle = user.username
    else:
        clean_slug = re.sub(r"[^\w\s-]", "", user.display_name or "").strip().lower()
        clean_slug = re.sub(r"[-\s]+", "-", clean_slug)
        out.handle = clean_slug or str(user.id)[:8]
    # Inject computed rating stats
    rating_res = await db.execute(
        select(sqlfunc.avg(Rating.score), sqlfunc.count(Rating.id))
        .where(Rating.ratee_id == user.id)
    )
    avg, count = rating_res.one()
    out.avg_rating = round(float(avg), 1) if avg else None
    out.rating_count = count or 0
    # Inject verified-vouch count
    vouch_res = await db.execute(
        select(sqlfunc.count(Vouch.id)).where(Vouch.vouchee_id == user.id)
    )
    out.vouches_received_count = vouch_res.scalar() or 0
    return out
