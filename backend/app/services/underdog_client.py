import httpx
import asyncio
import logging
from ..core.config import settings

UNDERDOG_API_URL = settings.UNDERDOG_API_URL
UNDERDOG_API_KEY = settings.UNDERDOG_API_KEY

logger = logging.getLogger(__name__)

_UNDERDOG_PROJECT_ID: int | None = None
_PROJECT_NAME = "Gigr Vouches"
# Gigr PWA logo on Cloudinary CDN (stable public URL for Underdog project + NFT image)
_GIGR_LOGO_URL = "https://res.cloudinary.com/dxssh54wy/image/upload/v1783638065/gigr_logo.png"


class UnderdogNotReady(Exception):
    """Raised when there is no CONFIRMED Underdog project to mint into yet.

    Underdog's devnet can take a long time (sometimes indefinitely) to confirm
    a newly created project. Minting into an unconfirmed project returns
    400 'Project has not been confirmed'. We treat this as a retryable state:
    the vouch stays 'pending' and the background retry loop tries again later.
    """


async def _get_confirmed_project() -> int:
    """Return the ID of a CONFIRMED 'Gigr' Underdog project.

    Never falls back to a pending project (the old bug). If no confirmed
    project exists, ensures exactly one Gigr project is being created and
    raises UnderdogNotReady so the caller retries later.
    """
    global _UNDERDOG_PROJECT_ID
    if _UNDERDOG_PROJECT_ID is not None:
        return _UNDERDOG_PROJECT_ID

    headers = {
        "Authorization": f"Bearer {UNDERDOG_API_KEY}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.get(f"{UNDERDOG_API_URL}/v2/projects", headers=headers)
        r.raise_for_status()
        projects = r.json().get("results", [])

        # 1. Prefer a confirmed Gigr project
        confirmed = [
            p for p in projects
            if p.get("status") == "confirmed" and "gigr" in (p.get("name", "").lower())
        ]
        if confirmed:
            _UNDERDOG_PROJECT_ID = confirmed[0]["id"]
            logger.info("[underdog] Using confirmed project id=%s", _UNDERDOG_PROJECT_ID)
            return _UNDERDOG_PROJECT_ID

        # 2. If a Gigr project already exists but is still pending, wait for it
        gigr_pending = [p for p in projects if "gigr" in (p.get("name", "").lower())]
        if gigr_pending:
            raise UnderdogNotReady(
                f"Gigr project id={gigr_pending[0]['id']} exists but is not confirmed yet"
            )

        # 3. No Gigr project at all — create exactly one, then wait for a later retry
        logger.info("[underdog] No Gigr project found, creating one...")
        create_r = await client.post(
            f"{UNDERDOG_API_URL}/v2/projects",
            headers=headers,
            json={
                "name": _PROJECT_NAME,
                "symbol": "VOUCH",
                "description": "On-chain reputation vouches for Gigr marketplace providers",
                "image": _GIGR_LOGO_URL,
                "compression": True,
            },
        )
        create_r.raise_for_status()
        new_id = create_r.json().get("projectId")
        raise UnderdogNotReady(f"Created Gigr project id={new_id}; awaiting confirmation")


async def mint_vouch_cnft(
    provider_wallet: str,
    job_id: str,
) -> dict:
    """
    Mints a compressed NFT (vouch) to the provider's wallet.
    Returns the API response as a dict. Raises UnderdogNotReady if there is no
    confirmed project yet (retryable).
    """
    project_id = await _get_confirmed_project()
    url = f"{UNDERDOG_API_URL}/v2/projects/{project_id}/nfts"
    headers = {
        "Authorization": f"Bearer {UNDERDOG_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "name": f"Gigr Vouch - Job {job_id[:8]}",
        "symbol": "VOUCH",
        "description": "Proof of completed work on Gigr",
        "image": _GIGR_LOGO_URL,
        "receiverAddress": provider_wallet,
        "attributes": {
            "job_id": job_id,
            "source": "gigr_escrow_release",
        },
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(url, headers=headers, json=payload)
        logger.info(f"[underdog] Response status: {response.status_code}")
        logger.info(f"[underdog] Response body: {response.text}")
        response.raise_for_status()
        data = response.json()
        logger.info(f"[underdog] Minted vouch cNFT for job {job_id}: {data}")
        logger.info(f"[underdog] Parsed response: {data}")
        return data