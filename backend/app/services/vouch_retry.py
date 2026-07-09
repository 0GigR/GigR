"""Background loop that re-attempts stuck vouch cNFT mints.

A vouch row is created immediately with cnf_nft_id='pending'. The actual
Underdog mint happens in the background and can fail (most commonly because
Underdog's devnet has not confirmed our project yet -> 400 'Project has not
been confirmed'). When that happens the vouch stays 'pending'.

This loop periodically finds pending vouches and retries the mint, so they
heal automatically once Underdog confirms the project — no manual action.
"""
import asyncio
import logging

from sqlalchemy import select, update

from ..core.database import async_session
from ..models.vouch import Vouch
from ..models.user import User
from .underdog_client import mint_vouch_cnft, UnderdogNotReady

logger = logging.getLogger(__name__)

RETRY_INTERVAL_SECONDS = 300  # 5 minutes
BATCH_LIMIT = 25


async def retry_pending_vouches_loop() -> None:
    logger.info("[vouch_retry] loop started (every %ds)", RETRY_INTERVAL_SECONDS)
    while True:
        await asyncio.sleep(RETRY_INTERVAL_SECONDS)
        try:
            await _retry_once()
        except Exception as exc:  # never let the loop die
            logger.error("[vouch_retry] iteration failed: %s", exc, exc_info=True)


async def _retry_once() -> None:
    async with async_session() as db:
        result = await db.execute(
            select(Vouch).where(Vouch.cnf_nft_id == "pending").limit(BATCH_LIMIT)
        )
        pending = result.scalars().all()

    if not pending:
        return

    logger.info("[vouch_retry] retrying %d pending vouch(es)", len(pending))
    for vouch in pending:
        try:
            # Resolve the provider's wallet fresh (vouchee = provider)
            async with async_session() as db:
                prov = (
                    await db.execute(select(User).where(User.id == vouch.vouchee_id))
                ).scalar_one_or_none()
            if not prov or not prov.wallet_public_key:
                logger.warning("[vouch_retry] vouch %s has no provider wallet; skipping", vouch.id)
                continue

            result = await mint_vouch_cnft(
                provider_wallet=prov.wallet_public_key,
                job_id=str(vouch.job_id),
            )
            nft_id = result.get("id") or (result.get("data") or {}).get("id") or str(result)
            tx_sig = result.get("transactionSignature") or "devnet"

            async with async_session() as db:
                await db.execute(
                    update(Vouch).where(Vouch.id == vouch.id).values(
                        cnf_nft_id=nft_id, transaction_signature=tx_sig
                    )
                )
                await db.commit()
            logger.info("[vouch_retry] healed vouch %s -> nft=%s", vouch.id, nft_id)

        except UnderdogNotReady as exc:
            # Expected while the project is unconfirmed — stop this pass, try next cycle
            logger.info("[vouch_retry] project not ready yet (%s); will retry next cycle", exc)
            return
        except Exception as exc:
            logger.warning("[vouch_retry] mint retry failed for vouch %s: %s", vouch.id, exc)
