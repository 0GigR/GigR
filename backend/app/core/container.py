"""Composition root for the agent memory slice and the Tatum boundaries.

The circuit breaker, the boundary and the gateway are built here, once per
process, and injected into the service. A service never constructs them and
never touches the memwal SDK or the Sui JSON-RPC.

Nothing here imports an SDK at module level: with no MEMWAL_* credentials the
gateway is simply None, and the service keeps using the JSONB memory. With no
TATUM_* credentials the Tatum gateway is None and the memory paths are
untouched.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from .config import settings
from .gateways.tatum_sui_gateway import TatumSuiGateway
from .gateways.walrus_memory_gateway import WalrusMemoryGateway
from .resilience import Boundary, ResiliencePolicy, StructuredLogMetricSink
from ..services.agent_memory_service import AgentMemoryService
from ..services.event_fact_service import EventFactService
from ..services.fact_memory_service import FactMemoryService
from ..services.memory_verification_service import MemoryVerificationService

if TYPE_CHECKING:  # pragma: no cover - typing only
    from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

DEPENDENCY = "walrus-memory"

# One policy for the dependency, not one per call site. Reads are retried with
# jitter; writes are not, because the relayer is append-only.
MEMORY_TIMEOUT_SECONDS = 8.0
MEMORY_FAILURE_THRESHOLD = 4
MEMORY_RESET_TIMEOUT_SECONDS = 20.0
MEMORY_MAX_ATTEMPTS = 2
MEMORY_MAX_CONCURRENCY = 2

# One policy per Tatum dependency. The Tatum Solana probe is the short attempt
# before falling back, so it is never retried: one attempt, then the primary
# RPC. The Sui read is advisory, so it is also single-attempt: the caller is a
# badge, not a transaction, and must not wait twice.
TATUM_SOLANA_DEPENDENCY = "tatum-solana-rpc"
TATUM_SUI_DEPENDENCY = "tatum-sui-rpc"
TATUM_FAILURE_THRESHOLD = 4
TATUM_RESET_TIMEOUT_SECONDS = 20.0
TATUM_MAX_ATTEMPTS = 1
TATUM_MAX_CONCURRENCY = 2


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


def build_tatum_solana_boundary() -> Boundary:
    """The boundary around the Tatum Solana failover probe."""
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
        rpc_url=settings.TATUM_SUI_RPC_URL,
        api_key=settings.tatum_sui_api_key,
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
            "[tatum] FEATURE_TATUM_SUI is enabled but TATUM_SUI_RPC_URL and the "
            "%s key are not both set; verification reports itself unavailable",
            settings.TATUM_SUI_NETWORK,
        )


# Built once at import, injected into every service instance. Tests replace these
# names with fakes; the services always receive them as constructor arguments,
# so no service builds its own dependency.
agent_memory_gateway = build_agent_memory_gateway()
tatum_solana_boundary = build_tatum_solana_boundary()
tatum_sui_gateway = build_tatum_sui_gateway()
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


def build_memory_verification_service() -> MemoryVerificationService:
    """Assemble the advisory verification service for one read-only request."""
    return MemoryVerificationService(verifier=tatum_sui_gateway)
