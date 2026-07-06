import logging
import uuid
from uuid import UUID
import random
from datetime import datetime, timezone
from fastapi import APIRouter, Depends, HTTPException, Header, status

logger = logging.getLogger(__name__)
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.dependencies import get_db, get_current_user
from ....core.config import settings
from ....crud.dispute import (
    get_dispute_by_id,
    get_dispute_by_job,
    create_dispute,
    resolve_dispute,
)
from ....crud.job import get_job_by_id, update_job_status
from ....crud.user import get_user_by_id, get_eligible_jurors
from ....crud.vote import create_vote, get_votes_for_dispute
from ....crud.jury_panel import create_jury_panel, is_juror
from ....models.user import User
from ....models.vote import VoteOption
from ....models.dispute import Dispute, DisputeStatus
from ....schemas.dispute import DisputeCreate, DisputeResolve, DisputeOut
from ....schemas.vote import VoteCreate, VoteOut
from ....services.solana_client import get_platform_payer, release_escrow, cancel_escrow, ensure_ata_exists
from ....services.wallet import get_user_keypair
from ....services.brevo_client import send_email
from solders.pubkey import Pubkey
from spl.token.instructions import get_associated_token_address

router = APIRouter()

# Devnet USDC mint
USDC_MINT = Pubkey.from_string(settings.USDC_MINT_DEVNET)

# Admin secret for admin-only endpoints
ADMIN_SECRET = settings.ADMIN_SECRET


async def _execute_resolution(db: AsyncSession, dispute, job, outcome: str) -> str:
    """Run the on-chain escrow action for a resolved dispute and update job status.

    outcome == "refund"  -> cancel_escrow (USDC back to client), job -> cancelled
    outcome == "release" -> release_escrow (USDC to provider),  job -> completed

    Returns the Solana transaction signature. Raises HTTPException(502) on failure.
    Mirrors the working derivation in jobs.py (vault is the [b"vault", escrow] PDA,
    NOT an SPL ATA).
    """
    client_user = await get_user_by_id(db, job.client_id)
    provider_user = await get_user_by_id(db, job.provider_id)
    client_kp = get_user_keypair(client_user)
    client_pubkey = Pubkey.from_string(client_user.wallet_public_key)
    provider_pubkey = Pubkey.from_string(provider_user.wallet_public_key)
    platform_kp = get_platform_payer()

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
    provider_ata = get_associated_token_address(provider_pubkey, USDC_MINT)

    try:
        if outcome == "refund":
            tx_sig = await cancel_escrow(
                client_kp=client_kp,
                client_ata=str(client_ata),
                vault_ata=str(vault_ata),
                escrow_address=str(escrow_pubkey),
                platform_kp = platform_kp
            )
            await update_job_status(db, job, "cancelled")
        else:  # release
            await ensure_ata_exists(client_kp, provider_pubkey, USDC_MINT)
            tx_sig = await release_escrow(
                client_kp=client_kp,
                provider_ata=str(provider_ata),
                vault_ata=str(vault_ata),
                escrow_address=str(escrow_pubkey),
                platform_kp = platform_kp
            )
            await update_job_status(db, job, "completed")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=f"Solana transaction failed: {str(e)}")

    return str(tx_sig)


# async def verify_admin(x_admin_secret: str | None = Header(None)):
#     if x_admin_secret != ADMIN_SECRET:
#         raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")
#     return True
from .admin import verify_admin
# @router.get("/", response_model=list[DisputeOut])
@router.get("/")
async def list_all_disputes(
    _: bool = Depends(verify_admin),
    db: AsyncSession = Depends(get_db),
):
    from sqlalchemy import select
    result = await db.execute(select(Dispute).order_by(Dispute.created_at.desc()))
    disputes = result.scalars().all()

    out = []
    for d in disputes:
        job = await get_job_by_id(db, d.job_id)
        client_user = await get_user_by_id(db, d.client_id)
        provider_user = await get_user_by_id(db, d.provider_id)
        out.append({
            "id": str(d.id),
            "job_id": str(d.job_id),
            "client_id": str(d.client_id),                # Required by DisputeOut
            "provider_id": str(d.provider_id),            # Required by DisputeOut
            "job_title": job.title if job else None,
            "price": str(job.price) if job else "0",
            "client_name": client_user.display_name if client_user else "Unknown",
            "provider_name": provider_user.display_name if provider_user else "Unknown",
            "reason": d.reason,
            "status": d.status.value if hasattr(d.status, "value") else str(d.status),
            "resolution": d.resolution,
            "raised_by": str(d.raised_by),
            "created_at": d.created_at.isoformat() if d.created_at else None,
        })
    return out

