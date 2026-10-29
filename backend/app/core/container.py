"""Composition root for the agent memory slice and the outbound boundaries.

The circuit breaker, the boundary and the gateway are built here, once per
process, and injected into the service. A service never constructs them and
never touches the memwal SDK or the Sui gRPC endpoint.

Nothing here imports an SDK at module level: with no MEMWAL_* credentials the
gateway is simply None, and the service keeps using the JSONB memory. With no
TATUM_* credentials the Tatum gateway is None and the memory paths are
untouched. The geocoding gateway is always built, because Nominatim needs no
credentials; it only makes a request when a caller asks it for a place.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from .config import settings
from .gateways.geocoding_gateway import GeocodingGateway
from .gateways.solana_usdc_transfer_gateway import SolanaUsdcTransferGateway
from .gateways.tatum_solana_transaction_gateway import TatumSolanaTransactionGateway
from .gateways.tatum_sui_gateway import TatumSuiGateway
from .gateways.walrus_memory_gateway import WalrusMemoryGateway
from .resilience import Boundary, ResiliencePolicy, StructuredLogMetricSink
from ..services import osm_geo
from ..services.agent_brief_purchase_service import AgentBriefPurchaseService
from ..services.agent_brief_service import AgentBriefService, BriefPaymentPolicy
from ..services.agent_memory_service import AgentMemoryService
from ..services.event_fact_service import EventFactService
from ..services.fact_memory_service import FactMemoryService
from ..services.memory_reconcile_service import (
    KeyedLock,
    MemoryReconcileJournal,
    MemoryReconcileService,
)
from ..services.memory_verification_service import MemoryVerificationService
from ..services.solana_client import open_write_client
from ..services.wallet import get_user_keypair

if TYPE_CHECKING:  # pragma: no cover - typing only
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

DEPENDENCY = "walrus-memory"

# One policy for the dependency, not one per call site. Reads are retried with
# jitter; writes are not, because there is no per-fact delete to undo one.
MEMORY_TIMEOUT_SECONDS = 8.0
MEMORY_FAILURE_THRESHOLD = 4
MEMORY_RESET_TIMEOUT_SECONDS = 20.0
MEMORY_MAX_ATTEMPTS = 2
MEMORY_MAX_CONCURRENCY = 2

# One policy per Tatum dependency. A Tatum Solana read is the short attempt
# before falling back, so it is never retried: one attempt, then the primary
# RPC. The Sui read is advisory, so it is also single-attempt: the caller is a
# badge, not a transaction, and must not wait twice.
TATUM_SOLANA_DEPENDENCY = "tatum-solana-rpc"
TATUM_SUI_DEPENDENCY = "tatum-sui-grpc"
TATUM_FAILURE_THRESHOLD = 4
TATUM_RESET_TIMEOUT_SECONDS = 20.0
TATUM_MAX_ATTEMPTS = 1
TATUM_MAX_CONCURRENCY = 2

# One policy for the Nominatim dependency. The timeout matches the HTTP client's
# own (GEO_HTTP_TIMEOUT_SECONDS) so a hung lookup cannot outlive the boundary.
# Reads are retried, because a reverse lookup is idempotent; the reused client
# still spaces every attempt to Nominatim's one request per second.
NOMINATIM_DEPENDENCY = "nominatim"
NOMINATIM_FAILURE_THRESHOLD = 4
NOMINATIM_RESET_TIMEOUT_SECONDS = 60.0
NOMINATIM_MAX_ATTEMPTS = 2
NOMINATIM_MAX_CONCURRENCY = 1


def build_memory_boundary() -> Boundary:
    """The outbound boundary every Walrus Memory call crosses."""
    return Boundary(
        ResiliencePolicy(
            dependency=DEPENDENCY,
            timeout_seconds=MEMORY_TIMEOUT_SECONDS,
            failure_threshold=MEMORY_FAILURE_THRESHOLD,
            reset_timeout_seconds=MEMORY_RESET_TIMEOUT_SECONDS,
            max_attempts=MEMORY_MAX_ATTEMPTS,
            max_concurrency=MEMORY_MAX_CONCURRENCY,
        ),
        StructuredLogMetricSink(DEPENDENCY),
    )


def build_geocoding_boundary() -> Boundary:
    """The outbound boundary every reverse-geocoding call crosses."""
    return Boundary(
        ResiliencePolicy(
            dependency=NOMINATIM_DEPENDENCY,
            timeout_seconds=settings.GEO_HTTP_TIMEOUT_SECONDS,
            failure_threshold=NOMINATIM_FAILURE_THRESHOLD,
            reset_timeout_seconds=NOMINATIM_RESET_TIMEOUT_SECONDS,
            max_attempts=NOMINATIM_MAX_ATTEMPTS,
            max_concurrency=NOMINATIM_MAX_CONCURRENCY,
        ),
        StructuredLogMetricSink(NOMINATIM_DEPENDENCY),
    )


def build_tatum_solana_boundary() -> Boundary:
    """The boundary around one Tatum Solana read attempt."""
    return Boundary(
        ResiliencePolicy(
            dependency=TATUM_SOLANA_DEPENDENCY,
            timeout_seconds=settings.TATUM_RPC_TIMEOUT_SECONDS,
            failure_threshold=TATUM_FAILURE_THRESHOLD,
            reset_timeout_seconds=TATUM_RESET_TIMEOUT_SECONDS,
            max_attempts=TATUM_MAX_ATTEMPTS,
            max_concurrency=TATUM_MAX_CONCURRENCY,
        ),
        StructuredLogMetricSink(TATUM_SOLANA_DEPENDENCY),
    )


def build_tatum_sui_boundary() -> Boundary:
    """The boundary around the advisory Sui verification read."""
    return Boundary(
        ResiliencePolicy(
            dependency=TATUM_SUI_DEPENDENCY,
            timeout_seconds=settings.TATUM_RPC_TIMEOUT_SECONDS,
            failure_threshold=TATUM_FAILURE_THRESHOLD,
            reset_timeout_seconds=TATUM_RESET_TIMEOUT_SECONDS,
            max_attempts=TATUM_MAX_ATTEMPTS,
            max_concurrency=TATUM_MAX_CONCURRENCY,
        ),
        StructuredLogMetricSink(TATUM_SUI_DEPENDENCY),
    )


def build_agent_memory_gateway() -> WalrusMemoryGateway | None:
    """The gateway, or None when Walrus Memory is not configured.

    Constructing the gateway does not import memwal or open a connection; the
    SDK client is created on the first call.
    """
    if not (settings.MEMWAL_PRIVATE_KEY and settings.MEMWAL_ACCOUNT_ID):
        logger.info(
            "[agent-memory] Walrus Memory credentials are not set; the agent memory "
            "stays in the JSONB column"
        )
        return None
    return WalrusMemoryGateway(
        boundary=build_memory_boundary(),
        private_key=settings.MEMWAL_PRIVATE_KEY,
        account_id=settings.MEMWAL_ACCOUNT_ID,
        server_url=settings.MEMWAL_SERVER_URL,
    )


def build_tatum_sui_gateway() -> TatumSuiGateway | None:
    """The Sui gateway, or None when the flag is off or nothing is configured."""
    if not settings.tatum_sui_enabled:
        return None
    return TatumSuiGateway(
        boundary=build_tatum_sui_boundary(),
        grpc_url=settings.TATUM_SUI_GRPC_URL,
        api_key=settings.tatum_sui_api_key,
    )


def build_agent_brief_gateway() -> TatumSolanaTransactionGateway | None:
    """The Tatum transaction read the paid brief verifies a payment with.

    Built only when the x402 brief is enabled, and only over the gateway that
    serves Solana reads. It is a read: the gateway cannot build or send a
    transaction, so the escrow path and the Tatum write split are untouched.

    With the flag off this returns None. The service then refuses every payment
    with ``verification_unavailable`` rather than trusting one, and the router
    has already answered 404 without asking the service anything.
    """
    if not settings.x402_agent_brief_enabled:
        return None
    return TatumSolanaTransactionGateway(
        boundary=tatum_solana_boundary,
        rpc_url=settings.TATUM_SOLANA_RPC_URL,
        api_key=settings.tatum_solana_api_key,
    )


def build_agent_brief_policy() -> BriefPaymentPolicy:
    """What one brief costs and where the payment must land, from settings."""
    return BriefPaymentPolicy(
        mint=settings.USDC_MINT_DEVNET,
        pay_to=settings.X402_AGENT_BRIEF_PAY_TO,
        amount_atomic=settings.X402_AGENT_BRIEF_PRICE_ATOMIC,
        expires_seconds=settings.X402_AGENT_BRIEF_EXPIRES_SECONDS,
    )


def build_agent_brief_transfer_gateway() -> SolanaUsdcTransferGateway | None:
    """The USDC transfer the in-app purchase sends, or None while the flag is off.

    The client factory is ``open_write_client``: the client bound to
    SOLANA_RPC_URL, the same function the escrow program's provider is built
    from. It has no branch on the Tatum flag, so this transfer is written on the
    path every other transaction in the app uses and cannot reach Tatum.
    """
    if not settings.x402_agent_brief_enabled:
        return None
    return SolanaUsdcTransferGateway(
        client_factory=open_write_client,
        mint=settings.USDC_MINT_DEVNET,
    )


def build_geocoding_gateway() -> GeocodingGateway:
    """The reverse-geocoding gateway over the process's one Nominatim client.

    ``osm_geo.reverse_geocode`` is injected rather than imported by the gateway:
    that client owns the User-Agent, the one-request-per-second throttle and the
    cache Nominatim's usage policy requires, and a second Nominatim client in
    the codebase would mean two budgets and two caches for the same service.
    """
    return GeocodingGateway(
        boundary=build_geocoding_boundary(),
        reverse_geocode=osm_geo.reverse_geocode,
    )


def _log_flag_state() -> None:
    """Log the Tatum flag state once at startup, one line per flag."""
    logger.info(
        "[tatum] FEATURE_TATUM_RPC=%s network=%s configured=%s",
        settings.FEATURE_TATUM_RPC,
        settings.TATUM_SOLANA_NETWORK,
        settings.tatum_solana_enabled,
    )
    logger.info(
        "[tatum] FEATURE_TATUM_SUI=%s network=%s configured=%s",
        settings.FEATURE_TATUM_SUI,
        settings.TATUM_SUI_NETWORK,
        settings.tatum_sui_enabled,
    )
    if settings.FEATURE_TATUM_RPC and not settings.tatum_solana_enabled:
        logger.warning(
            "[tatum] FEATURE_TATUM_RPC is enabled but TATUM_SOLANA_RPC_URL and the "
            "%s key are not both set; the primary SOLANA_RPC_URL is used",
            settings.TATUM_SOLANA_NETWORK,
        )
    if settings.FEATURE_TATUM_SUI and not settings.tatum_sui_enabled:
        logger.warning(
            "[tatum] FEATURE_TATUM_SUI is enabled but TATUM_SUI_GRPC_URL and the "
            "%s key are not both set; verification reports itself unavailable",
            settings.TATUM_SUI_NETWORK,
        )
    logger.info(
        "[x402] FEATURE_X402_AGENT_BRIEF=%s enabled=%s price_atomic=%s",
        settings.FEATURE_X402_AGENT_BRIEF,
        settings.x402_agent_brief_enabled,
        settings.X402_AGENT_BRIEF_PRICE_ATOMIC,
    )
    if settings.FEATURE_X402_AGENT_BRIEF and not settings.x402_agent_brief_enabled:
        logger.warning(
            "[x402] FEATURE_X402_AGENT_BRIEF is enabled but USDC_MINT_DEVNET or "
            "X402_AGENT_BRIEF_PAY_TO is not set; the endpoint stays inert"
        )
    if settings.x402_agent_brief_enabled and not (
        settings.TATUM_SOLANA_RPC_URL and settings.tatum_solana_api_key
    ):
        logger.warning(
            "[x402] the endpoint is enabled but TATUM_SOLANA_RPC_URL and the %s "
            "Tatum key are not both set; every payment will be refused as "
            "unverifiable",
            settings.TATUM_SOLANA_NETWORK,
        )


# Built once at import, injected into every service instance. Tests replace these
# names with fakes; the services always receive them as constructor arguments,
# so no service builds its own dependency.
agent_memory_gateway = build_agent_memory_gateway()
tatum_solana_boundary = build_tatum_solana_boundary()
tatum_sui_gateway = build_tatum_sui_gateway()
agent_brief_gateway = build_agent_brief_gateway()
agent_brief_transfer_gateway = build_agent_brief_transfer_gateway()
geocoding_gateway = build_geocoding_gateway()
# One registry for the whole process: two reconciles for one user must not
# interleave, and each request builds its own service from this root.
memory_reconcile_locks = KeyedLock()
_log_flag_state()


def build_agent_memory_service(db: "AsyncSession") -> AgentMemoryService:
    """Assemble the memory service for one request or one background task."""
    return AgentMemoryService(db=db, gateway=agent_memory_gateway)


def build_fact_memory_service() -> FactMemoryService:
    """The fact writer, using the one gateway this process built."""
    return FactMemoryService(gateway=agent_memory_gateway)


def build_event_fact_service(db: "AsyncSession") -> EventFactService:
    """Assemble the event fact service for one request or one background task."""
    return EventFactService(db=db, memory=build_fact_memory_service())


def build_memory_reconcile_journal() -> MemoryReconcileJournal:
    """The durable restore point the per-fact controls write before a wipe.

    The path is configuration, not a flag: it names where state lives and does
    not change what the code does.
    """
    return MemoryReconcileJournal(
        settings.MEMORY_RECONCILE_JOURNAL_PATH,
        settings.MEMWAL_NAMESPACE_PREFIX,
    )


def build_memory_reconcile_service() -> MemoryReconcileService:
    """Assemble the per-fact delete and edit service for one request."""
    return MemoryReconcileService(
        memory=build_fact_memory_service(),
        gateway=agent_memory_gateway,
        journal=build_memory_reconcile_journal(),
        locks=memory_reconcile_locks,
    )


def build_memory_verification_service() -> MemoryVerificationService:
    """Assemble the advisory verification service for one read-only request."""
    return MemoryVerificationService(verifier=tatum_sui_gateway)


def build_agent_brief_service(db: "AsyncSession") -> AgentBriefService:
    """Assemble the paid brief service for one request.

    ``db`` is the request's session: the ledger claim commits on it, so the
    payment is spent before the router can return any content.
    """
    return AgentBriefService(
        db=db,
        gateway=agent_brief_gateway,
        policy=build_agent_brief_policy(),
    )


def build_agent_brief_purchase_service(db: "AsyncSession") -> AgentBriefPurchaseService:
    """Assemble the in-app purchase for one request.

    ``briefs`` is the same read service the GET route uses, so the purchase
    verifies through the existing judge and spends through the existing ledger.
    ``keypair_for`` is the existing custodial helper: the app signs for the user
    from the seed already on their row, and no second key store is opened.
    """
    return AgentBriefPurchaseService(
        db,
        briefs=build_agent_brief_service(db),
        transfers=agent_brief_transfer_gateway,
        policy=build_agent_brief_policy(),
        keypair_for=get_user_keypair,
    )
