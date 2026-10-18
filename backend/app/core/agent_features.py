"""Agent feature flag helpers.

All FEATURE_AGENT_* flags are declared in core/config.py (the single
declaration point per house standard). This module provides helpers that read
those flags and a FastAPI dependency factory for conditional route protection.
"""

from __future__ import annotations

import logging
from typing import Callable

from fastapi import HTTPException, status

from .config import settings

logger = logging.getLogger(__name__)


def agent_feature_enabled(flag_name: str) -> bool:
    """Return True when the named FEATURE_AGENT_* flag is enabled in settings.

    flag_name is the full attribute name on the Settings object, for example
    'FEATURE_AGENT_MULTI_TURN'. Unknown names return False and log a warning
    rather than raising, so a typo never crashes the application.
    """
    value = getattr(settings, flag_name, None)
    if value is None:
        logger.warning(
            "[agent_features] Unknown feature flag '%s' — treating as disabled.",
            flag_name,
        )
        return False
    return bool(value)


def require_agent_feature(flag_name: str) -> Callable:
    """Return a FastAPI dependency that raises 403 when the flag is disabled."""
    def _check() -> None:
        if not agent_feature_enabled(flag_name):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=(
                    f"Feature '{flag_name}' is not available in this environment. "
                    "Contact support if you believe this should be enabled."
                ),
            )
    return _check
