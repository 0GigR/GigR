"""Resilience primitives for outbound boundaries only.

Circuit breakers, bulkheads, timeouts and bounded jittered retries live here and
are injected from the composition root. Nothing in ``services`` constructs them,
and nothing in this module is applied to an in-process call between our own
layers.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import random
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from enum import Enum
from typing import Generic, Protocol, TypeVar

from .errors import DependencyUnavailableError

T = TypeVar("T")

logger = logging.getLogger(__name__)


def http_status(error: BaseException) -> int | None:
    """The HTTP status an outbound exception carries, when it has one."""
    status = getattr(error, "status", None)
    if status is None:
        status = getattr(error, "status_code", None)
    response = getattr(error, "response", None)
    if status is None and response is not None:
        status = getattr(response, "status_code", None)
    return status if isinstance(status, int) else None


class MetricSink(Protocol):
    """Where breaker state changes and fallback activations are reported."""

    def increment(self, name: str, tags: dict[str, str]) -> None: ...


class StructuredLogMetricSink:
    """Default sink: emits one structured log line per metric."""

    def __init__(self, component: str) -> None:
        self._component = component

    def increment(self, name: str, tags: dict[str, str]) -> None:
        logger.warning(
            json.dumps(
                {"metric": name, "component": self._component, "tags": tags},
                sort_keys=True,
            )
        )


class BreakerState(str, Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


@dataclass(frozen=True)
class ResiliencePolicy:
    """One policy per outbound dependency, not per call site."""

    dependency: str
    timeout_seconds: float = 15.0
    failure_threshold: int = 5
    reset_timeout_seconds: float = 30.0
    half_open_probes: int = 1
    max_attempts: int = 3
    base_backoff_seconds: float = 0.25
    max_backoff_seconds: float = 4.0
    max_concurrency: int = 4


class CircuitBreaker:
    """Closed, open, half-open. One instance per outbound dependency."""

    def __init__(self, policy: ResiliencePolicy, metrics: MetricSink) -> None:
        self._policy = policy
        self._metrics = metrics
        self._state = BreakerState.CLOSED
        self._consecutive_failures = 0
        self._opened_at = 0.0
        self._probes_in_flight = 0

    @property
    def state(self) -> BreakerState:
        return self._state

    def _transition(self, new_state: BreakerState, reason: str) -> None:
        if new_state is self._state:
            return
        previous = self._state
        self._state = new_state
        self._metrics.increment(
            "breaker.state_change",
            {
                "dependency": self._policy.dependency,
                "from": previous.value,
                "to": new_state.value,
                "reason": reason,
            },
        )

    def allows_request(self) -> bool:
        if self._state is BreakerState.CLOSED:
            return True
        if self._state is BreakerState.OPEN:
            if time.monotonic() - self._opened_at >= self._policy.reset_timeout_seconds:
                self._transition(BreakerState.HALF_OPEN, "reset_timeout_elapsed")
                self._probes_in_flight = 0
                return True
            return False
        if self._probes_in_flight < self._policy.half_open_probes:
            self._probes_in_flight += 1
            return True
        return False

    def on_success(self) -> None:
        self._consecutive_failures = 0
        self._probes_in_flight = 0
        if self._state is BreakerState.HALF_OPEN:
            self._transition(BreakerState.CLOSED, "probe_succeeded")

    def on_failure(self) -> None:
        self._probes_in_flight = 0
        if self._state is BreakerState.HALF_OPEN:
            self._opened_at = time.monotonic()
            self._transition(BreakerState.OPEN, "probe_failed")
            return
        self._consecutive_failures += 1
        if self._consecutive_failures >= self._policy.failure_threshold:
            self._opened_at = time.monotonic()
            self._transition(BreakerState.OPEN, "failure_threshold_reached")


@dataclass(frozen=True)
class Outcome(Generic[T]):
    """Typed result of a boundary call. A fallback is always explicit."""

    ok: bool
    value: T | None = None
    error: str | None = None
    degraded: bool = False
    attempts: int = 1
    dependency: str = ""

    def unwrap(self) -> T:
        if not self.ok or self.value is None:
            raise DependencyUnavailableError(
                self.dependency, self.error or "call failed"
            )
        return self.value


class Bulkhead:
    """Dedicated concurrency limit per dependency."""

    def __init__(self, limit: int) -> None:
        self._semaphore = asyncio.Semaphore(limit)

    async def run(self, operation: Callable[[], Awaitable[T]]) -> T:
        async with self._semaphore:
            return await operation()


class Boundary:
    """Timeout, breaker, bulkhead and bounded jittered retry around one dependency."""

    def __init__(
        self,
        policy: ResiliencePolicy,
        metrics: MetricSink | None = None,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._policy = policy
        self._metrics = metrics or StructuredLogMetricSink(policy.dependency)
        self._breaker = CircuitBreaker(policy, self._metrics)
        self._bulkhead = Bulkhead(policy.max_concurrency)
        self._sleep = sleep

    @property
    def policy(self) -> ResiliencePolicy:
        return self._policy

    @property
    def breaker(self) -> CircuitBreaker:
        return self._breaker

    def _backoff(self, attempt: int) -> float:
        ceiling = min(
            self._policy.max_backoff_seconds,
            self._policy.base_backoff_seconds * (2 ** (attempt - 1)),
        )
        return random.uniform(0.0, ceiling)

    async def call(
        self,
        operation: Callable[[], Awaitable[T]],
        fallback: Callable[[str], Awaitable[Outcome[T]]],
        *,
        idempotent: bool,
        timeout_seconds: float | None = None,
    ) -> Outcome[T]:
        """Run one outbound operation inside the dependency's policy.

        ``timeout_seconds`` overrides the policy's deadline for this call only.
        It exists because one dependency can serve reads of very different
        sizes: a five-entry recall and a fifty-entry recall cross the same
        boundary, and the second legitimately needs longer. The breaker, the
        bulkhead and the retry count stay shared, so a slow read still counts
        against the same breaker as every other call to the dependency.

        A value that is not finite and positive is ignored: the policy deadline
        applies, never an unbounded wait.
        """
        attempts_allowed = self._policy.max_attempts if idempotent else 1
        timeout = self._policy.timeout_seconds
        if (
            timeout_seconds is not None
            and math.isfinite(timeout_seconds)
            and timeout_seconds > 0
        ):
            timeout = timeout_seconds

        if not self._breaker.allows_request():
            self._metrics.increment(
                "breaker.fallback",
                {"dependency": self._policy.dependency, "reason": "circuit_open"},
            )
            return await fallback("circuit_open")

        last_error = "unknown"
        for attempt in range(1, attempts_allowed + 1):
            rate_limited = False
            try:
                async with asyncio.timeout(timeout):
                    value = await self._bulkhead.run(operation)
                self._breaker.on_success()
                return Outcome(
                    ok=True,
                    value=value,
                    attempts=attempt,
                    dependency=self._policy.dependency,
                )
            except asyncio.TimeoutError:
                last_error = f"timeout after {timeout}s"
            except Exception as exc:  # noqa: BLE001 - the boundary converts everything
                if http_status(exc) == 429:
                    rate_limited = True
                    last_error = f"rate_limited: {exc}"
                else:
                    last_error = f"{type(exc).__name__}: {exc}"

            self._breaker.on_failure()
            # A 429 is never retried here: the server said the budget is spent,
            # and retrying inside that window only deepens the limit.
            if rate_limited:
                break
            if attempt < attempts_allowed:
                await self._sleep(self._backoff(attempt))

        self._metrics.increment(
            "breaker.fallback",
            {"dependency": self._policy.dependency, "reason": last_error},
        )
        return await fallback(last_error)


def outcome_fallback(
    dependency: str, value: T, reason_prefix: str = "degraded"
) -> Callable[[str], Awaitable[Outcome[T]]]:
    """Build a fallback that returns an explicit degraded value, never a silent null."""

    async def _fallback(reason: str) -> Outcome[T]:
        return Outcome(
            ok=False,
            value=value,
            error=f"{reason_prefix}: {reason}",
            degraded=True,
            dependency=dependency,
        )

    return _fallback


def failure_fallback(
    dependency: str, reason_prefix: str = "unavailable"
) -> Callable[[str], Awaitable[Outcome[object]]]:
    """Build a fallback that reports failure with no value and no silent null."""

    async def _fallback(reason: str) -> Outcome[object]:
        return Outcome(
            ok=False,
            value=None,
            error=f"{reason_prefix}: {reason}",
            degraded=False,
            dependency=dependency,
        )

    return _fallback
