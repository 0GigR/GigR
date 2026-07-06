import secrets
import hashlib
from datetime import datetime, timedelta, timezone

# In-memory store for release codes. In production, use Redis.
_release_codes: dict = {}

MAX_ATTEMPTS = 5


def generate_release_code(job_id: str, ttl_minutes: int = 60) -> str:
    """
    Generates a 6‑digit numeric code tied to a job.
    Returns the code (string). The hash is stored internally.
    """
    code = str(secrets.randbelow(1_000_000)).zfill(6)  # e.g., "048215"
    hashed = hashlib.sha256(code.encode()).hexdigest()
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=ttl_minutes)
    _release_codes[job_id] = {"hash": hashed, "expires_at": expires_at, "attempts": 0}
    return code


def verify_release_code(job_id: str, code: str) -> bool:
    """
    Verifies a release code against the stored hash.
    Returns True if valid and not expired.
    Invalidates the code after MAX_ATTEMPTS wrong guesses to prevent brute-force.
    """
    entry = _release_codes.get(job_id)
    if not entry:
        return False
    if datetime.now(timezone.utc) > entry["expires_at"]:
        del _release_codes[job_id]
        return False
    if entry["attempts"] >= MAX_ATTEMPTS:
        del _release_codes[job_id]
        return False
    hashed_input = hashlib.sha256(code.encode()).hexdigest()
    if hashed_input != entry["hash"]:
        entry["attempts"] += 1
        return False
    # One-time use: delete after successful verification
    del _release_codes[job_id]
    return True