@router.get("/my-disputes")
async def my_disputes(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Returns disputes where the current user is the client or provider,
    enriched with job title and the other party's name."""
    from sqlalchemy import select
    result = await db.execute(
        select(Dispute)
        .where(
            (Dispute.client_id == current_user.id) | (Dispute.provider_id == current_user.id)
        )
        .order_by(Dispute.created_at.desc())
    )
    disputes = result.scalars().all()

    out = []
    for d in disputes:
        job = await get_job_by_id(db, d.job_id)
        client_user = await get_user_by_id(db, d.client_id)
        provider_user = await get_user_by_id(db, d.provider_id)
        out.append({
            "id": str(d.id),
            "job_id": str(d.job_id),
            "job_title": job.title if job else "Untitled",
            "price": str(job.price) if job else "0",
            "escrow_address": job.escrow_address if job else None,
            "reason": d.reason,
            "status": d.status.value if hasattr(d.status, "value") else str(d.status),
            "resolution": d.resolution,
            "raised_by": str(d.raised_by),
            "client_name": client_user.display_name if client_user else "Unknown",
            "provider_name": provider_user.display_name if provider_user else "Unknown",
            "created_at": d.created_at.isoformat() if d.created_at else None,
        })
    return out

@router.post("/", response_model=DisputeOut, status_code=status.HTTP_201_CREATED)
async def raise_dispute(
    dispute_data: DisputeCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    job = await get_job_by_id(db, dispute_data.job_id)
    if not job:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")
    if job.client_id != current_user.id and job.provider_id != current_user.id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only involved parties can dispute")
    if job.status == "disputed":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Dispute already exists")
    if job.status not in ("funded", "in_progress"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Can only dispute an active job")

    # Freeze the job
    await update_job_status(db, job, "disputed")
    dispute = await create_dispute(db, job.client_id, job.provider_id, dispute_data, raised_by=current_user.id)
    # dispute = await create_dispute(db, job.client_id, job.provider_id, dispute_data)
    await db.commit()

    # ---- Auto-select jury ----
    try:
        eligible = await get_eligible_jurors(db, job.location, min_vouches=1)

        # Exclude the client and provider
        candidates = [u for u in eligible if u.id not in (dispute.client_id, dispute.provider_id)]

        if len(candidates) >= 3:
            num_jurors = min(5, len(candidates))
            jurors = random.sample(candidates, num_jurors)
            await create_jury_panel(db, dispute.id, [u.id for u in jurors])
            await db.commit()

            # Notify each juror by email (non‑blocking)
            for juror in jurors:
                try:
                    await send_email(
                        to_email=juror.email,
                        subject="You have been selected as a Gigr juror",
                        html_content=f"""
                        <h2>You've Been Selected as a Juror</h2>
                        <p>A dispute has arisen in your neighbourhood for job <strong>{job.title}</strong>.</p>
                        <p>Please log into Gigr and review the case. Your vote will help decide the outcome.</p>
                        <p><a href="https://gigr.app/dashboard/disputes/{dispute.id}">View Dispute</a></p>
                        """
                    )
                except Exception:
                    pass
        else:
            # Not enough eligible jurors — flag for admin
            dispute.resolution = "pending_admin"
            await db.commit()
    except Exception as e:
        # Jury selection failed, but dispute is still created — admin can manually select
        logger.error(f"[disputes] jury auto-selection failed for dispute {dispute.id}: {e}", exc_info=True)

    return dispute

@router.post("/{dispute_id}/withdraw")
async def withdraw_dispute(
    dispute_id: UUID,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Either party can withdraw a dispute before any juror votes. The job returns
    to its previous state (funded or in_progress) so normal release can continue."""
    # I later thought that was stupid, if i didn;t raise the dispute I should not be able to withdraw it. So now only the person who raised the dispute can withdraw it.
    dispute = await get_dispute_by_id(db, dispute_id)

    if dispute.raised_by != current_user.id:
        raise HTTPException(status_code=403, detail="Only the person who raised the dispute can withdraw it")

    if not dispute:
        raise HTTPException(status_code=404, detail="Dispute not found")
    if dispute.client_id != current_user.id and dispute.provider_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only involved parties can withdraw")
    if dispute.status != "open":
        raise HTTPException(status_code=400, detail="Dispute is not open")


    # Check if any juror has already voted
    existing_votes = await get_votes_for_dispute(db, dispute_id)
    if len(existing_votes) > 0:
        raise HTTPException(status_code=400, detail="Cannot withdraw — a juror has already voted. Wait for resolution.")

    # Return job to its previous state
    job = await get_job_by_id(db, dispute.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Associated job not found")
    await update_job_status(db, job, "funded")  # Reset to funded so normal flow resumes

    # Close the dispute without resolution
    dispute.status = DisputeStatus.RESOLVED
    dispute.resolution = "withdrawn"
    dispute.resolved_at = datetime.now(timezone.utc)
    await db.commit()

    # Notify the other party
    other_user = await get_user_by_id(db, dispute.provider_id if current_user.id == dispute.client_id else dispute.client_id)
    if other_user and other_user.email:
        try:
            await send_email(
                to_email=other_user.email,
                subject=f"Dispute withdrawn for {job.title}",
                html_content=f"<p>{current_user.display_name} has withdrawn the dispute for <strong>{job.title}</strong>. The job is now back to active status.</p>"
            )
        except Exception:
            pass

    return {"message": "Dispute withdrawn. Job is now active again."}

@router.get("/my-jury")
async def my_jury_disputes(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """All disputes where the current user is a selected juror, enriched with the
    job title and whether they've already voted. Powers the jury voting page."""
    from sqlalchemy import select
    from ....models.jury_panel import JuryPanel

    panel_rows = await db.execute(
        select(JuryPanel.dispute_id).where(JuryPanel.juror_id == current_user.id)
    )
    dispute_ids = [row[0] for row in panel_rows.all()]
    if not dispute_ids:
        return []

    result = await db.execute(
        select(Dispute).where(Dispute.id.in_(dispute_ids)).order_by(Dispute.created_at.desc())
    )
    disputes = result.scalars().all()

    out = []
    for d in disputes:
        job = await get_job_by_id(db, d.job_id)
        votes = await get_votes_for_dispute(db, d.id)
        has_voted = any(v.juror_id == current_user.id for v in votes)
        out.append({
            "id": str(d.id),
            "job_id": str(d.job_id),
            "job_title": job.title if job else None,
            "reason": d.reason,
            "status": d.status.value if hasattr(d.status, "value") else str(d.status),
            "resolution": d.resolution,
            "has_voted": has_voted,
            "created_at": d.created_at.isoformat() if d.created_at else None,
        })
    return out


@router.get("/{dispute_id}", response_model=DisputeOut)
async def get_dispute(dispute_id: UUID, db: AsyncSession = Depends(get_db)):
    dispute = await get_dispute_by_id(db, dispute_id)
    if not dispute:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dispute not found")
    return dispute


@router.post("/{dispute_id}/jury/select", response_model=list[str])
async def select_jury(
    dispute_id: UUID,
    _: bool = Depends(verify_admin),
    db: AsyncSession = Depends(get_db),
):
    dispute = await get_dispute_by_id(db, dispute_id)
    if not dispute:
        raise HTTPException(status_code=404, detail="Dispute not found")
    job = await get_job_by_id(db, dispute.job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if dispute.status != "open":
        raise HTTPException(status_code=400, detail="Dispute must be open to select a jury")

    # Eligible jurors: same neighbourhood (within 5 km), at least 1 vouch
    eligible = await get_eligible_jurors(db, job.location, min_vouches=1)

    if len(eligible) < 3:
        raise HTTPException(status_code=400, detail="Not enough eligible jurors in the neighbourhood")

    # Exclude the client and provider
    candidates = [u for u in eligible if u.id not in (dispute.client_id, dispute.provider_id)]
    if len(candidates) < 3:
        raise HTTPException(status_code=400, detail="Insufficient jurors after excluding parties")

    num_jurors = min(5, len(candidates))
    jurors = random.sample(candidates, num_jurors)
    juror_ids = [str(u.id) for u in jurors]

    # Save jury panel to DB
    await create_jury_panel(db, dispute_id, [u.id for u in jurors])
    await db.commit()

    # Notify each juror by email (non‑blocking)
    for juror in jurors:
        try:
            await send_email(
                to_email=juror.email,
                subject="You have been selected as a Gigr juror",
                html_content=f"""
                <h2>You've Been Selected as a Juror</h2>
                <p>A dispute has arisen in your neighbourhood for job <strong>{job.title}</strong>.</p>
                <p>Please log into Gigr and review the case. Your vote will help decide the outcome.</p>
                <p><a href="https://gigr.app/disputes/{dispute_id}">View Dispute</a></p>
                """
            )
        except Exception:
            pass

    return juror_ids


@router.post("/{dispute_id}/vote", response_model=VoteOut)
async def cast_vote(
    dispute_id: UUID,
    vote_data: VoteCreate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    dispute = await get_dispute_by_id(db, dispute_id)
    if not dispute:
        raise HTTPException(status_code=404, detail="Dispute not found")
    if dispute.status != "open":
        raise HTTPException(status_code=400, detail="Dispute is not open for voting")

    # Only selected jurors can vote
    if not await is_juror(db, dispute_id, current_user.id):
        raise HTTPException(status_code=403, detail="You are not a juror for this dispute")

    # Prevent double voting
    existing_votes = await get_votes_for_dispute(db, dispute_id)
    if any(v.juror_id == current_user.id for v in existing_votes):
        raise HTTPException(status_code=409, detail="You have already voted")

    vote = await create_vote(db, dispute_id, current_user.id, vote_data.vote)
    await db.commit()
    await db.refresh(vote)
    return vote


@router.get("/{dispute_id}/results")
async def tally_votes(
    dispute_id: UUID,
    _: bool = Depends(verify_admin),
    db: AsyncSession = Depends(get_db),
):
    dispute = await get_dispute_by_id(db, dispute_id)
    if not dispute:
        raise HTTPException(status_code=404, detail="Dispute not found")

    votes = await get_votes_for_dispute(db, dispute_id)
    for_client = sum(1 for v in votes if v.vote == VoteOption.FOR_CLIENT)
    for_provider = sum(1 for v in votes if v.vote == VoteOption.FOR_PROVIDER)
    total = len(votes)

    if total == 0:
        return {"result": "tie", "for_client": 0, "for_provider": 0}

    if for_client > for_provider:
        outcome = "refund"
    elif for_provider > for_client:
        outcome = "release"
    else:
        outcome = "tie"
        return {"result": "tie", "for_client": for_client, "for_provider": for_provider}

    # Execute on‑chain action automatically
    job = await get_job_by_id(db, dispute.job_id)
    if not job or job.status != "disputed":
        raise HTTPException(status_code=400, detail="Job is not in disputed state")

    tx_sig = await _execute_resolution(db, dispute, job, outcome)

    # Mark dispute resolved
    dispute = await resolve_dispute(db, dispute, outcome)
    await db.commit()

    return {
        "result": outcome,
        "for_client": for_client,
        "for_provider": for_provider,
        "total": total,
        "transaction": str(tx_sig),
    }


@router.post("/{dispute_id}/resolve", response_model=DisputeOut)
async def resolve_dispute_route(
    dispute_id: UUID,
    resolution_data: DisputeResolve,
    _: bool = Depends(verify_admin),
    db: AsyncSession = Depends(get_db),
):
    dispute = await get_dispute_by_id(db, dispute_id)
    if not dispute:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Dispute not found")
    if dispute.status != "open":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Dispute already resolved")

    job = await get_job_by_id(db, dispute.job_id)
    if not job or job.status != "disputed":
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Job not in disputed state")

    # "refund" cancels the escrow; anything else (incl. "release") pays the provider.
    outcome = "refund" if resolution_data.resolution == "refund" else "release"
    await _execute_resolution(db, dispute, job, outcome)

    dispute = await resolve_dispute(db, dispute, resolution_data.resolution)
    return dispute