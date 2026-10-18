"""Per-request payment rail.

The frontend toggle sends ``X-Payment-Rail: paypal|solana``. A middleware stores
it here for the duration of the request, so code that used to read the global
``settings.PAYMENT_RAIL`` can ask ``current_rail()`` instead. Anything running
outside a request (workers, cron) gets the server default.

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
    if value not in settings.available_rails:
        value = None
    return _request_rail.set(value)


def reset_request_rail(token) -> None:
    _request_rail.reset(token)


def current_rail() -> str:
    """The rail for this request: the caller's choice if that rail is configured, else the default."""
    chosen = _request_rail.get()
    if chosen in settings.available_rails:
        return chosen
    return settings.PAYMENT_RAIL
