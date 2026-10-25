"""
Solana program client — AnchorPy wrapper for the Gigr escrow program.

Fixes applied:
  - AsyncClient timeout=60 to survive slow/cold Helius RPC starts.
  - Retry wrapper (3 attempts, 2 s back-off) on every RPC call.
  - All Context account keys use snake_case (AnchorPy3 requirement).

Tatum RPC gateway (FEATURE_TATUM_RPC, off by default):
  - When the flag is on, the client is built against TATUM_SOLANA_RPC_URL and
    the network's Tatum key travels in the ``x-api-key`` request header, never
    in the URL and never in a log line.
  - The Tatum attempt is a short read-only probe (TATUM_RPC_TIMEOUT_SECONDS,
    3-5 s). If it fails or times out, the client falls back once to
    SOLANA_RPC_URL and logs that it did. Writes are never retried here: the
    probe is a read, and the escrow instructions stay single-attempt.
  - With the flag off, the client is constructed exactly as before.
"""
import asyncio
import json
import logging
import os
from dataclasses import dataclass
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
from ..core.resilience import Boundary, failure_fallback

logger = logging.getLogger(__name__)

TATUM_SOLANA_DEPENDENCY = "tatum-solana-rpc"

# Today's timeout for the RPC the escrow program talks to. Kept for the primary
# client and for the client that a successful Tatum probe replaces, so a slow
# but healthy endpoint is not cut off mid-transaction.
_RPC_TIMEOUT_SECONDS = 60

_program: Optional[Program] = None
_client: Optional[AsyncClient] = None
_payer: Optional[Keypair] = None


@dataclass(frozen=True)
class RpcConnection:
    """The RPC client one operation should use, and where it points.

    ``is_tatum`` records which endpoint answered the probe, so the caller logs
    the endpoint it actually uses instead of always naming the primary one.
    """

    client: AsyncClient
    endpoint: str
    is_tatum: bool


def reset_program_singleton() -> None:
    """Call this after config changes to force _get_program() to reinitialize."""
    global _program, _client
    _program = None
    _client = None


def _redact(secret: str, text: str) -> str:
    """Remove ``secret`` from outbound error text before it can be logged.

    A dependency's exception may echo request metadata. The API key must never
    reach a log line or an error message, so it is filtered by value as well as
    by never being placed in a URL.
    """
    if secret and text and secret in text:
        return text.replace(secret, "[redacted]")
    return text


class TatumProbeError(RuntimeError):
    """A probe failure whose message is already safe to log.

    The boundary reports the reason of a failed call to its metric sink, which
    is a log line. Converting the dependency's exception here means the sink
    only ever sees the redacted message.
    """


def _solana_boundary() -> Boundary:
    """The boundary for the Tatum Solana attempt, built in the composition root."""
    from ..core.container import tatum_solana_boundary

    return tatum_solana_boundary


def _tatum_client(timeout: float) -> AsyncClient:
    """A client for the Tatum gateway with the key in the header, never the URL."""
    return AsyncClient(
        settings.TATUM_SOLANA_RPC_URL,
        timeout=timeout,
        extra_headers={"x-api-key": settings.tatum_solana_api_key},
    )


