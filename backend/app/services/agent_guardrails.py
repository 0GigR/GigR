"""Agent guardrails — LLM context management, output validation, and guardrails.

Responsibilities:
  1. Context budget management — keeps token usage within safe limits
  2. System prompt construction — single source of truth, controlled context injection
  3. Output validation — strict Pydantic validation on every LLM response
  4. Hallucination detection — rejects structurally invalid LLM outputs
  5. Input sanitization — strips control characters and prompt-injection attempts
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, field_validator

logger = logging.getLogger(__name__)


VALID_TASK_TYPES = frozenset({
    "find_service",
    "find_job",
    "post_service",
    "post_job",
    "negotiate",
    "navigate",
    "pay",
    "reply_message",
    "generic",
    "plan",
    "apply_job",
    "proactive_hunt",
    "check_wallet",
    "cancel_jobs",
})

VALID_NAV_PAGES = frozenset({
    "home",
    "jobs",
    "services",
    "messages",
    "activity",
    "disputes",
    "profile",
})

# The task types that make the agent do something. "generic" is the only one
# that only answers in words, so it is the only type memory may legitimately
# produce.
ACTION_TASK_TYPES = VALID_TASK_TYPES - {"generic"}


def is_action_task(task_type: Any) -> bool:
    """True when a parsed task type performs an action rather than only replying.

    ``generic`` means "answer in words"; every other valid type means "do
    something". The intent guard uses this to tell a memory-shaped reply apart
    from an action the user asked for.
    """
    return task_type in ACTION_TASK_TYPES


_CHARS_PER_TOKEN = 4
CONTEXT_TOKEN_BUDGET = 2048
SESSION_HISTORY_BUDGET = 400
MEMORY_BUDGET = 200

# One remembered value can outgrow the whole hint: a mirrored memory value is
# capped at 2000 characters by the memory service. A value that long would spend
# the budget on its own and hide every other memory, so each entry is cut to
# this length before it is costed, and the joined hint is cut to MEMORY_BUDGET
# tokens worth of characters at the end. Both caps live here, next to the
# budget they protect.
MEMORY_ENTRY_CHARS = 160
MEMORY_HINT_MAX_CHARS = MEMORY_BUDGET * _CHARS_PER_TOKEN

# Where build_enriched_system_prompt puts the memory block. A base prompt
# carries this marker just before its closing instruction, so the instruction
# that tells the model to choose an action stays the last text it reads, however
# much memory is injected.
MEMORY_CONTEXT_ANCHOR = "[MEMORY_CONTEXT]"

# The framing that goes in front of the remembered facts. Memory is context for
# the decision, never the decision: without this framing the model reads a list
# of past services and answers a service request by repeating the list instead
# of choosing an action. ASCII only, like the rest of this file.
MEMORY_CONTEXT_RULES = (
    "[User context, for reference only. These are remembered facts about the "
    "user, not the task and not a list to repeat. They may change the query you "
    "choose; they never change what the user is asking for. When the user asks "
    "for a service, a job, a provider or a fix, choose the matching action even "
    "when this context lists services, and never answer with a list of these "
    "remembered entries. Answer from this context only when the user asks about "
    "their own history, preferences or usual prices."
)

_RESPONSE_LEAK_PATTERNS = [
    re.compile(r"you are a command parser", re.IGNORECASE),
    re.compile(r"return only\s+a?\s*json", re.IGNORECASE),
    re.compile(r"system\s+prompt", re.IGNORECASE),
    re.compile(r"\[context:", re.IGNORECASE),
    re.compile(r"\bgroq\b", re.IGNORECASE),
    re.compile(r"\bllama\b", re.IGNORECASE),
    re.compile(r"\bopenai\b", re.IGNORECASE),
    re.compile(r"\bgpt\b", re.IGNORECASE),
]

_CONTROL_CHAR_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")

_INJECTION_MARKERS = (
    "ignore previous instructions",
    "ignore all instructions",
    "disregard your",
    "you are now",
    "act as if",
    "jailbreak",
    "### instruction",
    "```system",
    "<|system|>",
)


class IntentParams(BaseModel):
    """Structured parameters extracted from the LLM intent response."""

    query: Optional[str] = None
    max_price: Optional[float] = None
    min_price: Optional[float] = None
    title: Optional[str] = None
    price: Optional[float] = None
    radius_km: Optional[float] = None
    job_id: Optional[str] = None
    page: Optional[str] = None
    steps: Optional[List[Dict[str, Any]]] = None
    cover_letter: Optional[str] = None
    child_task_ids: Optional[List[str]] = None
    parent_task_id: Optional[str] = None

    @field_validator("max_price", "min_price", "price", mode="before")
    @classmethod
    def _reject_negative_price(cls, v: Any) -> Any:
        if v is not None and float(v) < 0:
            raise ValueError(f"price field cannot be negative, got {v}")
        return v

    @field_validator("radius_km", mode="before")
    @classmethod
    def _clamp_radius(cls, v: Any) -> Any:
        if v is not None:
            km = float(v)
            if km <= 0 or km > 500:
                raise ValueError(f"radius_km must be between 0 and 500 km, got {km}")
        return v

    @field_validator("page", mode="before")
    @classmethod
    def _validate_page(cls, v: Any) -> Any:
        if v is not None and v not in VALID_NAV_PAGES:
            raise ValueError(f"unknown page '{v}'; allowed: {sorted(VALID_NAV_PAGES)}")
        return v


class ParsedIntent(BaseModel):
    """Fully validated, safe representation of a parsed user command."""

    task_type: str
    params: IntentParams
    response: str

    @field_validator("task_type", mode="before")
    @classmethod
    def _validate_task_type(cls, v: Any) -> Any:
        if v not in VALID_TASK_TYPES:
            raise ValueError(
                f"LLM returned unknown task_type '{v}'; valid types: {sorted(VALID_TASK_TYPES)}"
            )
        return v

    @field_validator("response", mode="before")
    @classmethod
    def _sanitize_response(cls, v: Any) -> Any:
        if not isinstance(v, str):
            return "Done."

        cleaned = _CONTROL_CHAR_RE.sub("", v).strip()

        for pattern in _RESPONSE_LEAK_PATTERNS:
            if pattern.search(cleaned):
                logger.warning(
                    "[guardrails] System prompt leakage detected in LLM response field; "
                    "replacing with safe fallback."
                )
                return "I have processed your request."

        return cleaned[:500]


def validate_intent(raw: Dict[str, Any]) -> Optional[ParsedIntent]:
    """Validate and normalise a raw LLM output dictionary.

    Returns ParsedIntent on success, or None when invalid.
    """
    if not isinstance(raw, dict):
        logger.warning("[guardrails] LLM output is not a dict: %r", type(raw))
        return None

    task_type = raw.get("task_type")
    if not task_type:
        logger.warning("[guardrails] LLM output missing task_type")
        return None

    try:
        params_raw = raw.get("params") or {}
        if not isinstance(params_raw, dict):
            params_raw = {}

        return ParsedIntent(
            task_type=task_type,
            params=IntentParams(
                **{k: v for k, v in params_raw.items() if v is not None}
            ),
            response=raw.get("response", ""),
        )
    except Exception as exc:
        logger.warning(
            "[guardrails] Intent validation failed (%s); falling back to rule-based parser.",
            exc,
        )
        return None


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // _CHARS_PER_TOKEN)


def prune_session_history(
    history: List[Dict[str, str]],
    budget_tokens: int = SESSION_HISTORY_BUDGET,
) -> List[Dict[str, str]]:
    """Trim session history from the oldest end to fit within the token budget."""
    if not history:
        return []

    total = sum(_estimate_tokens(h.get("content", "")) for h in history)
    if total <= budget_tokens:
        return list(history)

    pruned = list(history)
    while pruned and total > budget_tokens:
        dropped = pruned.pop(0)
        total -= _estimate_tokens(dropped.get("content", ""))

    return pruned


def build_memory_hint(memory: Dict[str, Any], budget_tokens: int = MEMORY_BUDGET) -> str:
    """Serialise the most useful memory fields into a compact hint string.

    The hint is bounded twice: each entry is cut to :data:`MEMORY_ENTRY_CHARS`
    before it is costed, and the whole hint is cut to
    :data:`MEMORY_HINT_MAX_CHARS`, which is :data:`MEMORY_BUDGET` tokens worth
    of characters. An entry that does not fit is skipped rather than ending the
    loop, so one long value cannot hide the smaller memories behind it.

    Priority fields come first. Every other field follows in a stable sorted
    order, because recalled Walrus facts arrive as whole sentences under their
    own labels and an allowlist of key names would discard them.
    """
    if not memory:
        return ""

    priority_keys = [
        "last_search",
        "location_name",
        "preferred_categories",
        "usual_price_job",
        "usual_price_service",
        "price_sensitivity",
        "last_active_job_id",
    ]
    ordered_keys = priority_keys + sorted(
        key for key in memory if key not in priority_keys
    )

    parts: List[str] = []
    tokens_used = 0

    for key in ordered_keys:
        value = memory.get(key)
        if value is None:
            continue
        if isinstance(value, list):
            value = ", ".join(str(v) for v in value[:5])
        hint = f"{key}: {value}"[:MEMORY_ENTRY_CHARS]
        cost = _estimate_tokens(hint)
        if tokens_used + cost > budget_tokens:
            continue
        parts.append(hint)
        tokens_used += cost

    return "; ".join(parts)[:MEMORY_HINT_MAX_CHARS]


def build_enriched_system_prompt(
    base_prompt: str,
    memory: Optional[Dict[str, Any]] = None,
    session_turn: int = 1,
) -> str:
    """Construct the system prompt with controlled context injection.

    The context block goes where the base prompt's :data:`MEMORY_CONTEXT_ANCHOR`
    marks, which a caller places just before its closing instruction. That keeps
    the action instruction in a stable position: adding memory never pushes it
    out of the prompt or lets memory text become the last thing the model reads.
    A base prompt without the marker gets the context first, which is still
    before every instruction, because appending it would put memory after the
    closing instruction, which is the regression this guards against.
    """
    context_parts: List[str] = []

    if memory:
        hint = build_memory_hint(memory)
        if hint:
            context_parts.append(f"{MEMORY_CONTEXT_RULES} {hint}]")

    if session_turn > 1:
        context_parts.append(
            f"[This is turn {session_turn} of an ongoing session. "
            f"Earlier turns are in the conversation history.]"
        )

    context = "\n\n".join(context_parts)

    if MEMORY_CONTEXT_ANCHOR in base_prompt:
        rendered = base_prompt.replace(MEMORY_CONTEXT_ANCHOR, context, 1)
        return re.sub(r"\n{3,}", "\n\n", rendered)

    if not context:
        return base_prompt

    return f"{context}\n\n{base_prompt}"


def sanitize_user_input(text: str) -> str:
    """Sanitise raw user input before it enters the LLM context."""
    if not isinstance(text, str):
        return ""

    cleaned = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)
    cleaned = re.sub(r"[ \t]{4,}", "   ", cleaned)
    cleaned = re.sub(r"\n{4,}", "\n\n\n", cleaned)
    cleaned = cleaned.strip()

    text_lower = cleaned.lower()
    for marker in _INJECTION_MARKERS:
        if marker in text_lower:
            logger.warning(
                "[guardrails] Possible prompt-injection attempt in user input "
                "(marker: %r). Input sanitised; output will be validated.",
                marker,
            )
            break

    return cleaned[:2000]
