import httpx
import asyncio
import logging
from ..core.config import settings

UNDERDOG_API_URL = settings.UNDERDOG_API_URL
UNDERDOG_API_KEY = settings.UNDERDOG_API_KEY

logger = logging.getLogger(__name__)

_UNDERDOG_PROJECT_ID: int | None = None


async def _get_or_create_project() -> int:
    """Return the Underdog project ID, creating it if needed and waiting for confirmation."""
    global _UNDERDOG_PROJECT_ID
    if _UNDERDOG_PROJECT_ID is not None:
        return _UNDERDOG_PROJECT_ID

    headers = {
        "Authorization": f"Bearer {UNDERDOG_API_KEY}",
        "Content-Type": "application/json",
    }
    async with httpx.AsyncClient(timeout=30.0) as client:
        # Fetch existing projects
        r = await client.get(f"{UNDERDOG_API_URL}/v2/projects", headers=headers)
        r.raise_for_status()
        projects = r.json().get("results", [])

        if projects:
            # Use the first confirmed project, or the first if none confirmed yet
            confirmed = [p for p in projects if p.get("status") == "confirmed"]
            project = confirmed[0] if confirmed else projects[0]
            _UNDERDOG_PROJECT_ID = project["id"]
            logger.info(f"[underdog] Using existing project id={_UNDERDOG_PROJECT_ID} status={project.get('status')}")
            return _UNDERDOG_PROJECT_ID

        # No projects – create one
        logger.info("[underdog] No projects found, creating Gigr Vouches project...")
        create_r = await client.post(
            f"{UNDERDOG_API_URL}/v2/projects",
            headers=headers,
            json={
                "name": "Gigr Vouches",
                "symbol": "VOUCH",
                "description": "On-chain reputation vouches for Gigr marketplace providers",
                # "image": "https://res.cloudinary.com/demo/image/upload/v1/samples/cloudinary-icon.png",
                "image": "https://img.icons8.com/ios-filled/50/000000/trust.png",
                "compression": True,
            },
        )
        create_r.raise_for_status()
        project_id = create_r.json()["projectId"]
        logger.info(f"[underdog] Created project id={project_id}, waiting for confirmation...")

        # Poll up to 60s for confirmation
        for _ in range(12):
            await asyncio.sleep(5)
            status_r = await client.get(f"{UNDERDOG_API_URL}/v2/projects/{project_id}", headers=headers)
            status_r.raise_for_status()
            if status_r.json().get("status") == "confirmed":
                logger.info(f"[underdog] Project {project_id} confirmed!")
                break
        else:
            logger.warning(f"[underdog] Project {project_id} still pending after 60s – proceeding anyway")

        _UNDERDOG_PROJECT_ID = project_id
        return _UNDERDOG_PROJECT_ID


async def mint_vouch_cnft(
    provider_wallet: str,
    job_id: str,
) -> dict:
    """
    Mints a compressed NFT (vouch) to the provider's wallet.
    Returns the API response as a dict.
    """
    project_id = await _get_or_create_project()
    url = f"{UNDERDOG_API_URL}/v2/projects/{project_id}/nfts"
    headers = {
        "Authorization": f"Bearer {UNDERDOG_API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "name": f"Gigr Vouch - Job {job_id[:8]}",
        "symbol": "VOUCH",
        "description": "Proof of completed work on Gigr",
        "image": "https://res.cloudinary.com/demo/image/upload/v1/samples/cloudinary-icon.png",
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