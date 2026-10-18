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
_request_origin: ContextVar[Optional[str]] = ContextVar("request_frontend_origin", default=None)


def set_request_rail(value: Optional[str]):
    """Record the caller's chosen rail; returns the token for ``reset_request_rail``."""
    value = (value or "").strip().lower()
    if value not in ("paypal", "solana"):
        value = None
    return _request_rail.set(value)


def reset_request_rail(token) -> None:
    _request_rail.reset(token)


def explicit_rail() -> Optional[str]:
    """The rail the caller sent, or None outside a request. Stored on agent tasks."""
    return _request_rail.get()


def set_request_origin(value: Optional[str]) -> None:
    _request_origin.set((value or "").rstrip("/") or None)


def explicit_origin() -> Optional[str]:
    return _request_origin.get()


def current_frontend_url() -> str:
    """Where PayPal should send the payer back to: the frontend that made this request.

    With two frontends on one backend, ``FRONTEND_URL`` alone can't say which one.
    Falls back to ``FRONTEND_URL`` outside a request or for an unknown origin.
    """
    return _request_origin.get() or (settings.FRONTEND_URL or "http://localhost:5173").rstrip("/")


def adopt(rail: Optional[str], origin: Optional[str]) -> None:
    """Re-establish a stored caller context (an agent task runs outside the request)."""
    set_request_rail(rail)
    set_request_origin(origin)


def current_rail() -> str:
    """The rail for this request: the frontend's choice, else the default.

    The frontend's choice is honoured even if that rail isn't configured here; its
    first payment call then fails with a clear "not configured" error.
    """
    return _request_rail.get() or settings.default_rail
