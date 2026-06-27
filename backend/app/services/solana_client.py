"""
Solana program client — AnchorPy wrapper for the Gigr escrow program.

Fixes applied:
  - AsyncClient timeout=60 to survive slow/cold Helius RPC starts.
  - Retry wrapper (3 attempts, 2 s back-off) on every RPC call.
  - All Context account keys use snake_case (AnchorPy3 requirement).
"""
import asyncio
import json
import logging
import os
from typing import Optional

import httpx
from solana.exceptions import SolanaRpcException
from solana.rpc.async_api import AsyncClient
from solana.rpc.commitment import Confirmed
from solana.rpc.types import TxOpts
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.system_program import ID as SYSTEM_PROGRAM_ID
from anchorpy import Context, Idl, Program, Provider, Wallet

from ..core.config import settings

logger = logging.getLogger(__name__)

_program: Optional[Program] = None
_client: Optional[AsyncClient] = None
_payer: Optional[Keypair] = None


def reset_program_singleton() -> None:
    """Call this after config changes to force _get_program() to reinitialize."""
    global _program, _client
    _program = None
    _client = None

TOKEN_PROGRAM = Pubkey.from_string("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA")
ATA_PROGRAM   = Pubkey.from_string("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
RENT          = Pubkey.from_string("SysvarRent111111111111111111111111111111111")

_RPC_RETRIES = 3
_RPC_RETRY_DELAY = 2  # seconds


async def ensure_ata_exists(payer_kp: Keypair, owner: Pubkey, mint: Pubkey) -> Pubkey:
    """
    Derive the standard ATA for `owner`/`mint`. If it doesn't exist on-chain yet,
    create it (payer_kp pays the rent ~0.002 SOL). Returns the ATA Pubkey.
    """
    from spl.token.instructions import get_associated_token_address, create_associated_token_account
    from solders.transaction import VersionedTransaction
    from solders.message import MessageV0
    from solders.hash import Hash

    ata = get_associated_token_address(owner, mint)

    # Check existence
    rpc_client = AsyncClient(settings.SOLANA_RPC_URL, timeout=60)
    try:
        info = await rpc_client.get_account_info(ata)
        if info.value is not None:
            logger.info(f"[solana_client] ATA {ata} already exists, skipping create.")
            return ata

        # Doesn't exist – create it
        logger.info(f"[solana_client] Creating ATA {ata} for owner {owner}...")
        ix = create_associated_token_account(
            payer=payer_kp.pubkey(),
            owner=owner,
            mint=mint,
        )
        blockhash_resp = await rpc_client.get_latest_blockhash()
        recent_blockhash = blockhash_resp.value.blockhash
        msg = MessageV0.try_compile(
            payer=payer_kp.pubkey(),
            instructions=[ix],
            address_lookup_table_accounts=[],
            recent_blockhash=recent_blockhash,
        )
        tx = VersionedTransaction(msg, [payer_kp])
        resp = await rpc_client.send_transaction(tx, opts=TxOpts(skip_preflight=False, preflight_commitment=Confirmed))
        logger.info(f"[solana_client] ATA create tx: {resp.value}")
        # Brief wait for confirmation before the main instruction
        await asyncio.sleep(3)
        return ata
    finally:
        await rpc_client.close()


def _get_payer() -> Keypair:
    global _payer
    if _payer is None:
        raw = settings.PLATFORM_KEYPAIR
        try:
            secret = json.loads(raw)
            _payer = Keypair.from_bytes(bytes(secret))
        except (json.JSONDecodeError, ValueError):
            _payer = Keypair.from_base58_string(raw)
    return _payer


async def _get_program() -> Program:
    global _program, _client
    if _program is None:
        # timeout=60 so Helius cold-starts don't time out mid-request
        _client = AsyncClient(settings.SOLANA_RPC_URL, timeout=60)
        # idl_dict = json.loads(r"""{"version":"0.1.0","name":"baros_escrow","instructions":[{"name":"initEscrow","accounts":[{"name":"client","isMut":true,"isSigner":true},{"name":"provider","isMut":false,"isSigner":false},{"name":"mint","isMut":false,"isSigner":false},{"name":"clientAta","isMut":true,"isSigner":false},{"name":"vaultAta","isMut":true,"isSigner":false},{"name":"escrow","isMut":true,"isSigner":false},{"name":"tokenProgram","isMut":false,"isSigner":false},{"name":"systemProgram","isMut":false,"isSigner":false},{"name":"rent","isMut":false,"isSigner":false}],"args":[{"name":"jobId","type":"u64"},{"name":"amount","type":"u64"}]},{"name":"releaseEscrow","accounts":[{"name":"client","isMut":true,"isSigner":true},{"name":"providerAta","isMut":true,"isSigner":false},{"name":"vaultAta","isMut":true,"isSigner":false},{"name":"escrow","isMut":true,"isSigner":false},{"name":"tokenProgram","isMut":false,"isSigner":false}],"args":[]},{"name":"cancelEscrow","accounts":[{"name":"client","isMut":true,"isSigner":true},{"name":"clientAta","isMut":true,"isSigner":false},{"name":"vaultAta","isMut":true,"isSigner":false},{"name":"escrow","isMut":true,"isSigner":false},{"name":"tokenProgram","isMut":false,"isSigner":false}],"args":[]}],"accounts":[{"name":"Escrow","type":{"kind":"struct","fields":[{"name":"client","type":"publicKey"},{"name":"provider","type":"publicKey"},{"name":"jobId","type":"u64"},{"name":"amount","type":"u64"},{"name":"bump","type":"u8"}]}}],"errors":[{"code":6000,"name":"UnauthorizedClient","msg":"Unauthorized: You are not the client."}]}""")
        idl_dict = json.loads(r"""{"version":"0.1.0","name":"gigr_escrow","instructions":[{"name":"initEscrow","accounts":[{"name":"client","isMut":true,"isSigner":true},{"name":"platform","isMut":true,"isSigner":true},{"name":"provider","isMut":false,"isSigner":false},{"name":"mint","isMut":false,"isSigner":false},{"name":"clientAta","isMut":true,"isSigner":false},{"name":"vaultAta","isMut":true,"isSigner":false},{"name":"escrow","isMut":true,"isSigner":false},{"name":"tokenProgram","isMut":false,"isSigner":false},{"name":"systemProgram","isMut":false,"isSigner":false},{"name":"rent","isMut":false,"isSigner":false}],"args":[{"name":"jobId","type":"u64"},{"name":"amount","type":"u64"}]},{"name":"releaseEscrow","accounts":[{"name":"client","isMut":true,"isSigner":true},{"name":"providerAta","isMut":true,"isSigner":false},{"name":"vaultAta","isMut":true,"isSigner":false},{"name":"escrow","isMut":true,"isSigner":false},{"name":"tokenProgram","isMut":false,"isSigner":false}],"args":[]},{"name":"cancelEscrow","accounts":[{"name":"client","isMut":true,"isSigner":true},{"name":"clientAta","isMut":true,"isSigner":false},{"name":"vaultAta","isMut":true,"isSigner":false},{"name":"escrow","isMut":true,"isSigner":false},{"name":"tokenProgram","isMut":false,"isSigner":false}],"args":[]}],"accounts":[{"name":"Escrow","type":{"kind":"struct","fields":[{"name":"client","type":"publicKey"},{"name":"provider","type":"publicKey"},{"name":"jobId","type":"u64"},{"name":"amount","type":"u64"},{"name":"bump","type":"u8"}]}}],"errors":[{"code":6000,"name":"UnauthorizedClient","msg":"Unauthorized: You are not the client."}]}""")
        # idl_path = os.path.join(os.path.dirname(__file__), "baros_program.json")
        # idl_path = r"app/services/gigr_program.json"
        # with open(idl_path, "r") as f:
        #     raw = json.load(f)
        # if "metadata" not in raw:
        #     raw["metadata"] = {"address": settings.GIGR_PROGRAM_ID}
        # idl = Idl.from_json(json.dumps(raw))
        # provider = Provider( 
        #     _client,
        #     Wallet(_get_payer()),
        #     TxOpts(skip_preflight=False, preflight_commitment=Confirmed),
        # )
        # _program = Program(idl, Pubkey.from_string(settings.GIGR_PROGRAM_ID), provider)
        # logger.info(f"[solana_client] Program loaded. RPC={settings.SOLANA_RPC_URL}")
        if "metadata" not in idl_dict:
            idl_dict["metadata"] = {"address": settings.GIGR_PROGRAM_ID}

        idl = Idl.from_json(json.dumps(idl_dict))
        provider = Provider(
            _client,
            Wallet(_get_payer()),
            TxOpts(skip_preflight=False, preflight_commitment=Confirmed),
        )
        _program = Program(idl, Pubkey.from_string(settings.GIGR_PROGRAM_ID), provider)
        logger.info(f"[solana_client] Program loaded (embedded IDL). RPC={settings.SOLANA_RPC_URL}")
    return _program


async def _retry(coro_fn, label: str):
    """Run an async callable up to _RPC_RETRIES times, sleeping on transient errors."""
    last_exc: Exception | None = None
    for attempt in range(1, _RPC_RETRIES + 1):
        try:
            return await coro_fn()
        except (SolanaRpcException, httpx.ConnectTimeout, httpx.TimeoutException) as exc:
            last_exc = exc
            logger.warning(
                f"[solana_client] {label} attempt {attempt}/{_RPC_RETRIES} failed: {exc}"
            )
            if attempt < _RPC_RETRIES:
                await asyncio.sleep(_RPC_RETRY_DELAY)
        except Exception:
            raise  # non-transient errors bubble up immediately
    raise last_exc  # type: ignore[misc]


# ─── Instruction helpers ─────────────────────────────────────────────────────

async def init_escrow(
    *,
    client_kp: Keypair,
    client_ata: str,
    vault_ata: str,
    provider_pubkey: str,
    mint: str,
    job_id: int,
    amount: int,
    escrow_pubkey: str,   # PDA computed in jobs.py — must not be None
) -> str:
    program = await _get_program()

    async def _call():
        tx_sig = await program.rpc["init_escrow"](
            job_id,
            amount,
            ctx=Context(
                accounts={
                    "client":         client_kp.pubkey(),
                    "platform":       _get_payer().pubkey(),   
                    "provider":       Pubkey.from_string(provider_pubkey),
                    "mint":           Pubkey.from_string(mint),
                    "client_ata":     Pubkey.from_string(client_ata),
                    "vault_ata":      Pubkey.from_string(vault_ata),
                    "escrow":         Pubkey.from_string(escrow_pubkey),  # PDA — never None
                    "token_program":  TOKEN_PROGRAM,
                    "system_program": SYSTEM_PROGRAM_ID,
                    "rent":           RENT,
                },
                signers=[client_kp, _get_payer()],
            ),
        )
        return str(tx_sig)

    try:
        result = await _retry(_call, "init_escrow")
        logger.info(f"[solana_client] init_escrow OK: {result}")
        return result
    except Exception as e:
        logger.error(f"[solana_client] init_escrow FAILED: {e}")
        raise


async def release_escrow(
    *,
    client_kp: Keypair,
    provider_ata: str,
    vault_ata: str,
    escrow_address: str,
) -> str:
    program = await _get_program()

    async def _call():
        tx_sig = await program.rpc["release_escrow"](
            ctx=Context(
                accounts={
                    "client":        client_kp.pubkey(),
                    "provider_ata":  Pubkey.from_string(provider_ata),
                    "vault_ata":     Pubkey.from_string(vault_ata),
                    "escrow":        Pubkey.from_string(escrow_address),
                    "token_program": TOKEN_PROGRAM,
                },
                signers=[client_kp],
            ),
        )
        return str(tx_sig)

    try:
        result = await _retry(_call, "release_escrow")
        logger.info(f"[solana_client] release_escrow OK: {result}")
        return result
    except Exception as e:
        logger.error(f"[solana_client] release_escrow FAILED: {e}")
        raise


async def cancel_escrow(
    *,
    client_kp: Keypair,
    client_ata: str,
    vault_ata: str,
    escrow_address: str,
) -> str:
    program = await _get_program()

    async def _call():
        tx_sig = await program.rpc["cancel_escrow"](
            ctx=Context(
                accounts={
                    "client":        client_kp.pubkey(),
                    "client_ata":    Pubkey.from_string(client_ata),
                    "vault_ata":     Pubkey.from_string(vault_ata),
                    "escrow":        Pubkey.from_string(escrow_address),
                    "token_program": TOKEN_PROGRAM,
                },
                signers=[client_kp],
            ),
        )
        return str(tx_sig)

    try:
        result = await _retry(_call, "cancel_escrow")
        logger.info(f"[solana_client] cancel_escrow OK: {result}")
        return result
    except Exception as e:
        logger.error(f"[solana_client] cancel_escrow FAILED: {e}")
        raise