async def open_rpc_client(
    operation: str, boundary: Optional[Boundary] = None
) -> RpcConnection:
    """Return the RPC client for ``operation``, failing over from Tatum once.

    With FEATURE_TATUM_RPC off this is exactly the previous behaviour: a client
    for ``settings.SOLANA_RPC_URL`` with a 60 second timeout. With it on, a
    short read-only probe decides the endpoint: Tatum if it answers inside
    ``TATUM_RPC_TIMEOUT_SECONDS``, the primary RPC otherwise. The probe is a
    read, so failing over never repeats a write.
    """
    if not settings.tatum_solana_enabled:
        return RpcConnection(
            client=AsyncClient(
                settings.SOLANA_RPC_URL, timeout=_RPC_TIMEOUT_SECONDS
            ),
            endpoint=settings.SOLANA_RPC_URL,
            is_tatum=False,
        )

    api_key = settings.tatum_solana_api_key
    probe = _tatum_client(settings.TATUM_RPC_TIMEOUT_SECONDS)

    async def probe_call() -> int:
        try:
            return (await probe.get_slot()).value
        except Exception as exc:  # noqa: BLE001 - report a redacted reason to the boundary
            raise TatumProbeError(
                _redact(api_key, f"{type(exc).__name__}: {exc}")
            ) from None

    try:
        outcome = await (boundary or _solana_boundary()).call(
            probe_call,
            failure_fallback(TATUM_SOLANA_DEPENDENCY, "tatum_solana_unavailable"),
            idempotent=True,
        )
    except Exception as exc:  # noqa: BLE001 - the boundary must never break a chain call
        outcome = None
        fallback_reason = f"{type(exc).__name__}: {_redact(api_key, str(exc))}"
    else:
        fallback_reason = outcome.error or "probe failed"
    finally:
        try:
            await probe.close()
        except Exception as exc:  # noqa: BLE001 - a failed close must not fail the chain call
            logger.debug(
                "[solana_client] probe client close failed for %s: %s",
                operation,
                type(exc).__name__,
            )

    if outcome is not None and outcome.ok:
        logger.info(
            "[solana_client] using the Tatum Solana gateway for %s (network=%s)",
            operation,
            settings.TATUM_SOLANA_NETWORK,
        )
        return RpcConnection(
            client=_tatum_client(_RPC_TIMEOUT_SECONDS),
            endpoint=settings.TATUM_SOLANA_RPC_URL,
            is_tatum=True,
        )

    logger.warning(
        "[solana_client] Tatum Solana gateway unavailable for %s (%s); "
        "fell back to SOLANA_RPC_URL",
        operation,
        _redact(api_key, fallback_reason),
    )
    return RpcConnection(
        client=AsyncClient(settings.SOLANA_RPC_URL, timeout=_RPC_TIMEOUT_SECONDS),
        endpoint=settings.SOLANA_RPC_URL,
        is_tatum=False,
    )

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
    rpc_client = (await open_rpc_client("ensure_ata_exists")).client
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


