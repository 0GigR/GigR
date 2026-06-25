"""Shared helper to decrypt a user's Solana keypair from the DB.

The private key is stored Fernet-encrypted as a base58 string of the 32-byte seed.
Extracted from jobs.py so disputes / amendments / the auto-release scanner can all
reuse the exact same decryption path.
"""
from fastapi import HTTPException
from solders.keypair import Keypair

from ..core.config import settings
from ..models.user import User


def get_user_keypair(user: User) -> Keypair:
    from cryptography.fernet import Fernet
    import base58

    f = Fernet(settings.WALLET_ENCRYPTION_KEY.encode())
    try:
        encrypted = user._wallet_private_key.encode()
        decrypted_bytes = f.decrypt(encrypted)
        secret_base58 = decrypted_bytes.decode()
        secret_bytes = base58.b58decode(secret_base58)
        return Keypair.from_seed(secret_bytes)
    except Exception:
        raise HTTPException(status_code=500, detail="Wallet key corrupted – please re‑create your account.")
