"""Shared Groq client: one place for key rotation and chat completions.

Previously the rotation logic lived inside ``ai.py`` while several call sites
bypassed it entirely (they used the single ``GROQ_API_KEY`` and a raw httpx
post). Centralising it here means every LLM call — NLU, copywriting, pricing,
negotiation and the tool-calling agent — behaves the same way and benefits from
the same multi-key fallback.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional

import httpx

from ..core.config import settings

logger = logging.getLogger(__name__)

GROQ_CHAT_URL = "https://api.groq.com/openai/v1/chat/completions"
GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models"

# Groq retires models regularly. When the configured model disappears, every LLM
# feature silently degrades to its fallback — which is exactly what happened when
# they dropped the Llama family and left the app on `llama-3.1-8b-instant`: NLP
# silently became regex, negotiation stopped dead, and the agent's tool calling
# 404'd. These are tried in order when the configured model is unavailable.
_PREFERRED_MODELS = (
    "openai/gpt-oss-120b",
    "openai/gpt-oss-20b",
    "qwen/qwen3.8-27b",
    "groq/compound",
    "allam-2-7b",
)

_resolved_model: Optional[str] = None


def active_model() -> str:
    """The model to use right now (validated at startup when possible)."""
    return _resolved_model or settings.GROQ_MODEL


async def ensure_working_model() -> Optional[str]:
    """Validate ``GROQ_MODEL`` against the account and self-heal if it's gone.

    Called once at startup. Returns the model in use, or ``None`` when the check
    could not run (no keys / network) — in which case the configured value is
    left alone rather than guessed at.
    """
    global _resolved_model
    if not settings.groq_keys_list:
        logger.info("[groq] no API keys configured — LLM features use fallbacks")
        return None

    key = settings.groq_keys_list[0]
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                GROQ_MODELS_URL, headers={"Authorization": f"Bearer {key}"}
            )
            resp.raise_for_status()
            available = {m.get("id") for m in resp.json().get("data", [])}
    except Exception as exc:  # noqa: BLE001 - never block startup
        logger.warning(
            "[groq] could not list models (%s); leaving GROQ_MODEL=%r as-is",
            exc, settings.GROQ_MODEL,
        )
        return None

    if settings.GROQ_MODEL in available:
        _resolved_model = settings.GROQ_MODEL
        logger.info("[groq] model %s is available", settings.GROQ_MODEL)
        return _resolved_model

    replacement = next((m for m in _PREFERRED_MODELS if m in available), None)
    if not replacement:
        logger.error(
            "[groq] model %r is unavailable and none of the preferred fallbacks "
            "exist. Available: %s",
            settings.GROQ_MODEL, sorted(m for m in available if m),
        )
        return None

    logger.error(
        "[groq] configured model %r does not exist on this account — using %r "
        "instead. Set GROQ_MODEL=%s to silence this.",
        settings.GROQ_MODEL, replacement, replacement,
    )
    # Mutate the live settings object so every existing call site that references
    # settings.GROQ_MODEL picks up the working model without a code change.
    try:
        settings.GROQ_MODEL = replacement
    except Exception:  # pragma: no cover - only if settings ever becomes frozen
        logger.warning("[groq] could not update settings.GROQ_MODEL; using active_model()")
    _resolved_model = replacement
    return replacement


async def call_with_key_rotation(
    client: httpx.AsyncClient, url: str, **kwargs: Any
) -> httpx.Response:
    """POST to Groq, rotating through every configured key on rate limits.

    Raises the last error if every key fails, so callers can fall back.
    """
    keys = settings.groq_keys_list
    if not keys:
        raise ValueError("No GROQ_API_KEYS configured")

    last_err: Optional[Exception] = None
    for key in keys:
        call_kwargs = dict(kwargs)
        headers = dict(call_kwargs.get("headers", {}))
        headers["Authorization"] = f"Bearer {key}"
        call_kwargs["headers"] = headers

        try:
            response = await client.post(url, **call_kwargs)
            if response.status_code == 429:
                last_err = httpx.HTTPStatusError(
                    "Rate limited", request=response.request, response=response
                )
                logger.warning("[groq] key rate limited, trying next key")
                continue
            response.raise_for_status()
            return response
        except httpx.HTTPStatusError as exc:
            last_err = exc
            if exc.response.status_code == 429:
                logger.warning("[groq] key rate limited, trying next key")
                continue
            raise
        except Exception as exc:  # noqa: BLE001 - try the next key
            last_err = exc
            logger.warning("[groq] call failed (%s), trying next key", exc)
            continue

    if last_err:
        raise last_err
    raise RuntimeError("All Groq API keys failed")


def has_llm() -> bool:
    """True when at least one Groq key is configured."""
    return bool(settings.groq_keys_list)


async def chat(
    messages: List[Dict[str, Any]],
    *,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_choice: Optional[str] = None,
    temperature: float = 0.2,
    max_tokens: int = 400,
    response_format: Optional[Dict[str, str]] = None,
    reasoning_effort: Optional[str] = None,
    timeout: float = 20.0,
) -> Dict[str, Any]:
    """Run one chat completion and return the raw parsed response body.

    ``reasoning_effort`` matters a lot on reasoning models (gpt-oss): by default
    they can spend most of ``max_tokens`` on hidden reasoning, which truncated
    JSON responses and even produced empty generations that Groq rejects with
    ``json_validate_failed``. Structured, latency-sensitive calls should pass
    "low".

    Raises on failure — callers decide how to degrade.
    """
    payload: Dict[str, Any] = {
        "model": active_model(),
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice or "auto"
    if response_format:
        payload["response_format"] = response_format
    if reasoning_effort:
        payload["reasoning_effort"] = reasoning_effort

    async with httpx.AsyncClient(timeout=timeout) as client:
        response = await call_with_key_rotation(
            client,
            GROQ_CHAT_URL,
            headers={"Content-Type": "application/json"},
            json=payload,
        )
        return response.json()


def extract_json(text: str) -> Any:
    """Parse JSON out of a model response, tolerating prose and code fences.

    Trusting the whole string to be JSON is fragile: models wrap it, prefix it,
    or trail an explanation. Taking the outermost ``{...}`` is far more reliable.
    """
    if not text or not text.strip():
        raise ValueError("empty response")
    cleaned = re.sub(r"```(?:json)?\s*", "", text).strip("` \n")
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start != -1 and end > start:
        return json.loads(cleaned[start:end + 1])
    raise ValueError("no JSON object found in response")


def message_of(response: Dict[str, Any]) -> Dict[str, Any]:
    """Pull the assistant message out of a completion response."""
    try:
        return response["choices"][0]["message"]
    except (KeyError, IndexError, TypeError):
        return {}


def text_of(response: Dict[str, Any]) -> str:
    """Pull the assistant text out of a completion response ('' if none)."""
    return (message_of(response).get("content") or "").strip()