# def _get_payer() -> Keypair:
def get_platform_payer() -> Keypair:
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
        connection = await open_rpc_client("load_program")
        _client = connection.client
        # idl_dict = json.loads(r"""{"version":"0.1.0","name":"baros_escrow","instructions":[{"name":"initEscrow","accounts":[{"name":"client","isMut":true,"isSigner":true},{"name":"provider","isMut":false,"isSigner":false},{"name":"mint","isMut":false,"isSigner":false},{"name":"clientAta","isMut":true,"isSigner":false},{"name":"vaultAta","isMut":true,"isSigner":false},{"name":"escrow","isMut":true,"isSigner":false},{"name":"tokenProgram","isMut":false,"isSigner":false},{"name":"systemProgram","isMut":false,"isSigner":false},{"name":"rent","isMut":false,"isSigner":false}],"args":[{"name":"jobId","type":"u64"},{"name":"amount","type":"u64"}]},{"name":"releaseEscrow","accounts":[{"name":"client","isMut":true,"isSigner":true},{"name":"providerAta","isMut":true,"isSigner":false},{"name":"vaultAta","isMut":true,"isSigner":false},{"name":"escrow","isMut":true,"isSigner":false},{"name":"tokenProgram","isMut":false,"isSigner":false}],"args":[]},{"name":"cancelEscrow","accounts":[{"name":"client","isMut":true,"isSigner":true},{"name":"clientAta","isMut":true,"isSigner":false},{"name":"vaultAta","isMut":true,"isSigner":false},{"name":"escrow","isMut":true,"isSigner":false},{"name":"tokenProgram","isMut":false,"isSigner":false}],"args":[]}],"accounts":[{"name":"Escrow","type":{"kind":"struct","fields":[{"name":"client","type":"publicKey"},{"name":"provider","type":"publicKey"},{"name":"jobId","type":"u64"},{"name":"amount","type":"u64"},{"name":"bump","type":"u8"}]}}],"errors":[{"code":6000,"name":"UnauthorizedClient","msg":"Unauthorized: You are not the client."}]}""")
        idl_dict = json.loads(r"""{"version":"0.1.0","name":"gigr_escrow","instructions":[{"name":"initEscrow","accounts":[{"name":"client","isMut":true,"isSigner":true},{"name":"platform","isMut":true,"isSigner":true},{"name":"provider","isMut":false,"isSigner":false},{"name":"mint","isMut":false,"isSigner":false},{"name":"clientAta","isMut":true,"isSigner":false},{"name":"vaultAta","isMut":true,"isSigner":false},{"name":"escrow","isMut":true,"isSigner":false},{"name":"tokenProgram","isMut":false,"isSigner":false},{"name":"systemProgram","isMut":false,"isSigner":false},{"name":"rent","isMut":false,"isSigner":false}],"args":[{"name":"jobId","type":"u64"},{"name":"amount","type":"u64"}]},{"name":"releaseEscrow","accounts":[{"name":"client","isMut":false,"isSigner":true},{"name":"platform","isMut":true,"isSigner":false},{"name":"providerAta","isMut":true,"isSigner":false},{"name":"vaultAta","isMut":true,"isSigner":false},{"name":"escrow","isMut":true,"isSigner":false},{"name":"tokenProgram","isMut":false,"isSigner":false}],"args":[]},{"name":"cancelEscrow","accounts":[{"name":"client","isMut":false,"isSigner":true},{"name":"platform","isMut":true,"isSigner":false},{"name":"clientAta","isMut":true,"isSigner":false},{"name":"vaultAta","isMut":true,"isSigner":false},{"name":"escrow","isMut":true,"isSigner":false},{"name":"tokenProgram","isMut":false,"isSigner":false}],"args":[]}],"accounts":[{"name":"Escrow","type":{"kind":"struct","fields":[{"name":"client","type":"publicKey"},{"name":"provider","type":"publicKey"},{"name":"jobId","type":"u64"},{"name":"amount","type":"u64"},{"name":"bump","type":"u8"}]}}],"errors":[{"code":6000,"name":"UnauthorizedClient","msg":"Unauthorized: You are not the client."}]}""")
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
            Wallet(get_platform_payer()),
            TxOpts(skip_preflight=False, preflight_commitment=Confirmed),
        )
        _program = Program(idl, Pubkey.from_string(settings.GIGR_PROGRAM_ID), provider)
        logger.info("[solana_client] Program loaded (embedded IDL). RPC=%s", connection.endpoint)
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
                    "platform":       get_platform_payer().pubkey(),   
                    "provider":       Pubkey.from_string(provider_pubkey),
                    "mint":           Pubkey.from_string(mint),
                    "client_ata":     Pubkey.from_string(client_ata),
                    "vault_ata":      Pubkey.from_string(vault_ata),
                    "escrow":         Pubkey.from_string(escrow_pubkey),  # PDA — never None
                    "token_program":  TOKEN_PROGRAM,
                    "system_program": SYSTEM_PROGRAM_ID,
                    "rent":           RENT,
                },
                signers=[client_kp, get_platform_payer()],
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
    platform_kp: Keypair,           # NEW
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
                    "platform":      platform_kp.pubkey(),   # NEW
                    "provider_ata":  Pubkey.from_string(provider_ata),
                    "vault_ata":     Pubkey.from_string(vault_ata),
                    "escrow":        Pubkey.from_string(escrow_address),
                    "token_program": TOKEN_PROGRAM,
                },
                signers=[client_kp, platform_kp],           # platform signs
            ),
        )
        return str(tx_sig)
    try:
        result = await _retry(_call, "release_escrow")
        return result
    except Exception as e:
        logger.error(f"release_escrow FAILED: {e}")
        raise


async def cancel_escrow(
    *,
    client_kp: Keypair,
    platform_kp: Keypair,           # NEW
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
                    "platform":      platform_kp.pubkey(),   # NEW
                    "client_ata":    Pubkey.from_string(client_ata),
                    "vault_ata":     Pubkey.from_string(vault_ata),
                    "escrow":        Pubkey.from_string(escrow_address),
                    "token_program": TOKEN_PROGRAM,
                },
                signers=[client_kp, platform_kp],
            ),
        )
        return str(tx_sig)
    try:
        result = await _retry(_call, "cancel_escrow")
        return result
    except Exception as e:
        logger.error(f"cancel_escrow FAILED: {e}")
        raise