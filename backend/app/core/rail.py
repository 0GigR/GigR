"""Per-request payment rail.

The frontend build (``VITE_PAYMENT_RAIL``) sends ``X-Payment-Rail: paypal|solana``
on every request. A middleware stores it here for the duration of the request and
code asks ``current_rail()``. There is no backend setting for the rail; anything
running outside a request (workers, cron) gets ``settings.default_rail``.

A job's money stays on the rail that funded it (``Job.payment_rail``); this only
decides which rail a *new* action uses and which UI the caller sees.
"""
from contextvars import ContextVar
from typing import Optional

from .config import settings

RAIL_HEADER = "x-payment-rail"

_request_rail: ContextVar[Optional[str]] = ContextVar("request_payment_rail", default=None)


def set_request_rail(value: Optional[str]):
    """Record the caller's chosen rail; returns the token for ``reset_request_rail``."""
    value = (value or "").strip().lower()
    if value not in ("paypal", "solana"):
        value = None
    return _request_rail.set(value)


def reset_request_rail(token) -> None:
    _request_rail.reset(token)


def current_rail() -> str:
    """The rail for this request: the frontend's choice, else the default.

    The frontend's choice is honoured even if that rail isn't configured here; its
    first payment call then fails with a clear "not configured" error.
    """
    return _request_rail.get() or settings.default_rail
