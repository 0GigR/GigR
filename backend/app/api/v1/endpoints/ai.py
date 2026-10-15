"""
AI Agent — consolidated backend module.

This single file contains EVERYTHING AI/agent related:

  1. NLP layer       — parse natural language → structured intent
                        Primary:  Groq Llama-3 (free, console.groq.com)
                        Fallback: enhanced rule-based regex interpreter
  2. Task handlers  — search, negotiate, post_job (all inline, async)
  3. Agent loop     — asyncio background coroutine, polls DB every N seconds
  4. API routes     — submit commands, list tasks, get task+logs, cancel

No paid APIs required. Groq's free tier gives 14,400 requests/day with
Llama-3 8B. Leave GROQ_API_KEY blank to use the rule-based fallback.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from ....core.config import settings
from ....core.database import async_session
from ....core.dependencies import get_db, get_current_user, require_ai_enabled
from ....crud.service import search_services_by_text
from ....crud.message import create_message
from ....models.user import User
from ....models.service import ServiceListing
from ....models.agent_task import AgentTask
from ....models.agent_log import AgentLog
from ....schemas.agent import AgentCommandRequest, AgentTaskOut, AgentLogOut, AgentTaskListOut
from ....services.ws_manager import manager as _ws_manager
from ....services.groq_client import extract_json as _extract_json
from ....services.agent_guardrails import (
    sanitize_user_input,
    validate_intent,
    build_enriched_system_prompt,
    prune_session_history,
)
from ....services.agent_session import (
    get_session_history,
    record_session_turn,
)

router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1: NLP — parse natural language into structured intent
# ═══════════════════════════════════════════════════════════════════════════════

# System prompt for Groq Llama-3 NLP
_GROQ_SYSTEM_PROMPT = """You are Gigidy AI, the friendly and reliable assistant for Gigr, a Nigerian freelance and services marketplace.
Extract the user's intent from their message and return ONLY a JSON object with these fields:

{
  "task_type": "find_service" | "find_job" | "post_service" | "post_job" | "negotiate" | "navigate" | "pay" | "reply_message" | "plan" | "check_wallet" | "generic",
  "params": {
    "query": "search query string",
    "max_price": 5000,          // number in naira, null if not specified
    "min_price": 5000,          // number in naira
    "title": "title",           // for post_job or post_service
    "price": 5000,              // number in naira
    "radius_km": 10,            // distance in km, only if the user says one
    "job_id": "optional id",    // for pay
    "page": "jobs|services|messages|activity|disputes|profile|home",  // for navigate
    "steps": [                  // for "plan" only: array of child subtasks
      {"task_type": "find_service", "params": {"query": "cleaner"}},
      {"task_type": "post_job", "params": {"title": "AC repair", "price": 10000}}
    ]
  },
  "response": "brief, friendly confirmation message to show user"
}

Rules:
- "check_wallet" = user asks about their wallet balance, funds, SOL, USDC, or wallet address.
- "find_service" = user wants to find someone to hire, OR user describes physical symptoms/needs ("my back hurts", "sore body" → query: "massage", "burst pipe" → query: "plumber").
- max_price: null if not specified. NEVER invent or guess a budget or max_price unless the user explicitly stated a number.
- "plan" = compound request containing two or more distinct goals (e.g. "clean my room and fix the tap", "find a photographer and post a job for a DJ"). Populate params.steps with the subtask objects.
- "post_job" = user wants to HIRE SOMEONE / create a task
- "post_service" = user wants to WORK / offer their skills
- "find_job" = user is a freelancer looking for open jobs to apply to
- "negotiate" = user wants to find AND negotiate price (e.g. "find someone for 5k and negotiate")
- "within 20km" / "in 10 km" → params.radius_km = 20 / 10. Only set it when the
  user actually mentions a distance.
- Numbers: convert "5k" → 5000, "10k" → 10000, "₦5,000" → 5000, "five thousand" → 5000
- If the intent is unclear, use "generic" — NOT "search", which is not a
  supported task type and silently degrades to a chat reply
- Return ONLY the JSON, no markdown, no explanation"""


async def _call_groq_with_fallback(client: httpx.AsyncClient, url: str, **kwargs):
    """Try multiple Groq API keys if one gets rate limited.

    Thin alias over the shared client so every LLM call in the app rotates keys
    the same way. Kept in place because existing call sites pass a pre-built
    httpx client.
    """
    from ....services.groq_client import call_with_key_rotation
    return await call_with_key_rotation(client, url, **kwargs)

async def _parse_command_groq(
    text: str,
    memory: Optional[Dict[str, Any]] = None,
    session_history: Optional[List[Dict[str, str]]] = None,
) -> Optional[Dict[str, Any]]:
    """Call Groq Llama-3 to parse the command into structured intent.
    Returns None if Groq is not configured or the call fails."""
    if not settings.groq_keys_list:
        return None

    clean_text = sanitize_user_input(text)
    pruned_history = prune_session_history(session_history or [])
    turn_number = (len(pruned_history) // 2) + 1
    system_prompt = build_enriched_system_prompt(_GROQ_SYSTEM_PROMPT, memory=memory, session_turn=turn_number)

    messages: List[Dict[str, str]] = [{"role": "system", "content": system_prompt}]
    for msg in pruned_history:
        messages.append({"role": msg.get("role", "user"), "content": msg.get("content", "")})
    messages.append({"role": "user", "content": clean_text})

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await _call_groq_with_fallback(
                client,
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Content-Type": "application/json"},
                json={
                    "model": settings.GROQ_MODEL,
                    "messages": messages,
                    "temperature": 0.1,
                    # Generous headroom: gpt-oss spends a big chunk of the budget
                    # on hidden reasoning, and 300 tokens truncated the JSON
                    # mid-string, which silently fell back to the regex parser.
                    "max_tokens": 900,
                    "reasoning_effort": "low",
                },
            )
            content = response.json()["choices"][0]["message"]["content"] or ""
            raw_json = _extract_json(content)
            if raw_json:
                validated = validate_intent(raw_json)
                if validated:
                    return validated.model_dump()
                logger.warning("[agent] Groq output failed guardrails validation; falling back to rule-based")
            return None
    except Exception as exc:
        logger.warning("[agent] Groq NLP failed (%s), falling back to rule-based", exc)
        return None


# ─── Price helpers ────────────────────────────────────────────────────────────

_PRICE_PATTERN = re.compile(
    r"(?:no more than|no less than|under|less than|max(?:imum)?|budget(?:\s+of)?|for|at)\s*"
    r"(?:₦|naira)?\s*"
    r"(\d[\d,]*(?:\.\d+)?)\s*([kK]?)",
    re.IGNORECASE,
)

_WORD_NUMBERS = {
    "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "fifteen": 15, "twenty": 20,
    "thirty": 30, "forty": 40, "fifty": 50, "hundred": 100,
    "thousand": 1000,
}


def _extract_price(text: str) -> Optional[float]:
    """Extract a price from text, handling k-suffixes and word numbers."""
    match = _PRICE_PATTERN.search(text)
    if match:
        num = float(match.group(1).replace(",", ""))
        if match.group(2).lower() == "k":
            num *= 1000
        return num

    # Bare k-suffix without prefix keyword: "fix my sink 5k" → 5000
    bare_k = re.search(r"\b(\d[\d,]*(?:\.\d+)?)\s*[kK]\b", text)
    if bare_k:
        return float(bare_k.group(1).replace(",", "")) * 1000

    # Bare large number (4+ digits, e.g. "8000"): "fix my sink 8000"
    bare_num = re.search(r"\b(\d{4,}(?:,\d{3})*(?:\.\d+)?)\b", text)
    if bare_num:
        return float(bare_num.group(1).replace(",", ""))

    # Try word-number pattern: "five thousand" → 5000
    text_lower = text.lower()
    for word, val in _WORD_NUMBERS.items():
        if word in text_lower:
            # Look for multiplier
            if "thousand" in text_lower and word != "thousand":
                idx = text_lower.find(word)
                if text_lower.find("thousand") > idx:
                    return val * 1000
    return None

def _extract_radius_km(text: str) -> Optional[float]:
    """Pull an explicit distance out of a command ("within 20km", "in 5 km")."""
    match = re.search(
        r"(?:within|inside|in|under|about|around)\s+(\d+(?:\.\d+)?)\s*(?:km|kms|kilomet(?:er|re)s?)",
        text or "",
        re.IGNORECASE,
    )
    if not match:
        return None
    try:
        value = float(match.group(1))
    except ValueError:
        return None
    return value if 0 < value <= 500 else None


def _extract_search_query(text: str) -> Optional[str]:
    """Extract the core search intent from a command string."""
    patterns = [
        r"(?:find|get|hire)\s+(?:someone\s+to\s+|me\s+a\s+|a\s+|an\s+|me\s+)?(.+?)(?:\s+for\s+no\s+more|\s+no\s+less|\s+for\s+under|\s+under|\s+for\s+max|\s+budget|\s+for\s+₦|\s+for\s+\d|$)",
        r"(?:search|look\s+for)\s+(?:a\s+|an\s+)?(.+?)(?:\s+for\s+|\s+under\s+|\s+no\s+less|\s+no\s+more|\s*$)",
        r"(?:i\s+need|i\s+want|i\s+am\s+looking\s+for)\s+(?:a\s+|an\s+)?(.+?)(?:\s+for\s+|\s*$)",
        r"(?:someone|a\s+person)\s+(?:who\s+can\s+|who\s+will\s+|to\s+)?(.+?)(?:\s+for\s+|\s*$)",
        r"(?:looking\s+for)\s+(?:a\s+|an\s+|someone\s+(?:to\s+|who\s+can\s+))?(.+?)(?:\s+for\s+|\s*$)",
    ]
    for pat in patterns:
        m = re.search(pat, text, re.IGNORECASE)
        if m:
            q = m.group(1).strip()
            # Remove trailing price qualifiers more aggressively
            q = re.sub(r"\s+(for\s+)?(no\s+more|no\s+less|under|less\s+than|max|budget).*$", "", q, flags=re.IGNORECASE).strip()
            if q:
                return q
    return None

def _parse_command_rules(text: str) -> Dict[str, Any]:
    """Rule-based NLP fallback. Returns same structure as Groq parser."""
    text_lower = text.lower().strip()

    # ─── Navigation ─────────────────────────────────────────────────
    nav_map = {
        "home": "home", "dashboard": "home",
        "jobs": "jobs", "services": "services",
        "messages": "messages", "inbox": "messages",
        "activity": "activity", "disputes": "disputes",
        "profile": "profile",
    }
    # Allow "go to my jobs" → captures "jobs" even with "my" prefix
    nav_patterns = [
        r"go\s+to\s+(?:my\s+)?(\w+)",
        r"open\s+(?:my\s+)?(\w+)",
        r"show\s+(?:me\s+)?(?:my\s+)?(\w+)",
        r"navigate\s+to\s+(?:my\s+)?(\w+)",
    ]
    for pat in nav_patterns:
        m = re.search(pat, text_lower)
        if m and m.group(1) in nav_map:
            page = nav_map[m.group(1)]
            return {"task_type": "navigate", "params": {"page": page}, "response": f"Navigating to {page}"}

    # ─── Wallet balance / funds check ────────────────────────────────
    if re.search(r"\b(?:wallet|balance|sol\b|usdc\b|funds?|how much money|my crypto)\b", text_lower):
        return {
            "task_type": "check_wallet",
            "params": {},
            "response": "Checking your wallet balance...",
        }

    # ─── Physical symptoms / needs mapping ───────────────────────────
    if re.search(r"\b(?:back\s+hurts?|sore\s+body|body\s+(?:is\s+)?sore|massage|masseuse|stiff\s+neck|body\s+pain)\b", text_lower):
        return {
            "task_type": "find_service",
            "params": {"query": "massage", "max_price": _extract_price(text), "radius_km": _extract_radius_km(text)},
            "response": "Searching for massage services...",
        }

    if re.search(r"\b(?:burst\s+pipe|pipe\s+burst|leaking\s+pipe|leaking\s+sink|clogged\s+drain)\b", text_lower):
        return {
            "task_type": "find_service",
            "params": {"query": "plumber", "max_price": _extract_price(text), "radius_km": _extract_radius_km(text)},
            "response": "Searching for plumbing services...",
        }

    if re.search(r"\b(?:what\s+can\s+you\s+do|how\s+(?:can|do)\s+you\s+work|capabilities)\b", text_lower):
        return {
            "task_type": "generic",
            "params": {"query": text},
            "response": "I am Gigidy AI, your assistant on Gigr! I can help you find verified workers and services nearby, check open gigs, check your wallet balance, help negotiate good prices, and post jobs. Just tell me what you need!",
        }

    # ─── Generic / greeting guard (before intent checks) ─────────────
    # Catch short greetings, rhetorical questions, and ambiguous inputs
    _action_words = r"find|job|service|hire|work|post|create|offer|pay|fund|release|negotiate|search|look|need|want|fix|build|clean|repair|help|plumb|electric|cook|drive|design"
    is_question = text_lower.endswith("?") or re.match(r"^(are|is|do|does|can|could|would|will|what|where|why|how|who)\b", text_lower)
    has_action = bool(re.search(_action_words, text_lower))
    
    if (len(text_lower.split()) <= 5 and not has_action) or (is_question and not has_action):
        return {
            "task_type": "generic",
            "params": {"query": text},
            "response": "Could you clarify what you'd like to do? I can help you find services, post jobs, negotiate prices, or navigate the app. Try: 'find a plumber for 5k'.",
        }

    price = _extract_price(text)

    # ─── Find Job (Looking for work) — checked BEFORE navigate shortcuts ──
    if re.search(r"(?:find|search|look\s+for|get)\s+(?:a\s+)?(?:job|work|gig)", text_lower) or \
       re.search(r"\b(?:find|get)\s+work\b", text_lower):
        query = _extract_search_query(text_lower)
        return {
            "task_type": "find_job",
            "params": {"query": query or text, "min_price": price, "radius_km": _extract_radius_km(text)},
            "response": f"Searching for open jobs matching '{query or text}'" + (f" above ₦{price:,.0f}" if price else ""),
        }

    # ─── Browse jobs / open jobs (navigation shortcut) ───────────────
    if re.search(r"(?:show|browse|see)\s+(?:open\s+)?(?:all\s+)?jobs?", text_lower):
        return {"task_type": "navigate", "params": {"page": "jobs"}, "response": "Showing open jobs"}

    # ─── My jobs ─────────────────────────────────────────────────────
    if re.search(r"(?:check|show)\s+(?:my\s+)(?:active|open|current)?\s*jobs?", text_lower):
        return {"task_type": "navigate", "params": {"page": "activity"}, "response": "Showing your activity"}

    # ─── Negotiate command ────────────────────────────────────────────
    if re.search(r"negotiate|haggle|bargain|offer|can you get|get me", text_lower):
        query = _extract_search_query(text_lower)
        return {
            "task_type": "negotiate",
            "params": {"query": query or text, "max_price": price},
            "response": f"I'll search and negotiate for '{query or text}'" + (f" under ₦{price:,.0f}" if price else ""),
        }

    # ─── Post Service (Offering to work) ──────────────────────────────
    if re.search(r"(?:post|create|add|offer)\s+(?:a\s+)?service", text_lower) or re.search(r"i want to work as", text_lower):
        stripped = re.sub(r"^(.*?)(?:post|create|add|offer)\s+(a\s+)?service\s+(called|titled|for)?\s*", "", text, flags=re.IGNORECASE)
        title = re.sub(r"(?:\.|\,)?\s*(?:for no less than|for|at least|at|my rate is)\s*(?:naira|₦)?\s*\d+.*$", "", stripped, flags=re.IGNORECASE).strip()
        title = title.rstrip(".,;")
        if not title: title = stripped.strip()
        return {
            "task_type": "post_service",
            "params": {"title": title, "price": price},
            "response": f"Creating service offer '{title}'" + (f" for ₦{price:,.0f}" if price else ""),
        }

    # ─── Post Job (Looking to hire) ───────────────────────────────────
    if re.search(r"(?:post|create|add|make)\s+(?:a\s+)?job", text_lower) or re.search(r"i need someone to", text_lower):
        stripped = re.sub(r"^(.*?)(?:post|create|add|make)\s+(a\s+)?job\s+(called|titled|for)?\s*", "", text, flags=re.IGNORECASE)
        title = re.sub(r"(?:\.|\,)?\s*(?:i am not willing to pay more than|for no more than|for|under|budget|at)\s*(?:naira|₦)?\s*\d+.*$", "", stripped, flags=re.IGNORECASE).strip()
        title = title.rstrip(".,;")
        if not title: title = stripped.strip()
        return {
            "task_type": "post_job",
            "params": {"title": title, "price": price},
            "response": f"Creating job '{title}'" + (f" for ₦{price:,.0f}" if price else ""),
        }

    # ─── Find Service (Looking to hire provider) ──────────────────────
    if re.search(r"(?:find|search|look\s+for|need|want|hire|get)\s+(?:me\s+)?(?:a|an|someone)", text_lower):
        query = _extract_search_query(text_lower)
        return {
            "task_type": "find_service",
            "params": {"query": query or text, "max_price": price, "radius_km": _extract_radius_km(text)},
            "response": f"Searching for services matching '{query or text}'" + (f" under ₦{price:,.0f}" if price else ""),
        }

    # ─── Pay ────────────────────────────────────────────────────────
    if re.search(r"pay\s+for|fund|release\s+payment", text_lower):
        return {
            "task_type": "pay",
            "params": {"query": text},
            "response": "Processing payment...",
        }

    # ─── Reply Message ────────────────────────────────────────────────
    if re.search(r"^reply to this message:", text_lower):
        return {
            "task_type": "reply_message",
            "params": {"query": text},
            "response": "Auto-replying to message...",
        }

    # ─── Final fallback ───────────────────────────────────────────────
    query = _extract_search_query(text_lower) or text
    return {
        "task_type": "find_service",
        "params": {"query": query, "max_price": price},
        "response": f"Searching for '{query}'",
    }


# (Removed extract_search_query from here since it was moved up)


async def parse_command(
    text: str,
    memory: Optional[Dict[str, Any]] = None,
    session_history: Optional[List[Dict[str, str]]] = None,
) -> Dict[str, Any]:
    """Parse a natural language command into structured intent.

    Tries Groq Llama-3 first with context guardrails, memory enrichment, and multi-turn session context.
    Falls back to rule-based regex parser if Groq key is missing or validation fails.
    """
    clean_text = sanitize_user_input(text)
    groq_result = await _parse_command_groq(clean_text, memory=memory, session_history=session_history)
    if groq_result and groq_result.get("task_type"):
        return groq_result
    return _parse_command_rules(clean_text)


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 2: Task handlers — each task type has its own async handler
# ═══════════════════════════════════════════════════════════════════════════════

async def _log(db: AsyncSession, task_id: uuid.UUID, level: str, message: str, data: Any = None):
    """Write a single log entry for a task."""
    entry = AgentLog(task_id=task_id, level=level, message=message, data=data)
    db.add(entry)
    await db.flush()


async def _load_memory(db: AsyncSession, user_id: uuid.UUID) -> Dict[str, Any]:
    """Load the agent memory stored in user.ai_settings['memory']."""
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        return {}
    return (user.ai_settings or {}).get("memory", {})


async def _save_memory(db: AsyncSession, user_id: uuid.UUID, updates: Dict[str, Any]) -> None:
    """Merge updates into user.ai_settings['memory'] and persist."""
    from sqlalchemy import update as sa_update
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()
    if not user:
        return
    settings_now = dict(user.ai_settings or {})
    memory = dict(settings_now.get("memory", {}))
    memory.update(updates)
    settings_now["memory"] = memory
    await db.execute(sa_update(User).where(User.id == user_id).values(ai_settings=settings_now))
    # flush only — caller commits


async def _request_service(db: AsyncSession, task: AgentTask, service: ServiceListing) -> str:
    """Automatically create a Job linked to the found service and send a message."""
    from ....crud.job import create_job
    from ....schemas.job import JobCreate
    from ....crud.message import create_message

    try:
        price = task.params.get("max_price") or float(service.price)
        job_in = JobCreate(
            title=f"Request for: {service.title}",
            description=f"Auto-requested via AI Agent. Based on command: '{task.command_text}'",
            price=price
        )
        job = await create_job(db, task.user_id, job_in)
        job.provider_id = service.provider_id
        job.service_listing_id = service.id
        job.status = "requested"
        job.contract_job_id = hex(uuid.uuid4().int & 0xFFFFFFFFFFFFFFFF)
        await db.flush()

        msg_content = f"Hi! My AI assistant matched me with your service '{service.title}'. I would like to proceed."
        if task.params.get("max_price"):
            msg_content += f" My budget is ₦{task.params['max_price']:,.0f}."

        msg = await create_message(db, job.id, task.user_id, msg_content)
        await db.flush()

        from ....api.v1.endpoints.messages import manager
        await manager.broadcast_new_message(msg)

        # Trigger notification and email to provider
        from ....crud.user import get_user_by_id
        from ....crud.notification import create_notification
        provider = await get_user_by_id(db, service.provider_id)
        if provider:
            user_res = await db.execute(select(User).where(User.id == task.user_id))
            searcher = user_res.scalar_one_or_none()
            sender_name = searcher.display_name if searcher else "Someone"
            
            await create_notification(
                db,
                user_id=provider.id,
                title="New Service Request",
                message=f"{sender_name} has requested your service '{service.title}'.",
                link=f"/dashboard/jobs?jobId={job.id}",
                type="request",
            )
            
            if provider.email:
                from ....api.v1.endpoints.jobs import _send_email_background
                frontend_url = settings.FRONTEND_URL.rstrip('/') if settings.FRONTEND_URL else "https://gigrr.vercel.app"
                _send_email_background(
                    to_email=provider.email,
                    subject=f"New request for {service.title}",
                    html_content=f"<p>{sender_name} has requested your service <strong>{service.title}</strong> via AI Agent. <a href='{frontend_url}/dashboard/jobs/{job.id}'>View request</a></p>"
                )

        return f"Successfully requested service and sent a message to the provider. Please check your [Jobs](/dashboard/jobs) or [Activity](/dashboard/activity) page for updates."
    except Exception as exc:
        logger.warning("[agent] Failed to auto-request service: %s", exc)
        return f"Found service but failed to auto-request it."


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    import math
    R = 6371
    dlat = math.radians(lat2 - lat1)
    dlng = math.radians(lng2 - lng1)
    a = math.sin(dlat/2)**2 + math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(dlng/2)**2
    return R * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))


async def _handle_find_service(task: AgentTask, db: AsyncSession) -> Dict[str, Any]:
    """Search for services matching the task query (Client looking to hire)."""
    params = task.params or {}
    query: str = params.get("query", "")
    max_price: Optional[float] = params.get("max_price")

    # Load user location for proximity filtering
    user_res = await db.execute(select(User).where(User.id == task.user_id))
    searcher = user_res.scalar_one_or_none()
    user_lat = getattr(searcher, "location_lat", None) if searcher else None
    user_lng = getattr(searcher, "location_lng", None) if searcher else None
    location_note = " near you" if user_lat else ""

    await _log(db, task.id, "action",
               f"Searching for services: '{query}'{location_note} (within {float(params.get('radius_km') or 10):g} km)"
               + (f" (max ₦{max_price:,.0f})" if max_price else ""))

    services = await search_services_by_text(db, query, limit=50)
    services = [s for s in services if s.provider_id != task.user_id]

    # Respect the distance the user asked for. This used to silently fall back to
    # every match in the country whenever fewer than three were nearby, which made
    # "near you" mean nothing and hid why a result appeared.
    radius_km = params.get("radius_km") or 10.0
    distances: Dict[str, float] = {}
    within = []
    if user_lat and user_lng:
        for service in services:
            if service.latitude is None or service.longitude is None:
                continue
            km = _haversine_km(user_lat, user_lng, float(service.latitude), float(service.longitude))
            distances[str(service.id)] = round(km, 1)
            if km <= radius_km:
                within.append(service)

        services.sort(key=lambda s: distances.get(str(s.id), 99999.0))
        within.sort(key=lambda s: distances.get(str(s.id), 99999.0))

    if settings.FEATURE_AGENT_REASONING_VISIBLE:
        await _log(
            db, task.id, "think",
            f"Evaluating service providers matching '{query}' within {radius_km:g} km radius..."
        )

    target_pool = within if (user_lat and user_lng and within) else services
    outside_radius_note = None
    if user_lat and user_lng and not within and services:
        nearest_distance = distances.get(str(services[0].id))
        distance_label = f" ({nearest_distance:g} km away)" if nearest_distance is not None else ""
        outside_radius_note = f"None within {radius_km:g} km, but found provider(s) further away{distance_label}"

    if max_price:
        filtered = [s for s in target_pool if float(s.price) <= max_price]
    else:
        filtered = target_pool

    if settings.FEATURE_AGENT_REASONING_VISIBLE:
        await _log(
            db, task.id, "think",
            f"Evaluated {len(target_pool)} candidate(s); {len(filtered)} within target budget."
        )

    if filtered:
        service_cards = [
            {
                "id": str(s.id),
                "title": s.title,
                "price": float(s.price),
                "description": s.description or "",
                "distance_km": distances.get(str(s.id)),
                "latitude": float(s.latitude) if s.latitude is not None else None,
                "longitude": float(s.longitude) if s.longitude is not None else None,
            }
            for s in filtered[:5]
        ]
        dialog_options = [
            {"label": f"{s['title']} — ₦{s['price']:,.0f}", "action": f"select_service:{s['id']}"}
            for s in service_cards
        ]
        dialog_options.append({"label": "Post a job instead", "action": "post_job"})
        dialog_options.append({"label": "Cancel", "action": "cancel"})

        found_msg = f"Found {len(filtered)} matching service(s)"
        if outside_radius_note:
            found_msg += f" ({outside_radius_note})"
        found_msg += ". Which would you like me to request?"

        await _log(db, task.id, "success",
                   found_msg,
                   {
                       "render_type": "service_cards",
                       "services": service_cards,
                       "outside_radius_note": outside_radius_note,
                       "action_payload": {
                           "type": "select_service",
                           "query": query,
                           "max_price": max_price,
                           "options": dialog_options,
                       }
                   })
        return {"found": True, "count": len(filtered), "services": service_cards}
    else:
        closest = sorted(target_pool, key=lambda s: float(s.price))[:3]
        if closest and max_price:
            names = [f"{s.title} — ₦{float(s.price):,.0f}" for s in closest]
            await _log(db, task.id, "warning",
                       f"No services under ₦{max_price:,.0f}. Closest options:\n" + "\n".join(names))

        dialog_payload = {
            "type": "create_job_fallback",
            "title": query,
            "price": max_price or (float(closest[0].price) if closest else None),
            "options": [
                {"label": f"Yes, post a job for '{query}'", "action": "confirm"},
                {"label": "Cancel", "action": "cancel"},
            ]
        }
        await _log(db, task.id, "info",
                   f"No services found matching '{query}'. Would you like me to post a job instead?",
                   data={"action_payload": dialog_payload})
        return {"found": False, "count": 0}

async def _handle_find_job(task: AgentTask, db: AsyncSession) -> Dict[str, Any]:
    """Search for open jobs (Provider looking for work)."""
    from ....crud.job import search_jobs_by_text
    params = task.params or {}
    query: str = params.get("query", "")
    min_price: Optional[float] = params.get("min_price")

    # Load user location for proximity filtering
    user_res = await db.execute(select(User).where(User.id == task.user_id))
    searcher = user_res.scalar_one_or_none()
    user_lat = getattr(searcher, "location_lat", None) if searcher else None
    user_lng = getattr(searcher, "location_lng", None) if searcher else None
    location_note = " near you" if user_lat else ""

    await _log(db, task.id, "action", f"Searching for open jobs: '{query}'{location_note}" + (f" (min ₦{min_price:,.0f})" if min_price else ""))

    jobs = await search_jobs_by_text(db, query, limit=50)
    jobs = [j for j in jobs if j.client_id != task.user_id and j.status == "open"]

    # Real proximity filter: compute Haversine distance from the searcher to each
    # job that has a location. Keep those within 25 km (fall back to all if <3).
    job_radius_km = params.get("radius_km") or 15.0
    if user_lat and user_lng:
        with_distance = []
        for j in jobs:
            jlat, jlng = j.latitude, j.longitude
            if jlat is not None and jlng is not None:
                d = _haversine_km(user_lat, user_lng, float(jlat), float(jlng))
                if d <= job_radius_km:
                    with_distance.append((d, j))
        jobs = [j for _, j in sorted(with_distance, key=lambda x: x[0])]
    if settings.FEATURE_AGENT_REASONING_VISIBLE:
        await _log(
            db, task.id, "think",
            f"Scanning open gig postings matching '{query}' within {job_radius_km:g} km..."
        )

    if min_price:
        filtered = [j for j in jobs if float(j.price) >= min_price]
    else:
        filtered = jobs

    if settings.FEATURE_AGENT_REASONING_VISIBLE:
        await _log(
            db, task.id, "think",
            f"Identified {len(jobs)} active job(s); {len(filtered)} meeting rate criteria."
        )

    if filtered:
        job_cards = [
            {
                "id": str(j.id),
                "title": j.title,
                "price": float(j.price),
                "description": getattr(j, 'description', '') or "",
                "latitude": float(j.latitude) if j.latitude is not None else None,
                "longitude": float(j.longitude) if j.longitude is not None else None,
            }
            for j in filtered[:5]
        ]
        await _log(db, task.id, "success", f"Found {len(filtered)} open job(s) matching '{query}':",
                   data={
                       "render_type": "job_cards",
                       "jobs": job_cards,
                   })
        return {"found": True, "count": len(filtered), "jobs": job_cards}
    else:
        await _log(db, task.id, "warning", f"No open jobs found matching '{query}'.")
        return {"found": False, "count": 0}


async def _handle_negotiate(task: AgentTask, db: AsyncSession) -> Dict[str, Any]:
    """Search for services. If none in budget, message the closest providers to negotiate."""
    from ....crud.job import get_jobs_by_client

    params = task.params or {}
    query: str = params.get("query", "")
    max_price: Optional[float] = params.get("max_price")

    # Step 1: search
    await _log(db, task.id, "action", f"Starting negotiation search for: '{query}'" + (f" (budget: ₦{max_price:,.0f})" if max_price else ""))

    services = await search_services_by_text(db, query, limit=20)
    services = [s for s in services if s.provider_id != task.user_id]

    if max_price:
        within_budget = [s for s in services if float(s.price) <= max_price]
    else:
        within_budget = services

    if within_budget:
        service_cards = [
            {"id": str(s.id), "title": s.title, "price": float(s.price), "description": s.description or ""}
            for s in within_budget[:5]
        ]
        dialog_options = [
            {"label": f"{s['title']} — ₦{s['price']:,.0f}", "action": f"select_service:{s['id']}"}
            for s in service_cards
        ]
        dialog_options.append({"label": "Post a job instead", "action": "post_job"})
        dialog_options.append({"label": "Cancel", "action": "cancel"})

        await _log(db, task.id, "success", f"Found {len(within_budget)} service(s) within your budget. Which would you like to request?",
                   data={
                       "render_type": "service_cards",
                       "services": service_cards,
                       "action_payload": {
                           "type": "select_service",
                           "query": query,
                           "max_price": max_price,
                           "options": dialog_options,
                       }
                   })

        return {
            "negotiated": False,
            "found_within_budget": True,
            "services": service_cards,
            "message": f"Found {len(within_budget)} services within your budget — awaiting selection.",
        }

    # Step 2: negotiate — check if user has negotiation enabled
    user_result = await db.execute(select(User).where(User.id == task.user_id))
    user = user_result.scalar_one_or_none()

    if not user:
        await _log(db, task.id, "error", "Error: Could not find user account")
        return {"negotiated": False, "error": "User not found"}

    # Check if negotiation is enabled via the user's saved AI settings
    ai_negotiate = (user.ai_settings or {}).get("autonomyLevel") in ["medium", "high", "total"]
    if not ai_negotiate:
        closest = sorted(services, key=lambda s: float(s.price))[:3]
        names = [f"{s.title} — ₦{float(s.price):,.0f}" for s in closest]
        await _log(db, task.id, "info",
                   f"No services within budget. Negotiation is disabled in your AI Settings.\n"
                   f"Closest options:\n" + "\n".join(names) if names else "No services found at all.")
        return {
            "negotiated": False,
            "found_within_budget": False,
            "closest": [{"id": str(s.id), "title": s.title, "price": float(s.price)} for s in closest],
            "message": "Negotiation is disabled. Enable it in AI Settings to let me message providers.",
        }

    # Step 3: Send ONE negotiation message to the best match (lowest price, closest to budget)
    closest = sorted(services, key=lambda s: abs(float(s.price) - (max_price or float(s.price))))
    best = closest[0] if closest else None
    if not best:
        await _log(db, task.id, "warning", f"No services found at all for '{query}'")
        return {"negotiated": False, "message": "No providers found to negotiate with"}

    negotiated_with = []
    for service in [best]:
        # Find an existing job/chat between this user and provider for this service
        from ....models.job import Job
        job_result = await db.execute(
            select(Job).where(
                and_(
                    Job.client_id == task.user_id,
                    Job.service_listing_id == service.id,
                    Job.status.notin_(["cancelled", "completed"]),
                )
            ).limit(1)
        )
        job = job_result.scalar_one_or_none()

        if not job:
            from ....crud.job import create_job
            from ....schemas.job import JobCreate
            job_in = JobCreate(
                title=f"Negotiation for: {service.title}",
                description="Auto-generated job created by AI agent for price negotiation.",
                price=max_price or float(service.price)
            )
            try:
                job = await create_job(db, task.user_id, job_in)
                job.provider_id = service.provider_id
                job.service_listing_id = service.id
                job.status = "assigned" # Set as assigned so messages can be attached
                await db.flush()
            except Exception as exc:
                await _log(db, task.id, "error", f"Failed to create provisional job for '{service.title}': {exc}")
                continue

        # Send negotiation message in existing or new job chat
        price_str = f"₦{max_price:,.0f}" if max_price else "a lower price"
        msg_content = (
            f"Hi! I'm interested in your service '{service.title}' (currently ₦{float(service.price):,.0f}). "
            f"I have a budget of {price_str}. Could you accommodate? This message was sent by my AI assistant on Gigr."
        )
        try:
            await _log(db, task.id, "action", f"Sending opening offer to '{service.title}' provider...")
            msg = await create_message(db, job.id, task.user_id, msg_content)
            await db.flush()
            await _ws_manager.broadcast_new_message(msg)

            # Count messages so the reply-checker knows where to start reading
            from ....models.message import Message as _Msg
            msg_count_res = await db.execute(
                select(_Msg).where(_Msg.job_id == job.id)
            )
            msg_count = len(msg_count_res.scalars().all())

            await _log(db, task.id, "success",
                       f"Opening offer sent to provider for **'{service.title}'** (₦{float(service.price):,.0f}). "
                       f"I'll monitor their reply and negotiate on your behalf. "
                       f"[View chat](/dashboard/messages)")
            # Emit structured log so the frontend can render the price-comparison bar chart.
            original_price = float(service.price)
            target_price = max_price or original_price
            round_num = 1
            await _log(
                db,
                task.id,
                "success",
                f"Negotiation round {round_num}: opening offer submitted.",
                data={
                    "render_type": "negotiation_progress",
                    "original_price": original_price,
                    "target_price": target_price,
                    "counter_price": None,
                    "round": round_num,
                    "savings": max(0.0, original_price - target_price),
                },
            )
            negotiated_with.append({
                "service_id": str(service.id), "title": service.title, "job_id": str(job.id)
            })
        except Exception as exc:
            await _log(db, task.id, "error", f"Failed to send message for '{service.title}': {exc}")

    neg_state = None
    if negotiated_with:
        neg_state = {
            "active": True,
            "job_id": negotiated_with[0]["job_id"],
            "service_id": negotiated_with[0]["service_id"],
            "user_id": str(task.user_id),
            "target_price": max_price,
            "current_offer": max_price,
            "round": 1,
            "last_msg_count": msg_count if negotiated_with else 0,
            "last_check_ts": datetime.now(timezone.utc).timestamp(),
        }

    return {
        "negotiated": len(negotiated_with) > 0,
        "negotiated_with": negotiated_with,
        "negotiation_state": neg_state,
        "message": "Opening offer sent. I'll follow up when the provider replies." if negotiated_with
                   else "No providers found to negotiate with.",
    }


# Leading command scaffolding to peel off ("post a job for me, I want someone
# who can …") — applied repeatedly until the string stabilises. Order-independent;
# each entry is matched at the very start after prior peels + punctuation are removed.
_TITLE_LEAD_PATTERNS = [
    r"please", r"kindly", r"can you", r"could you", r"would you", r"hey", r"hi",
    r"help me", r"for me",
    r"(?:post|create|add|make|put(?:\s+up)?|set\s+up|open|list|publish)(?:\s+up)?",
    r"a", r"an", r"the", r"new", r"another",
    r"job", r"service", r"posting", r"listing", r"gig", r"task", r"offer", r"ad",
    r"called", r"titled", r"named", r"for", r"to", r"that", r"which", r"where", r"of",
    r"i(?:'d)?\s+would\s+like", r"i'd\s+like", r"i\s+want\s+to\s+hire",
    r"i\s+want\s+to", r"i\s+need\s+to", r"i\s+want", r"i\s+need", r"i'm\s+looking\s+for",
    r"i\s+can", r"i\s+do", r"i\s+offer", r"i\s+am\s+a", r"i'm\s+a",
    r"looking\s+for", r"searching\s+for",
    r"someone", r"somebody", r"a\s+person", r"people", r"a\s+pro", r"a\s+professional",
    r"who\s+can", r"that\s+can", r"who", r"that", r"can",
    r"some", r"any",
]
_TITLE_LEAD_RE = re.compile(
    r"^(?:" + "|".join(_TITLE_LEAD_PATTERNS) + r")(?=\b|\s|$)", re.IGNORECASE
)
# Trailing price / budget talk ("…, 3k is what I will pay", "for 5000 naira", …).
_TITLE_TRAILING_PRICE_RE = re.compile(
    r"[\s,;:.\-]*(?:"
    r"(?:naira|₦)?\s*\d[\d,]*\s*k?\s*(?:naira|₦)?\s*(?:is\s+what\s+)?i(?:'ll|'d)?\s*(?:will\s+|would\s+)?(?:pay|offer|give|spend)"
    r"|(?:my\s+)?(?:i(?:'ll|'d)?\s*(?:will\s+|would\s+)?(?:pay|offer|give|spend)|budget(?:\s+is)?|for|under|at\s+most|no\s+more\s+than|max(?:imum)?|willing\s+to\s+pay|price(?:\s+is)?|rate(?:\s+is)?)\s*(?:of\s+)?(?:naira|₦)?\s*\d[\d,]*\s*k?"
    r"|(?:naira|₦)\s*\d[\d,]*"
    r").*$",
    re.IGNORECASE,
)


def _clean_posting_title(raw_text: str) -> str:
    """Distil a raw command into a concise title without an LLM.

    Peels leading command scaffolding ("post a job for me, I want …") and trailing
    price talk ("… 3k is what I'll pay"), then trims and capitalises. Used as the
    rule-based fallback when Groq is unavailable or fails — never returns the raw
    verb-prefixed sentence.
    """
    text = (raw_text or "").strip()

    # Peel leading scaffolding repeatedly until nothing more matches.
    for _ in range(20):
        text = text.lstrip(" ,.;:-–—\t")
        stripped = _TITLE_LEAD_RE.sub("", text, count=1)
        if stripped == text:
            break
        text = stripped

    # Drop trailing price / budget clause.
    text = _TITLE_TRAILING_PRICE_RE.sub("", text)
    text = text.strip(" ,.;:-–—\t")

    # If we peeled everything away there is nothing to name the listing with.
    # Falling back to the raw command is exactly how jobs ended up titled
    # "post a job" — better to return nothing and let the caller ask.
    if not text:
        return ""

    text = text[:60].strip()
    return (text[0].upper() + text[1:]) if text else ""


async def _groq_improve_posting(raw_text: str, kind: str) -> Dict[str, str]:
    """Use Groq to generate a professional title and description from raw user text.

    kind: "job" | "service"
    Returns {"title": ..., "description": ...} or falls back to simple formatting.
    """
    def _fallback() -> Dict[str, str]:
        title = _clean_posting_title(raw_text)
        if title and _looks_like_raw_command(title, raw_text):
            title = ""
        desc = f"{'Looking for' if kind == 'job' else 'Offering'}: {raw_text.strip()}"
        return {"title": title, "description": desc}

    # Gate on the full key list, not just the single GROQ_API_KEY, and route
    # through the fallback helper so multi-key rotation applies here too. This
    # used to bypass rotation entirely, so a deployment configured with only
    # GROQ_API_KEYS silently fell back to dumb title-casing.
    if not settings.groq_keys_list:
        return _fallback()

    system = (
        "You are a professional copywriter for Gigr, a Nigerian freelance marketplace. "
        "Given a raw, messy user command, produce a clean listing. "
        "Return ONLY a JSON object with exactly two fields: "
        '"title" and "description".\n'
        "TITLE RULES: a short, natural noun phrase naming the work itself (max 60 chars). "
        "STRIP all command scaffolding — words like 'post a job', 'create a service', "
        "'for me', 'I want', 'I need', 'someone who can', 'please'. "
        "STRIP any price, budget or pay amount. Fix obvious spelling. Use Title Case. "
        "NEVER echo the user's sentence verbatim.\n"
        "DESCRIPTION RULES: 2-3 sentences explaining the work and any stated requirements. "
        "Do not invent details not in the input. Do not put a price in the title.\n"
        "Examples (input -> title):\n"
        '"post a job, I want some pijama makers, 3k is what I will pay" -> "Pyjama Makers Needed"\n'
        '"Post a job for me, I want someone that can tie my shoelaces" -> "Shoelace Tying Assistant"\n'
        '"create a service, i can fix generators, my rate is 15000" -> "Generator Repair Service"'
    )
    user_prompt = (
        f"User wants to {'hire someone for this' if kind == 'job' else 'offer this service'}: "
        f"{raw_text}\nReturn the JSON now."
    )

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await _call_groq_with_fallback(
                client,
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Content-Type": "application/json"},
                json={
                    "model": settings.GROQ_MODEL,
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": user_prompt}],
                    "temperature": 0.3,
                    # Reasoning must not consume the whole budget: at 200 tokens
                    # with default effort this returned an empty generation and
                    # Groq answered 400 json_validate_failed.
                    "max_tokens": 700,
                    "reasoning_effort": "low",
                    "response_format": {"type": "json_object"},
                },
            )
            content = resp.json()["choices"][0]["message"]["content"] or ""
            parsed = _extract_json(content)
            title = str(parsed.get("title") or "").strip()[:60]

            # Guard against the small model echoing the command back: if the title
            # still looks like a raw instruction, distil it ourselves.
            if not title or _looks_like_raw_command(title, raw_text):
                title = _clean_posting_title(raw_text)

            desc = str(parsed.get("description") or "").strip() or _fallback()["description"]
            return {"title": title, "description": desc}
    except Exception as exc:
        logger.warning("[agent] Groq posting improvement failed (%s), using rule-based fallback", exc)
        return _fallback()


# Verbs/phrases that should never appear in a good title — their presence means the
# model just echoed the command instead of naming the work.
_RAW_COMMAND_MARKERS = re.compile(
    r"\b(?:post a job|post a service|create a|i want|i need|for me|someone who|"
    r"someone that|please|i will pay|i'll pay|my rate is|my budget)\b",
    re.IGNORECASE,
)


def _looks_like_raw_command(title: str, raw_text: str) -> bool:
    """True if ``title`` looks like the user's raw command rather than a clean name."""
    if _RAW_COMMAND_MARKERS.search(title):
        return True
    # Near-identical to the original input (ignoring case/whitespace) → not distilled.
    norm = lambda s: re.sub(r"\s+", " ", s.strip().lower())
    return norm(title) == norm(raw_text)


WAIT_FOR_REPLY_TIME = 10  # seconds to wait for a user's price before the AI picks one itself


async def _suggest_price(raw_title: str, kind: str) -> float:
    """Ask Groq for a fair price (naira); fall back to a sensible default."""
    default = 5000.0
    if not settings.groq_keys_list:
        return default
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await _call_groq_with_fallback(
                client,
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Content-Type": "application/json"},
                json={
                    "model": settings.GROQ_MODEL,
                    "messages": [
                        {"role": "system", "content": "You price informal services in Nigeria. Reply with ONLY a single integer amount in naira (no text, no symbols)."},
                        {"role": "user", "content": f"Fair {'budget' if kind == 'job' else 'rate'} in naira for: {raw_title}"},
                    ],
                    "temperature": 0.2, "max_tokens": 64, "reasoning_effort": "low",
                },
            )
            text = resp.json()["choices"][0]["message"]["content"]
            digits = re.sub(r"[^\d]", "", text)
            return float(digits) if digits else default
    except Exception:
        return default


async def _auto_price_fallback(task_id: str, kind: str, raw_title: str) -> None:
    """After WAIT_FOR_REPLY_TIME, if the user hasn't given a price, pick one and post."""
    await asyncio.sleep(WAIT_FOR_REPLY_TIME)
    async with async_session() as db:
        # Is the price dialog still open (i.e. the user hasn't answered)?
        logs_res = await db.execute(
            select(AgentLog).where(AgentLog.task_id == uuid.UUID(task_id))
            .order_by(AgentLog.created_at.desc()).limit(20)
        )
        dialog_log = None
        for lg in logs_res.scalars().all():
            if lg.data and (lg.data.get("action_payload") or {}).get("type") == "provide_price":
                dialog_log = lg
                break
        if not dialog_log:
            return  # user already responded (payload cleared) — nothing to do

        task_res = await db.execute(select(AgentTask).where(AgentTask.id == uuid.UUID(task_id)))
        task = task_res.scalar_one_or_none()
        if not task:
            return

        # Close the dialog so the user can't also submit a price now.
        new_data = dict(dialog_log.data)
        new_data.pop("action_payload", None)
        dialog_log.data = new_data

        price = await _suggest_price(raw_title, kind)
        logger.info("[agent] Task %s: no price in %ds — AI chose ₦%.0f", task_id, WAIT_FOR_REPLY_TIME, price)

        child = AgentTask(
            user_id=task.user_id,
            command_text=task.command_text,
            task_type="post_job" if kind == "job" else "post_service",
            params={"title": raw_title, "price": price},
            status="queued",
        )
        db.add(child)
        await _log(db, task.id, "info",
                   f"No budget given in {WAIT_FOR_REPLY_TIME}s — I'll go with ₦{price:,.0f} and post it for you.")
        await db.commit()
        try:
            await _ws_manager.notify_user(str(task.user_id), {"type": "agent_task_update", "task_id": task_id})
        except Exception:
            pass


# Category matching now lives in services/agent_tools.py so the tool registry
# and these handlers share one implementation. Aliased to the old private name
# to keep the existing call sites readable.
from ....services.agent_tools import pick_category as _pick_category  # noqa: E402


async def _handle_post_job(task: AgentTask, db: AsyncSession) -> Dict[str, Any]:
    """Create a new job posting on behalf of the user."""
    from ....crud.job import create_job
    from ....schemas.job import JobCreate

    params = task.params or {}
    raw_title: str = params.get("title", task.command_text)
    price: Optional[float] = params.get("price")

    # If no price given, ask the user before creating anything
    if not price:
        await _log(db, task.id, "info",
                   f"What's your budget for this job? Enter an amount in Naira.",
                   data={"action_payload": {
                       "type": "provide_price",
                       "raw_title": raw_title,
                       "kind": "job",
                       "options": [
                           {"label": "₦2,000", "action": "price:2000"},
                           {"label": "₦5,000", "action": "price:5000"},
                           {"label": "₦10,000", "action": "price:10000"},
                           {"label": "₦20,000", "action": "price:20000"},
                       ],
                   }})
        # If the user doesn't answer within WAIT_FOR_REPLY_TIME, the AI picks a
        # price itself and proceeds (see _auto_price_fallback).
        asyncio.create_task(_auto_price_fallback(str(task.id), "job", raw_title))
        return {"created": False, "waiting_for_price": True}

    await _log(db, task.id, "action", "Writing a professional job listing...")
    content = await _groq_improve_posting(raw_title, "job")
    title = (content.get("title") or "").strip()
    if not title:
        await _log(db, task.id, "info",
                   "I couldn't tell what the job is from that. Tell me what you "
                   'need done - for example: "post a job, I need someone to fix '
                   'my sink".')
        return {"created": False, "needs_details": True}
    desc = content["description"] + f"\n\nBudget: ₦{price:,.0f}"

    # Geo: inherit the poster's saved location so the job appears on the map and
    # in radius search. Left NULL when unknown — never (0, 0).
    poster = (await db.execute(select(User).where(User.id == task.user_id))).scalar_one_or_none()
    poster_lat = getattr(poster, "location_lat", None)
    poster_lng = getattr(poster, "location_lng", None)
    category = await _pick_category(db, f"{raw_title} {title}")

    await _log(db, task.id, "action", f"Posting job: '{title}' — ₦{price:,.0f}")
    try:
        job_in = JobCreate(
            title=title,
            description=desc,
            price=price,
            latitude=poster_lat,
            longitude=poster_lng,
            category_id=category.id if category else None,
        )
        job = await create_job(db, task.user_id, job_in)
        await db.commit()
        # Notify the user in-app that their job is live (call, if enabled, fires
        # separately from _maybe_trigger_call once this task completes).
        try:
            from ....crud.notification import create_notification
            await create_notification(
                db, task.user_id,
                title="Job posted",
                message=f"Your job '{title}' is live for ₦{price:,.0f}. Providers can now apply.",
                link="/dashboard/activity",
                type="job",
            )
            await db.commit()
        except Exception as ne:
            logger.warning("[agent] job-posted notification failed: %s", ne)
        await _log(db, task.id, "success",
                   f"Job **'{title}'** posted for ₦{price:,.0f}. "
                   f"Providers can now apply. [View in Activity](/dashboard/activity)")
        return {"created": True, "job_id": str(job.id), "title": title, "price": price}
    except Exception as exc:
        await db.rollback()
        await _log(db, task.id, "error", f"Failed to create job: {exc}")
        return {"created": False, "error": str(exc)}


async def _handle_post_service(task: AgentTask, db: AsyncSession) -> Dict[str, Any]:
    """Create a new service offering on behalf of the provider."""
    from ....crud.service import create_service
    from ....schemas.service import ServiceCreate
    from ....models.category import Category
    from ....crud.user import get_user_by_id as _get_user

    params = task.params or {}
    raw_title: str = params.get("title", task.command_text)
    price: Optional[float] = params.get("price")

    if not price:
        await _log(db, task.id, "info",
                   "What's your rate for this service? Enter an amount in Naira.",
                   data={"action_payload": {
                       "type": "provide_price",
                       "raw_title": raw_title,
                       "kind": "service",
                       "options": [
                           {"label": "₦3,000", "action": "price:3000"},
                           {"label": "₦5,000", "action": "price:5000"},
                           {"label": "₦10,000", "action": "price:10000"},
                           {"label": "₦20,000", "action": "price:20000"},
                       ],
                   }})
        asyncio.create_task(_auto_price_fallback(str(task.id), "service", raw_title))
        return {"created": False, "waiting_for_price": True}

    # Category: honour an explicit choice (params carry it when the user picked
    # one from the dialog), otherwise match the text against category names.
    # This used to be `select(Category).limit(1)` — the first row in the table —
    # so every AI-posted service landed in an arbitrary category.
    category = None
    chosen_id = params.get("category_id")
    if chosen_id:
        try:
            category = (await db.execute(
                select(Category).where(Category.id == uuid.UUID(str(chosen_id)))
            )).scalar_one_or_none()
        except (ValueError, AttributeError, TypeError):
            category = None
    if category is None:
        category = await _pick_category(db, raw_title)

    if category is None:
        all_categories = (await db.execute(select(Category).limit(10))).scalars().all()
        if not all_categories:
            await _log(db, task.id, "error",
                       "No service categories exist yet. Cannot create a service.")
            return {"created": False, "error": "Missing categories"}
        options = [
            {"label": c.name, "action": f"category:{c.id}"} for c in all_categories
        ]
        options.append({"label": "Cancel", "action": "cancel"})
        await _log(db, task.id, "info",
                   f"Which category fits '{raw_title}' best?",
                   data={"action_payload": {
                       "type": "select_category",
                       "raw_title": raw_title,
                       "price": price,
                       "kind": "service",
                       "options": options,
                   }})
        return {"created": False, "needs_category": True}

    await _log(db, task.id, "action", "Writing a professional service listing...")
    content = await _groq_improve_posting(raw_title, "service")
    title = (content.get("title") or "").strip()
    if not title:
        await _log(db, task.id, "info",
                   "I couldn't tell what the service is from that. Tell me what "
                   'you offer - for example: "create a service, I fix generators '
                   'for 15k".')
        return {"created": False, "needs_details": True}
    desc = content["description"]

    # Geo: ServiceListing.location is NOT NULL and every hyperlocal feature
    # depends on it. A missing saved location used to silently become (0, 0) —
    # Null Island, in the Gulf of Guinea — so the listing was invisible to
    # nearby clients and to the map. Refuse rather than write junk.
    user_res = await db.execute(select(User).where(User.id == task.user_id))
    poster = user_res.scalar_one_or_none()
    lat = getattr(poster, "location_lat", None)
    lng = getattr(poster, "location_lng", None)
    if lat is None or lng is None:
        await _log(db, task.id, "warning",
                   "I need your location before I can list a service — listings "
                   "without one can't be found by nearby clients. Set it in "
                   "[Profile](/dashboard/profile), then ask me again.")
        return {"created": False, "needs_location": True}

    await _log(db, task.id, "action", f"Posting service: '{title}' — ₦{price:,.0f}")
    try:
        service_in = ServiceCreate(
            category_id=category.id, title=title, description=desc,
            price=price, latitude=lat, longitude=lng,
        )
        service = await create_service(db, task.user_id, service_in)
        await db.commit()
        try:
            from ....crud.notification import create_notification
            await create_notification(
                db, task.user_id,
                title="Service listed",
                message=f"Your service '{title}' is live for ₦{price:,.0f}. Clients can now request it.",
                link="/dashboard/services",
                type="job",
            )
            await db.commit()
        except Exception as ne:
            logger.warning("[agent] service-listed notification failed: %s", ne)
        await _log(db, task.id, "success",
                   f"Service **'{title}'** listed for ₦{price:,.0f}. "
                   f"Clients can now find and request it. [View in Services](/dashboard/services)")
        return {"created": True, "service_id": str(service.id), "title": title, "price": price}
    except Exception as exc:
        await db.rollback()
        await _log(db, task.id, "error", f"Failed to create service: {exc}")
        return {"created": False, "error": str(exc)}


async def _handle_payment(task: AgentTask, db: AsyncSession) -> Dict[str, Any]:
    """Payment is deliberately NOT autonomous.

    This handler used to log "Autonomous payment completed successfully" without
    moving a single lamport, and the dialog variant confirmed "Payment approved
    (simulated)". Anyone reading their own activity feed would believe money had
    actually moved. Funding escrow stays a deliberate human action: the agent
    finds the job, explains exactly what is needed, and hands over a link. It
    never claims a success it cannot prove.
    """
    from ....models.job import Job

    params = task.params or {}
    job = None

    job_id_raw = params.get("job_id")
    if job_id_raw:
        try:
            job = (await db.execute(
                select(Job).where(
                    and_(
                        Job.id == uuid.UUID(str(job_id_raw)),
                        or_(Job.client_id == task.user_id, Job.provider_id == task.user_id),
                    )
                )
            )).scalar_one_or_none()
        except (ValueError, AttributeError, TypeError):
            job = None

    if job is None:
        # Best effort: their most recent job that is still waiting on funding.
        job = (await db.execute(
            select(Job)
            .where(
                or_(Job.client_id == task.user_id, Job.provider_id == task.user_id),
                Job.status.in_(["assigned", "requested"]),
            )
            .order_by(Job.created_at.desc())
            .limit(1)
        )).scalar_one_or_none()

    if job is None:
        await _log(db, task.id, "info",
                   "I couldn't find a job waiting on payment. Open "
                   "[My Jobs](/dashboard/jobs) and tell me which one.")
        return {"status": "no_job_found", "payment_moved": False}

    if str(job.client_id) != str(task.user_id):
        await _log(db, task.id, "info",
                   f"Funding “{job.title}” is the client's side of the deal — "
                   f"you'll be paid automatically when they release escrow.")
        return {"status": "not_payer", "payment_moved": False}

    await _log(
        db, task.id, "warning",
        f"I can't move money for you — funding escrow is the one thing I won't "
        f"do without your say-so. “{job.title}” (₦{float(job.price):,.0f}) is "
        f"ready to fund. [Open the job to fund it](/dashboard/jobs?jobId={job.id})",
        data={"action_payload": {
            "type": "approve_payment",
            "job_id": str(job.id),
            "options": [
                {"label": "Open job to fund", "action": f"open_job:{job.id}"},
                {"label": "Cancel", "action": "cancel"},
            ],
        }},
    )
    return {
        "status": "pending_user_approval",
        "payment_moved": False,
        "job_id": str(job.id),
    }


async def _handle_check_wallet(task: AgentTask, db: AsyncSession) -> Dict[str, Any]:
    """Retrieve and display user's on-chain wallet balance (SOL and USDC)."""
    user_res = await db.execute(select(User).where(User.id == task.user_id))
    current_user = user_res.scalar_one_or_none()
    if not current_user or not current_user.wallet_public_key:
        await _log(
            db,
            task.id,
            "warning",
            "No Solana wallet connected yet. You can connect or fund your wallet in your dashboard profile.",
            {"render_type": "wallet_card", "connected": False},
        )
        return {"connected": False, "sol_balance": 0.0, "usdc_balance": "0.00"}

    wallet_pubkey = current_user.wallet_public_key
    from .users import get_my_balance
    try:
        balance_res = await get_my_balance(current_user=current_user)
        sol_amount = float(balance_res.get("sol", 0.0))
        usdc_amount = str(balance_res.get("usdc", "0.00"))
        wallet_payload = {
            "render_type": "wallet_card",
            "connected": True,
            "wallet_public_key": wallet_pubkey,
            "sol_balance": sol_amount,
            "usdc_balance": usdc_amount,
        }
        await _log(
            db,
            task.id,
            "success",
            f"Wallet {wallet_pubkey[:4]}...{wallet_pubkey[-4:]}: {sol_amount:.4f} SOL | ${usdc_amount} USDC",
            wallet_payload,
        )
        return {
            "connected": True,
            "wallet_public_key": wallet_pubkey,
            "sol_balance": sol_amount,
            "usdc_balance": usdc_amount,
        }
    except Exception as balance_exc:
        logger.warning("[agent] wallet balance lookup failed: %s", balance_exc)
        wallet_payload = {
            "render_type": "wallet_card",
            "connected": True,
            "wallet_public_key": wallet_pubkey,
            "sol_balance": 0.0,
            "usdc_balance": "0.00",
            "warning": str(balance_exc),
        }
        await _log(
            db,
            task.id,
            "warning",
            f"Connected wallet {wallet_pubkey[:4]}...{wallet_pubkey[-4:]} (balance lookup currently unavailable)",
            wallet_payload,
        )
        return {"connected": True, "wallet_public_key": wallet_pubkey, "error": str(balance_exc)}


async def _resolve_conversation(db: AsyncSession, task: AgentTask):
    """The job a reply task belongs to: explicit id, else the newest live one."""
    from ....models.job import Job

    params = task.params or {}
    job_id_raw = params.get("job_id")
    if job_id_raw:
        try:
            job = (await db.execute(
                select(Job).where(
                    and_(
                        Job.id == uuid.UUID(str(job_id_raw)),
                        or_(Job.client_id == task.user_id, Job.provider_id == task.user_id),
                    )
                )
            )).scalar_one_or_none()
            if job:
                return job
        except (ValueError, AttributeError, TypeError):
            pass

    return (await db.execute(
        select(Job)
        .where(
            or_(Job.client_id == task.user_id, Job.provider_id == task.user_id),
            Job.status.notin_(["completed", "cancelled"]),
        )
        .order_by(Job.created_at.desc())
        .limit(1)
    )).scalar_one_or_none()


async def _handle_auto_reply(task: AgentTask, db: AsyncSession) -> Dict[str, Any]:
    """Draft AND send a reply into the right conversation.

    The previous version logged "Drafted and sent auto-reply" but never called
    create_message, so nothing was ever sent — the whole "low autonomy" level
    was a no-op that claimed success.
    """
    params = task.params or {}
    incoming = params.get("incoming") or task.command_text
    sender_name = params.get("sender_name") or "them"

    job = await _resolve_conversation(db, task)
    if not job:
        await _log(db, task.id, "info",
                   "I couldn't find a live conversation to reply in.")
        return {"status": "no_conversation", "sent": False}

    me = (await db.execute(select(User).where(User.id == task.user_id))).scalar_one_or_none()
    my_name = (me.display_name if me else None) or "your contact"

    await _log(db, task.id, "action", f"Drafting a reply to {sender_name}...")

    reply_content = (
        f"Hi! This is {my_name}'s Gigr assistant. They've seen your message about "
        f"“{job.title}” and will get back to you shortly."
    )

    if settings.groq_keys_list:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await _call_groq_with_fallback(
                    client,
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Content-Type": "application/json"},
                    json={
                        "model": settings.GROQ_MODEL,
                        "messages": [
                            {"role": "system", "content": (
                                "You are the assistant replying on behalf of a Gigr user "
                                "(a Nigerian services marketplace) who is away. Write a warm, "
                                "professional reply of 1-2 short sentences, specific to what "
                                "was asked. Never invent prices or commitments, and never "
                                "claim a payment or booking is done."
                            )},
                            {"role": "user", "content": (
                                f"Conversation about “{job.title}”.\n"
                                f"{sender_name} wrote: {incoming}"
                            )},
                        ],
                        "temperature": 0.4,
                        "max_tokens": 400,
                        "reasoning_effort": "low",
                    },
                )
                reply_content = response.json()["choices"][0]["message"]["content"].strip()
        except Exception as exc:
            await _log(db, task.id, "warning",
                       f"Couldn't reach the language model ({exc}); sent a short holding reply.")

    # Actually deliver it. is_agent=True stops the other party's agent from
    # auto-replying to this reply, so two agents can't ping-pong forever.
    try:
        sent = await create_message(db, job.id, task.user_id, reply_content, is_agent=True)
        try:
            await _ws_manager.broadcast_new_message(sent)
        except Exception:
            pass
    except Exception as exc:
        await _log(db, task.id, "error", f"Failed to send the reply: {exc}")
        return {"status": "error", "sent": False}

    await _log(db, task.id, "success", f"Replied to {sender_name}: “{reply_content}”")
    return {"status": "success", "sent": True, "reply": reply_content, "job_id": str(job.id)}


async def _handle_apply_job(task: AgentTask, db: AsyncSession) -> Dict[str, Any]:
    """Apply to a job on the user's behalf (autonomy level high and above).

    The proactive path used to queue `task_type="generic"` with the text
    "select_job:<id>". Because NLP parsing only runs for `pending` tasks, that
    fell through to the chat fallback and answered conversationally — it never
    applied to anything.
    """
    from ....models.job import Job
    from ....crud.application import (
        create_application,
        get_application_by_applicant_and_job,
    )
    from ....crud.notification import create_notification
    from ....schemas.application import ApplicationCreate
    from ....services.agent_policy import AUTONOMY_MARKER, resolve_policy

    params = task.params or {}
    job_id_raw = params.get("job_id") or params.get("query")
    if not job_id_raw:
        await _log(db, task.id, "error", "No job was specified to apply to.")
        return {"applied": False, "error": "missing job_id"}

    try:
        job_id = uuid.UUID(str(job_id_raw))
    except (ValueError, AttributeError, TypeError):
        await _log(db, task.id, "error", "That job id was malformed.")
        return {"applied": False, "error": "bad job_id"}

    job = (await db.execute(select(Job).where(Job.id == job_id))).scalar_one_or_none()
    if not job:
        await _log(db, task.id, "warning", "That job is no longer available.")
        return {"applied": False, "error": "job not found"}
    if str(job.client_id) == str(task.user_id):
        await _log(db, task.id, "info", "That's your own job — nothing to apply to.")
        return {"applied": False, "error": "own job"}
    if job.status != "open":
        await _log(db, task.id, "info",
                   f"“{job.title}” is no longer open ({job.status}).")
        return {"applied": False, "error": f"status={job.status}"}

    me = (await db.execute(select(User).where(User.id == task.user_id))).scalar_one_or_none()
    policy = resolve_policy(me.ai_settings if me else None)

    # An autonomous application must still be permitted by the current level.
    if params.get(AUTONOMY_MARKER) and not policy.can_auto_apply:
        await _log(db, task.id, "info",
                   f"Your autonomy level ({policy.level}) doesn't cover auto-applying, "
                   f"so I left “{job.title}” for you to review. [Open it]"
                   f"(/dashboard/jobs?jobId={job.id})")
        return {"applied": False, "error": "autonomy"}

    existing = await get_application_by_applicant_and_job(db, task.user_id, job_id)
    if existing:
        await _log(db, task.id, "info", f"You've already applied to “{job.title}”.")
        return {"applied": False, "error": "already applied"}

    await _log(db, task.id, "action", f"Applying to “{job.title}”...")

    message = (
        f"Hi! I'm interested in “{job.title}”. I've read the brief and I'm "
        f"available to start — happy to discuss the details. "
        f"(Applied by my Gigr assistant.)"
    )
    if settings.groq_keys_list:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await _call_groq_with_fallback(
                    client,
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Content-Type": "application/json"},
                    json={
                        "model": settings.GROQ_MODEL,
                        "messages": [
                            {"role": "system", "content": (
                                "Write a short, credible 2-sentence application message for a "
                                "Nigerian services marketplace. Invent no experience and "
                                "promise no price. End by noting a Gigr assistant applied."
                            )},
                            {"role": "user", "content": (
                                f"Job: {job.title}\nDescription: {job.description}\n"
                                f"Budget: ₦{float(job.price):,.0f}"
                            )},
                        ],
                        "temperature": 0.5,
                        "max_tokens": 400,
                        "reasoning_effort": "low",
                    },
                )
                message = resp.json()["choices"][0]["message"]["content"].strip()
        except Exception as exc:
            logger.warning("[agent] apply message generation failed: %s", exc)

    try:
        await create_application(
            db, task.user_id, ApplicationCreate(job_id=job.id, message=message)
        )
    except Exception as exc:
        await _log(db, task.id, "error", f"Couldn't apply to “{job.title}”: {exc}")
        return {"applied": False, "error": str(exc)}

    try:
        await create_notification(
            db,
            user_id=job.client_id,
            title="New applicant",
            message=f"{(me.display_name if me else 'Someone')} applied to “{job.title}”.",
            link=f"/dashboard/jobs?jobId={job.id}",
            type="application",
        )
        await db.commit()
    except Exception as exc:
        logger.warning("[agent] apply notification failed: %s", exc)

    await _log(db, task.id, "success",
               f"Applied to “{job.title}” for ₦{float(job.price):,.0f}. "
               f"I'll watch for a response. [View in Jobs](/dashboard/jobs)")
    return {"applied": True, "job_id": str(job.id), "title": job.title}


async def _handle_plan(task: AgentTask, db: AsyncSession) -> Dict[str, Any]:
    """Execute a multi-step task plan by generating and enqueuing child tasks."""
    params = task.params or {}
    steps = params.get("steps") or []

    if settings.FEATURE_AGENT_REASONING_VISIBLE:
        await _log(
            db, task.id, "think",
            "Deconstructing compound command into actionable execution steps..."
        )

    if not steps:
        raw_text = task.command_text
        parts = [
            p.strip()
            for p in re.split(r"\b(?:and\s+then|then|and)\b|;", raw_text, flags=re.IGNORECASE)
            if p.strip()
        ]
        if len(parts) > 1:
            for part in parts:
                steps.append({
                    "task_type": "generic",
                    "command_text": part,
                    "params": {"query": part},
                })
        else:
            steps.append({
                "task_type": "generic",
                "command_text": raw_text,
                "params": {"query": raw_text},
            })

    child_tasks: List[Dict[str, Any]] = []
    child_task_ids: List[str] = []

    await _log(
        db, task.id, "action",
        f"Planning {len(steps)} subtask(s) for execution..."
    )

    for idx, step in enumerate(steps):
        step_type = step.get("task_type", "generic")
        step_params = step.get("params") or {}
        step_cmd = (
            step.get("command_text")
            or step_params.get("query")
            or step_params.get("title")
            or f"Subtask {idx + 1}"
        )
        child = AgentTask(
            user_id=task.user_id,
            command_text=step_cmd,
            task_type=step_type if step_type != "plan" else "generic",
            params={
                **step_params,
                "parent_task_id": str(task.id),
                "step_index": idx + 1,
                "total_steps": len(steps),
            },
            status="queued",
        )
        db.add(child)
        await db.flush()
        child_task_ids.append(str(child.id))
        child_tasks.append({
            "task_id": str(child.id),
            "step_index": idx + 1,
            "task_type": child.task_type,
            "title": step_cmd,
        })

    await _log(
        db, task.id, "success",
        f"[PLAN] Created {len(child_task_ids)} subtask(s). Running autonomously.",
        data={
            "render_type": "plan_summary",
            "child_tasks": child_tasks,
            "child_task_ids": child_task_ids,
        },
    )

    return {
        "planned": True,
        "count": len(child_task_ids),
        "child_task_ids": child_task_ids,
        "child_tasks": child_tasks,
    }


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3: Agent loop — background asyncio coroutine
# ═══════════════════════════════════════════════════════════════════════════════

_running_tasks: set[str] = set()  # tracks currently executing task IDs


def _build_call_message(
    display_name: str,
    task_type: str,
    task_status: str,
    command_text: str,
    result: Optional[Dict[str, Any]],
    params: Optional[Dict[str, Any]],
) -> tuple[Optional[str], Optional[str]]:
    """Map a finished task to a (trigger, spoken_message) pair, or (None, None) to skip."""
    result = result or {}
    params = params or {}
    name = display_name or "there"
    query = params.get("query") or ""

    # Failures fire the "task_failed" trigger regardless of type.
    if task_status == "failed":
        return "task_failed", (
            f"Hi {name}, this is your Gigr assistant. I wasn't able to finish your request"
            f"{f' to {command_text}' if command_text else ''}. Please open the app to take a look."
        )

    if task_status != "completed":
        return None, None

    if task_type == "find_service" and result.get("found") and result.get("count"):
        count = result["count"]
        return "item_found", (
            f"Good news {name}, this is your Gigr assistant. I found {count} "
            f"{'option' if count == 1 else 'options'}{f' for {query}' if query else ''}. "
            "Open the app to review and book."
        )

    if task_type == "negotiate":
        if result.get("negotiated") or result.get("found_within_budget"):
            return "negotiation_done", (
                f"Hi {name}, this is your Gigr assistant. I've finished negotiating"
                f"{f' for {query}' if query else ''}. Open the app to see the result and confirm."
            )
        return None, None

    if task_type == "post_job" and result.get("created"):
        title = result.get("title") or "your job"
        return "job_posted", (
            f"Hi {name}, this is your Gigr assistant. Your job {title} is now posted on Gigr. "
            "I'll let you know when providers respond."
        )

    return None, None


async def _maybe_trigger_call(
    *,
    task_id: str,
    user_id,
    task_type: str,
    task_status: str,
    command_text: str,
    result: Optional[Dict[str, Any]],
    params: Optional[Dict[str, Any]],
) -> None:
    """Decide whether to phone the user about a finished task, and do it if so."""
    from ....services import twilio_client

    if not settings.twilio_enabled:
        return

    async with async_session() as db:
        user_res = await db.execute(select(User).where(User.id == user_id))
        user = user_res.scalar_one_or_none()
        if not user:
            return

        trigger, message = _build_call_message(
            user.display_name, task_type, task_status, command_text, result, params
        )
        if not trigger or not message:
            return

        logger.info("[agent] Task %s → call trigger '%s' (phone=%s, enabled=%s)",
                    task_id, trigger, bool(user.phone_number),
                    (user.ai_settings or {}).get("call", {}).get("enabled"))
        call = await twilio_client.maybe_call_user(
            db, user, trigger=trigger, message=message, task_id=uuid.UUID(task_id)
        )
        await db.commit()
        if call is not None:
            logger.info("[agent] Placed %s call to %s for task %s (status=%s)",
                        trigger, call.to_number, task_id, call.status)
            try:
                await _log(db, uuid.UUID(task_id), "action",
                           f"Called you ({call.to_number}) about this task.",
                           data={"call_status": call.status, "trigger": trigger})
                await db.commit()
            except Exception:
                pass


async def _execute_task(task_id: str):
    """Execute a single agent task in its own DB session."""
    _running_tasks.add(task_id)
    try:
        async with async_session() as db:
            # Atomically claim the task: flip queued → running in a single UPDATE
            # and COMMIT immediately. This makes the "running" state visible to
            # every other loop iteration/worker at once, so the same task can
            # never be picked up and executed twice.
            from sqlalchemy import update as sa_update
            claim = await db.execute(
                sa_update(AgentTask)
                .where(and_(AgentTask.id == uuid.UUID(task_id), AgentTask.status == "queued"))
                .values(status="running", updated_at=datetime.now(timezone.utc))
                .returning(AgentTask.id)
            )
            if claim.first() is None:
                # Already claimed by someone else (or not queued) — nothing to do.
                logger.info("[agent] Task %s already claimed, skipping", task_id)
                return
            await db.commit()

            # Load the freshly-claimed task for processing.
            result = await db.execute(select(AgentTask).where(AgentTask.id == uuid.UUID(task_id)))
            task = result.scalar_one_or_none()
            if not task:
                return

            logger.info("[agent] ▶ Executing task %s (type=%s): %r",
                        task_id, task.task_type, task.command_text)

            # Wrap entire task execution in try-except so an unhandled exception
            # never leaves a task indefinitely stuck in 'running'.
            try:
                # Load user's memory context and inject into params
                memory = await _load_memory(db, task.user_id)
                if memory and task.params is not None:
                    task.params = {**task.params, "_memory": memory}
                elif memory:
                    task.params = {"_memory": memory}

                await _log(db, task.id, "info", f"Agent started working on: \"{task.command_text}\"")

                session_id = (task.params or {}).get("session_id")
                session_history = get_session_history(session_id) if session_id else None

                # --- NLP Parsing moved to background loop to avoid blocking the UI ---
                if task.task_type == "pending":
                    if settings.FEATURE_AGENT_REASONING_VISIBLE:
                        context_hint = f" ({len(session_history)} turns of history)" if session_history else ""
                        await _log(db, task.id, "think", f"Analyzing command and session context{context_hint}...")
                    await _log(db, task.id, "info", "Parsing command intent...")
                    parsed = await parse_command(task.command_text, memory=memory, session_history=session_history)
                    task.task_type = parsed.get("task_type", "generic")

                    # Merge original params (like ai_negotiate_enabled, session_id) with parsed params
                    orig_params = task.params or {}
                    new_params = parsed.get("params", {})
                    task.params = {**orig_params, **new_params}

                    logger.info("[agent] Task %s parsed as type=%s", task_id, task.task_type)
                    await _log(db, task.id, "info", f"Interpreted as: {parsed.get('response', task.task_type)}")
                    await db.flush()

                # Dispatch to the right handler
                if task.task_type == "find_service":
                    task.result = await _handle_find_service(task, db)
                elif task.task_type == "find_job":
                    task.result = await _handle_find_job(task, db)
                elif task.task_type == "post_job":
                    task.result = await _handle_post_job(task, db)
                elif task.task_type == "post_service":
                    task.result = await _handle_post_service(task, db)
                elif task.task_type == "negotiate":
                    task.result = await _handle_negotiate(task, db)
                elif task.task_type == "pay":
                    task.result = await _handle_payment(task, db)
                elif task.task_type in ("auto_reply", "reply_message"):
                    # `auto_reply` is scheduled by the autonomy policy;
                    # `reply_message` comes from a spoken "reply to this message".
                    task.result = await _handle_auto_reply(task, db)
                elif task.task_type == "apply_job":
                    task.result = await _handle_apply_job(task, db)
                elif task.task_type == "proactive_hunt":
                    task.result = await _handle_proactive_hunt(task, db)
                elif task.task_type == "plan":
                    task.result = await _handle_plan(task, db)
                elif task.task_type == "check_wallet":
                    task.result = await _handle_check_wallet(task, db)
                elif task.task_type == "navigate":
                    page = (task.params or {}).get("page", "")
                    page_routes = {
                        "home": "/dashboard", "jobs": "/dashboard/jobs",
                        "services": "/dashboard/services", "messages": "/dashboard/messages",
                        "activity": "/dashboard/activity", "disputes": "/dashboard/disputes",
                        "profile": "/dashboard/profile",
                    }
                    route = page_routes.get(page, f"/dashboard/{page}")
                    await _log(db, task.id, "success", f"Navigating to {page}...",
                               data={"navigate_to": route})
                    task.result = {"page": page, "navigate_to": route}
                else:  # generic — free-form command: run the tool-calling agent
                    from ....services import agent_tools

                    agent_user = (await db.execute(
                        select(User).where(User.id == task.user_id)
                    )).scalar_one_or_none()

                    agentic: Dict[str, Any] = {"reply": None, "steps": [], "used_tools": []}
                    if agent_user is not None:
                        agentic = await agent_tools.run_agent_loop(
                            db, agent_user, task.command_text
                        )

                    # Surface every tool the agent chose, so the activity feed
                    # shows exactly what was looked up or changed.
                    for step in agentic.get("steps") or []:
                        if step.get("tool") == "navigate" and step.get("route"):
                            await _log(db, task.id, "action",
                                       f"→ {step['summary']}",
                                       data={"navigate_to": step["route"]})
                            continue
                        await _log(
                            db, task.id,
                            "action" if step.get("ok") else "warning",
                            f"{step.get('summary') or step.get('tool')}",
                            data={"tool": step.get("tool"), "args": step.get("args")},
                        )

                    reply = agentic.get("reply") or (
                        "I'm Gigidy, your Gigr AI assistant! I can find services, "
                        "post jobs, apply to work, and take you anywhere in the app. "
                        "Try: 'find a plumber near me for 5k'."
                    )
                    await _log(db, task.id, "info", reply)
                    task.result = {
                        "message": reply,
                        "used_tools": agentic.get("used_tools") or [],
                    }

                task.status = "completed"
                task.completed_at = datetime.now(timezone.utc)
                logger.info("[agent] Task %s completed (type=%s)", task_id, task.task_type)
                # Avoid redundant "Task completed" log if the specific handler already logged its outcome or a dialog
                if task.task_type not in ["find_service", "find_job", "post_job", "post_service"]:
                    await _log(db, task.id, "success", "Task completed")
            except Exception as exc:
                logger.error("[agent] Task %s failed: %s", task_id, exc, exc_info=True)
                task.status = "failed"
                task.result = {"error": str(exc)}
                task.completed_at = datetime.now(timezone.utc)
                try:
                    await _log(db, task.id, "error", f"Task failed: {exc}")
                except Exception:
                    pass

            task.updated_at = datetime.now(timezone.utc)

            # Record multi-turn session turn
            if session_id:
                reply_text = ""
                if task.result and isinstance(task.result, dict):
                    reply_text = str(task.result.get("message") or task.result.get("response") or "")
                if not reply_text and task.logs:
                    reply_text = task.logs[-1].message
                record_session_turn(session_id, task.command_text, reply_text or f"Completed {task.task_type}")

            # Update memory from task results
            if task.status == "completed" and task.result:
                mem_updates: Dict[str, Any] = {}
                r = task.result
                if task.task_type in ("find_service", "negotiate") and task.params:
                    q = task.params.get("query")
                    if q:
                        mem_updates["last_search"] = q
                    if task.params.get("max_price"):
                        mem_updates["usual_price_job"] = task.params["max_price"]
                if task.task_type == "post_job" and r.get("price"):
                    mem_updates["usual_price_job"] = r["price"]
                if task.task_type == "post_service" and r.get("price"):
                    mem_updates["usual_price_service"] = r["price"]
                if r.get("job_id"):
                    mem_updates["last_active_job_id"] = str(r["job_id"])
                if r.get("service_id"):
                    mem_updates["last_active_service_id"] = str(r["service_id"])
                if mem_updates:
                    await _save_memory(db, task.user_id, mem_updates)

            await db.commit()

            # Push WS notification so frontend refreshes immediately (no poll lag)
            try:
                await _ws_manager.notify_user(str(task.user_id), {
                    "type": "agent_task_update",
                    "task_id": task_id,
                    "status": task.status,
                })
            except Exception:
                pass  # WS push is best-effort

            # Optionally call the user on the phone about this result (best-effort).
            try:
                await _maybe_trigger_call(
                    task_id=task_id,
                    user_id=task.user_id,
                    task_type=task.task_type,
                    task_status=task.status,
                    command_text=task.command_text,
                    result=task.result,
                    params=task.params,
                )
            except Exception as exc:  # never let calling break the task
                logger.warning("[agent] call trigger skipped for task %s: %s", task_id, exc)

    except Exception as exc:
        logger.error("[agent] Unexpected error in task %s: %s", task_id, exc, exc_info=True)
    finally:
        _running_tasks.discard(task_id)


async def _check_negotiation_reply(task_id: str):
    """Check if the provider replied to our negotiation message and continue if so."""
    async with async_session() as db:
        result = await db.execute(
            select(AgentTask)
            .options(selectinload(AgentTask.logs))
            .where(AgentTask.id == uuid.UUID(task_id))
        )
        task = result.scalar_one_or_none()
        if not task:
            return

        ns = (task.result or {}).get("negotiation_state", {})
        if not ns.get("active"):
            return

        job_id = ns.get("job_id")
        user_id = ns.get("user_id") or str(task.user_id)
        last_msg_count = ns.get("last_msg_count", 0)
        round_num = ns.get("round", 1)
        target_price = ns.get("target_price")
        current_offer = ns.get("current_offer")

        # Update last check timestamp
        new_result = dict(task.result or {})
        new_result["negotiation_state"] = {**ns, "last_check_ts": datetime.now(timezone.utc).timestamp()}
        task.result = new_result

        if not job_id:
            await db.commit()
            return

        # Fetch messages in the job
        from ....models.message import Message
        msgs_result = await db.execute(
            select(Message)
            .where(Message.job_id == uuid.UUID(job_id))
            .order_by(Message.created_at.asc())
        )
        all_msgs = msgs_result.scalars().all()
        await db.commit()

        # Only new messages since last check that aren't from us
        new_msgs = [m for m in all_msgs[last_msg_count:] if str(m.sender_id) != str(task.user_id)]
        if not new_msgs:
            return

        # There's a reply — call Groq to analyse it
        provider_reply = new_msgs[-1].content
        if not settings.groq_keys_list or round_num >= 3:
            # Max rounds reached, or no LLM available — log the outcome and close
            # the negotiation instead of leaving it dangling. (This used to be a
            # stray debug `print`, which spammy-logged in production.)
            if round_num >= 3:
                logger.info("[agent] negotiation hit the 3-round cap for task %s", task.id)
            else:
                logger.info("[agent] negotiation closed: no Groq keys configured")
            # Max rounds reached or no Groq — log outcome and close
            async with async_session() as db2:
                t = (await db2.execute(select(AgentTask).where(AgentTask.id == task.id))).scalar_one_or_none()
                if t:
                    nr = dict(t.result or {})
                    nr["negotiation_state"] = {**ns, "active": False}
                    t.result = nr
                    if round_num >= 3:
                        await _log(db2, t.id, "warning", f"Negotiation reached max rounds. Provider's last message: \"{provider_reply[:120]}\"")
                    await db2.commit()
                    await _ws_manager.notify_user(str(t.user_id), {"type": "agent_task_update", "task_id": task_id})
            return

        # Ask Groq: should we accept this price or counter?
        system_prompt = (
            "You are a negotiation assistant on Gigr, a Nigerian freelance marketplace. "
            "Analyse the provider's reply to our price offer. "
            "Return ONLY JSON: {\"decision\": \"accept\" | \"counter\" | \"walk\", "
            "\"counter_price\": <number or null>, \"reply\": \"<1-2 sentence message to send>\"}. "
            f"Our target price is ₦{target_price:,.0f}. Our current offer was ₦{current_offer:,.0f}."
        )
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await _call_groq_with_fallback(
                    client,
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Content-Type": "application/json"},
                    json={
                        "model": settings.GROQ_MODEL,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": f"Provider replied: \"{provider_reply}\""},
                        ],
                        "temperature": 0.3, "max_tokens": 500, "reasoning_effort": "low",
                    }
                )
                raw = resp.json()["choices"][0]["message"]["content"] or ""
                decision_data = _extract_json(raw)
        except Exception as exc:
            logger.warning("[agent] Negotiation Groq call failed: %s", exc)
            return

        decision = decision_data.get("decision", "walk")
        reply_msg = decision_data.get("reply", "")
        counter_price = decision_data.get("counter_price")

        async with async_session() as db2:
            t = (await db2.execute(select(AgentTask).where(AgentTask.id == task.id))).scalar_one_or_none()
            if not t:
                return

            if decision == "accept":
                await _log(db2, t.id, "success",
                           f"Deal accepted! Provider agreed. Final price: ₦{current_offer:,.0f}. "
                           f"Check your [Activity](/dashboard/activity) to fund the escrow.")
                new_ns = {**ns, "active": False, "final_price": current_offer}
            elif decision == "counter" and counter_price:
                # Send counter-offer
                from ....models.message import Message as Msg
                counter_msg = Msg(
                    job_id=uuid.UUID(job_id),
                    sender_id=task.user_id,
                    content=reply_msg or f"Thank you for your reply. Could we do ₦{counter_price:,.0f}?",
                )
                db2.add(counter_msg)
                await db2.flush()
                from ....services.ws_manager import manager as _m
                await _m.broadcast_new_message(counter_msg)
                await _log(db2, t.id, "action",
                           f"Counter-offered ₦{counter_price:,.0f} (round {round_num + 1}/3)")
                new_ns = {**ns, "active": True, "round": round_num + 1,
                          "current_offer": counter_price, "last_msg_count": len(all_msgs) + 1,
                          "last_check_ts": datetime.now(timezone.utc).timestamp()}
            else:
                await _log(db2, t.id, "warning", "Negotiation ended — could not reach an agreement.")
                new_ns = {**ns, "active": False}

            new_r = dict(t.result or {})
            new_r["negotiation_state"] = new_ns
            t.result = new_r
            await db2.commit()
            await _ws_manager.notify_user(str(t.user_id), {"type": "agent_task_update", "task_id": task_id})


async def _handle_proactive_hunt(task: AgentTask, db: AsyncSession) -> Dict[str, Any]:
    """Proactively source providers for one of the user's unmet jobs.

    This is what "total" autonomy promises. Nothing in the codebase ever ran a
    hunt before, so the top level behaved identically to "high".

    The agent finds candidates and presents them with a one-tap request action
    rather than messaging providers by itself: opening a conversation with a real
    person stays the user's call, which is also why the level caps how often this
    runs.
    """
    from ....models.job import Job
    from ....crud.service import get_services_nearby

    params = task.params or {}
    job_id_raw = params.get("job_id")
    if not job_id_raw:
        await _log(db, task.id, "warning", "Nothing to hunt for.")
        return {"found": False}
    try:
        job_id = uuid.UUID(str(job_id_raw))
    except (ValueError, AttributeError, TypeError):
        await _log(db, task.id, "warning", "That job id was malformed.")
        return {"found": False}

    job = (await db.execute(select(Job).where(Job.id == job_id))).scalar_one_or_none()
    if not job or str(job.client_id) != str(task.user_id):
        return {"found": False}
    if job.status != "open" or job.provider_id:
        return {"found": False, "reason": "job already covered"}

    has_location = job.latitude is not None and job.longitude is not None
    await _log(db, task.id, "action",
               f"Hunting for providers for “{job.title}”"
               + (" near you" if has_location else "") + "...")

    candidates = []
    if has_location:
        # Wider than the browse default so a first hunt actually finds someone.
        candidates = await get_services_nearby(
            db, float(job.latitude), float(job.longitude), radius_km=25, limit=8
        )
    if not candidates:
        candidates = await search_services_by_text(db, job.title, limit=8)
    candidates = [s for s in candidates if str(s.provider_id) != str(task.user_id)][:5]

    if not candidates:
        await _log(db, task.id, "warning",
                   f"I couldn't find any providers for “{job.title}” yet — I'll keep looking.")
        return {"found": False}

    service_cards = [
        {
            "id": str(s.id),
            "title": s.title,
            "price": float(s.price),
            "description": s.description or "",
            "distance_km": getattr(s, "distance_km", None),
        }
        for s in candidates
    ]
    options = [
        {
            "label": f"Request {s['title']} — ₦{s['price']:,.0f}"
            + (f" · {s['distance_km']} km" if s.get("distance_km") is not None else ""),
            "action": f"select_service:{s['id']}",
        }
        for s in service_cards
    ]
    options.append({"label": "Not now", "action": "cancel"})

    await _log(
        db, task.id, "success",
        f"I found {len(candidates)} provider(s) who could take “{job.title}”. "
        f"Tap one and I'll open the request:",
        data={
            "render_type": "service_cards",
            "services": service_cards,
            "action_payload": {
                "type": "select_service",
                "query": job.title,
                "options": options,
            },
        },
    )
    return {"found": True, "count": len(candidates), "job_id": str(job.id)}


async def proactive_loop():
    """Background hunt for users who opted into "total" autonomy.

    Runs on its own cadence, counts against each user's daily guardrail budget,
    only considers jobs that are genuinely stale (open, unassigned, no
    applicants, older than the configured threshold), and never hunts the same
    job twice inside the guardrail window.
    """
    import asyncio
    from datetime import timedelta
    from ....models.job import Job
    from ....crud.application import get_applications_for_job
    from ....services.agent_policy import (
        AUTONOMY_MARKER,
        resolve_policy,
        within_guardrails,
    )

    logger.info(
        "[proactive] Hunt loop started (every %ds)",
        settings.AI_AGENT_PROACTIVE_INTERVAL_SECONDS,
    )

    while True:
        await asyncio.sleep(settings.AI_AGENT_PROACTIVE_INTERVAL_SECONDS)

        if not settings.AI_AGENT_ENABLED or not settings.AI_AGENT_PROACTIVE_ENABLED:
            continue

        try:
            async with async_session() as db:
                now = datetime.now(timezone.utc)
                cutoff = now - timedelta(
                    minutes=settings.AI_AGENT_PROACTIVE_MIN_JOB_AGE_MINUTES
                )

                hunters = (await db.execute(
                    select(User).where(
                        User.ai_settings["autonomyLevel"].astext == "total"
                    )
                )).scalars().all()

                queued = 0
                for user in hunters:
                    policy = resolve_policy(user.ai_settings)
                    if not policy.can_proactive_hunt:
                        continue
                    if not await within_guardrails(
                        db, user.id, feature="proactive_hunt", cap=policy.daily_action_cap
                    ):
                        continue

                    stale_jobs = (await db.execute(
                        select(Job)
                        .where(
                            Job.client_id == user.id,
                            Job.status == "open",
                            Job.provider_id.is_(None),
                            Job.created_at < cutoff,
                        )
                        .order_by(Job.created_at.asc())
                        .limit(2)
                    )).scalars().all()

                    for job in stale_jobs:
                        if await get_applications_for_job(db, job.id):
                            continue  # someone already bit
                        recent_hunt = (await db.execute(
                            select(AgentTask)
                            .where(
                                AgentTask.user_id == user.id,
                                AgentTask.params["job_id"].astext == str(job.id),
                                AgentTask.params[AUTONOMY_MARKER].astext == "proactive_hunt",
                                AgentTask.created_at >= now - timedelta(hours=24),
                            )
                            .limit(1)
                        )).scalar_one_or_none()
                        if recent_hunt:
                            continue  # already hunted today

                        db.add(AgentTask(
                            user_id=user.id,
                            command_text=f"Hunt for providers for “{job.title}”",
                            task_type="proactive_hunt",
                            params={
                                "job_id": str(job.id),
                                AUTONOMY_MARKER: "proactive_hunt",
                            },
                            status="queued",
                        ))
                        queued += 1

                if queued:
                    await db.commit()
                    logger.info("[proactive] queued %d hunt task(s)", queued)
        except Exception as exc:
            logger.error("[proactive] loop error: %s", exc, exc_info=True)


async def agent_loop():
    """Background loop that polls for queued tasks and executes them.

    Started on FastAPI startup. Respects AI_AGENT_ENABLED and
    AI_AGENT_MAX_CONCURRENT_TASKS settings.
    """
    logger.info(
        "[agent] Loop started (poll every %ds, max %d concurrent)",
        settings.AI_AGENT_POLL_INTERVAL_SECONDS,
        settings.AI_AGENT_MAX_CONCURRENT_TASKS,
    )

    while True:
        await asyncio.sleep(settings.AI_AGENT_POLL_INTERVAL_SECONDS)

        if not settings.AI_AGENT_ENABLED:
            continue

        try:
            async with async_session() as db:
                # Check for timed-out running tasks
                from sqlalchemy import update as sa_update
                from datetime import timedelta
                timeout_cutoff = datetime.now(timezone.utc) - timedelta(seconds=settings.AI_AGENT_TASK_TIMEOUT_SECONDS)
                await db.execute(
                    sa_update(AgentTask)
                    .where(and_(AgentTask.status == "running", AgentTask.updated_at < timeout_cutoff))
                    .values(status="failed", result={"error": "Task timed out"}, updated_at=datetime.now(timezone.utc))
                )
                await db.commit()

                # ── Negotiation reply check ──────────────────────────────────
                # Find completed negotiate tasks that have active negotiation state
                # and check whether the provider has replied since our last message.
                neg_result = await db.execute(
                    select(AgentTask)
                    .where(
                        and_(
                            AgentTask.status == "completed",
                            AgentTask.task_type == "negotiate",
                        )
                    )
                    .order_by(AgentTask.updated_at.desc())
                    .limit(20)
                )
                neg_tasks = neg_result.scalars().all()
                for nt in neg_tasks:
                    ns = (nt.result or {}).get("negotiation_state")
                    if not ns or not ns.get("active"):
                        continue
                    # Only check once every ~60 s to avoid hammering the DB
                    last_check = ns.get("last_check_ts", 0)
                    now_ts = datetime.now(timezone.utc).timestamp()
                    if now_ts - last_check < 55:
                        continue
                    asyncio.create_task(_check_negotiation_reply(str(nt.id)))

                # Fetch queued tasks up to concurrency limit
                slots = settings.AI_AGENT_MAX_CONCURRENT_TASKS - len(_running_tasks)
                if slots <= 0:
                    continue

                queued = await db.execute(
                    select(AgentTask)
                    .where(AgentTask.status == "queued")
                    .order_by(AgentTask.created_at.asc())
                    .limit(slots)
                )
                tasks_to_run = queued.scalars().all()

            # Dispatch each task as a separate asyncio task
            if tasks_to_run:
                logger.info("[agent] Dispatching %d queued task(s): %s",
                            len(tasks_to_run), [str(t.id) for t in tasks_to_run])
            for t in tasks_to_run:
                if str(t.id) not in _running_tasks:
                    asyncio.create_task(_execute_task(str(t.id)))

        except Exception as exc:
            logger.error("[agent] Loop error: %s", exc, exc_info=True)


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 4: API routes
# ═══════════════════════════════════════════════════════════════════════════════

# ── Legacy endpoint (backwards compat) ────────────────────────────────────────

class InterpretCommandRequest(BaseModel):
    text: str


class InterpretCommandResponse(BaseModel):
    action: Optional[str] = None
    params: dict = {}
    response: Optional[str] = None


@router.post("/ai/interpret-command", response_model=InterpretCommandResponse)
async def interpret_command_legacy(request: InterpretCommandRequest):
    """Legacy endpoint kept for backwards compatibility with the old voice assistant hook."""
    if not request.text.strip():
        raise HTTPException(status_code=400, detail="Empty command text")
    parsed = await parse_command(request.text)
    return InterpretCommandResponse(
        action=parsed.get("task_type"),
        params=parsed.get("params", {}),
        response=parsed.get("response"),
    )


# ── New agent endpoints ────────────────────────────────────────────────────────

@router.post("/ai/command", response_model=AgentTaskOut, status_code=status.HTTP_201_CREATED)
async def submit_command(
    request: AgentCommandRequest,
    current_user: User = Depends(require_ai_enabled),
    db: AsyncSession = Depends(get_db),
):
    """Submit a voice or text command. Creates a background agent task."""
    text = request.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Empty command text")

    # Parse intent later in the background loop to avoid blocking the UI
    task_type = "pending"
    params = {}
    if request.session_id:
        params["session_id"] = request.session_id

    # For negotiate tasks, inject the user's negotiate preference
    if "ai_negotiate_enabled" in request.dict(exclude_unset=True):
        params["ai_negotiate_enabled"] = request.dict()["ai_negotiate_enabled"]

    # Create the task record
    task = AgentTask(
        user_id=current_user.id,
        command_text=text,
        task_type=task_type,
        params=params,
        status="queued",
    )
    db.add(task)
    await db.flush()

    # Immediate log entry
    initial_log = AgentLog(
        task_id=task.id,
        level="info",
        message=f"Command received: \"{text}\"",
    )
    db.add(initial_log)
    await db.commit()
    await db.refresh(task)

    # Immediately trigger execution in background so user doesn't wait on polling loop
    asyncio.create_task(_execute_task(str(task.id)))

    # Return with logs
    result = await db.execute(
        select(AgentTask)
        .options(selectinload(AgentTask.logs))
        .where(AgentTask.id == task.id)
    )
    return result.scalar_one()


@router.get("/ai/tasks", response_model=List[AgentTaskOut])
async def list_tasks(
    current_user: User = Depends(require_ai_enabled),
    db: AsyncSession = Depends(get_db),
    limit: int = 50,
):
    """List all agent tasks for the current user, most recent first."""
    result = await db.execute(
        select(AgentTask)
        .options(selectinload(AgentTask.logs))
        .where(AgentTask.user_id == current_user.id)
        .order_by(AgentTask.created_at.desc())
        .limit(limit)
    )
    return result.scalars().all()


@router.get("/ai/tasks/{task_id}", response_model=AgentTaskOut)
async def get_task(
    task_id: uuid.UUID,
    current_user: User = Depends(require_ai_enabled),
    db: AsyncSession = Depends(get_db),
):
    """Get a single task with all its logs."""
    result = await db.execute(
        select(AgentTask)
        .options(selectinload(AgentTask.logs))
        .where(and_(AgentTask.id == task_id, AgentTask.user_id == current_user.id))
    )
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("/ai/tasks/{task_id}/stream")
async def stream_task_logs(
    task_id: uuid.UUID,
    current_user: User = Depends(require_ai_enabled),
    db: AsyncSession = Depends(get_db),
):
    """Server-Sent Events endpoint streaming live task logs to the client."""
    import json
    from fastapi.responses import StreamingResponse

    # Verify task ownership
    result = await db.execute(
        select(AgentTask).where(
            and_(AgentTask.id == task_id, AgentTask.user_id == current_user.id)
        )
    )
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    async def event_generator():
        sent_log_ids: set[str] = set()
        iterations = 0
        max_iterations = 120

        while iterations < max_iterations:
            iterations += 1
            async with async_session() as session:
                log_result = await session.execute(
                    select(AgentLog)
                    .where(AgentLog.task_id == task_id)
                    .order_by(AgentLog.created_at.asc())
                )
                logs = log_result.scalars().all()
                for log_entry in logs:
                    if str(log_entry.id) not in sent_log_ids:
                        sent_log_ids.add(str(log_entry.id))
                        payload = {
                            "id": str(log_entry.id),
                            "task_id": str(log_entry.task_id),
                            "level": log_entry.level,
                            "message": log_entry.message,
                            "data": log_entry.data,
                            "created_at": (
                                log_entry.created_at.isoformat()
                                if log_entry.created_at
                                else None
                            ),
                        }
                        yield f"data: {json.dumps(payload)}\n\n"

                task_status_row = (await session.execute(
                    select(AgentTask.status).where(AgentTask.id == task_id)
                )).scalar_one_or_none()
                if task_status_row in ("completed", "failed"):
                    yield f"event: done\ndata: {{\"status\": \"{task_status_row}\"}}\n\n"
                    break

            await asyncio.sleep(1.0)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.delete("/ai/tasks", status_code=status.HTTP_204_NO_CONTENT)
async def clear_all_tasks(
    current_user: User = Depends(require_ai_enabled),
    db: AsyncSession = Depends(get_db),
):
    """Delete all tasks and logs for the current user."""
    from sqlalchemy import delete
    await db.execute(delete(AgentLog).where(AgentLog.task_id.in_(
        select(AgentTask.id).where(AgentTask.user_id == current_user.id)
    )))
    await db.execute(delete(AgentTask).where(AgentTask.user_id == current_user.id))
    await db.commit()


@router.delete("/ai/tasks/{task_id}", status_code=status.HTTP_204_NO_CONTENT)
async def cancel_task(
    task_id: uuid.UUID,
    current_user: User = Depends(require_ai_enabled),
    db: AsyncSession = Depends(get_db),
):
    """Cancel a queued or running task."""
    result = await db.execute(
        select(AgentTask).where(and_(AgentTask.id == task_id, AgentTask.user_id == current_user.id))
    )
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status not in ("queued", "running"):
        raise HTTPException(status_code=400, detail=f"Cannot cancel a task with status '{task.status}'")

    task.status = "cancelled"
    task.completed_at = datetime.now(timezone.utc)
    task.updated_at = datetime.now(timezone.utc)
    cancel_log = AgentLog(task_id=task.id, level="warning", message="Task cancelled by user")
    db.add(cancel_log)
    await db.commit()

class AgentDialogResponse(BaseModel):
    action: str  # "confirm", "cancel", "select_service:<uuid>", "post_job"
    extra: dict = {}

@router.post("/ai/tasks/{task_id}/respond")
async def respond_to_dialog(
    task_id: uuid.UUID,
    response: AgentDialogResponse,
    current_user: User = Depends(require_ai_enabled),
    db: AsyncSession = Depends(get_db),
):
    """Handle a user's response to an interactive dialog."""
    result = await db.execute(
        select(AgentTask).where(and_(AgentTask.id == task_id, AgentTask.user_id == current_user.id))
    )
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    log_result = await db.execute(
        select(AgentLog)
        .where(AgentLog.task_id == task.id)
        .order_by(AgentLog.created_at.desc())
        .limit(20)  # Check up to last 20 logs
    )
    recent_logs = log_result.scalars().all()

    last_log_with_dialog = None
    for log in recent_logs:
        if log.data and "action_payload" in log.data:
            last_log_with_dialog = log
            break

    action = response.action

    # Actions that name their own target don't need a pending payload. This is
    # what made the "Apply" button on job cards fail with 400 "No pending
    # dialog": find_job renders Apply buttons straight from its result cards,
    # but this endpoint demanded an action_payload the handler never wrote.
    self_describing = action.startswith(("select_service:", "select_job:", "open_job:"))
    if not last_log_with_dialog and not self_describing:
        raise HTTPException(status_code=400, detail="No pending dialog for this task")

    payload = (last_log_with_dialog.data.get("action_payload") if last_log_with_dialog else None) or {}

    if last_log_with_dialog is not None:
        # Clear the action_payload so the dialog goes away on next poll
        new_data = dict(last_log_with_dialog.data)
        new_data.pop("action_payload", None)
        last_log_with_dialog.data = new_data

    if action == "cancel":
        await _log(db, task.id, "info", "Okay, action cancelled.")
        await db.commit()
        return {"status": "cancelled"}

    # ── Open a job in the UI (used by the honest payment prompt) ─────────────
    if action.startswith("open_job:"):
        job_ref = action.split(":", 1)[1]
        route = f"/dashboard/jobs?jobId={job_ref}"
        await _log(db, task.id, "info", "Opening the job for you...",
                   data={"navigate_to": route})
        await db.commit()
        return {"status": "ok", "navigate_to": route}

    # ── Select a specific service ────────────────────────────────────────────
    if action.startswith("select_service:"):
        service_id_str = action.split(":", 1)[1]
        try:
            service_id = uuid.UUID(service_id_str)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid service ID")

        svc_result = await db.execute(select(ServiceListing).where(ServiceListing.id == service_id))
        service = svc_result.scalar_one_or_none()
        if not service:
            await _log(db, task.id, "error", "Service no longer available.")
            await db.commit()
            return {"status": "error", "detail": "Service not found"}

        await _log(db, task.id, "action", f"Requesting service: {service.title}...")
        request_msg = await _request_service(db, task, service)
        await _log(db, task.id, "success", request_msg)
        await db.commit()
        return {"status": "ok"}

    # ── Select a specific job (Apply) ─────────────────────────────────────────
    if action.startswith("select_job:"):
        job_id_str = action.split(":", 1)[1]
        try:
            job_id = uuid.UUID(job_id_str)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid job ID")

        from ....crud.job import get_job_by_id
        from ....crud.application import create_application, get_application_by_applicant_and_job
        from ....schemas.application import ApplicationCreate

        job = await get_job_by_id(db, job_id)
        if not job:
            await _log(db, task.id, "error", "Job no longer available.")
            await db.commit()
            return {"status": "error", "detail": "Job not found"}

        existing_app = await get_application_by_applicant_and_job(db, current_user.id, job_id)
        if existing_app:
            await _log(db, task.id, "warning", "You have already applied to this job.")
            await db.commit()
            return {"status": "ok"}

        await _log(db, task.id, "action", f"Applying for job: {job.title}...")
        try:
            app_in = ApplicationCreate(
                job_id=job.id,
                message="Applied via AI Assistant.",
            )
            await create_application(db, current_user.id, app_in)
            await _log(db, task.id, "success", f"Successfully applied for the job. Please check your [Jobs](/dashboard/jobs) or [Activity](/dashboard/activity) page to see if you have been assigned.")
            await db.commit()
        except Exception as exc:
            await _log(db, task.id, "error", f"Failed to apply for job: {exc}")
            await db.commit()
        return {"status": "ok"}

    # ── Price provided for post_job / post_service dialog ────────────────────
    if action.startswith("price:") and payload.get("type") == "provide_price":
        try:
            chosen_price = float(action.split(":", 1)[1])
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid price value")
        raw_title = payload.get("raw_title", task.command_text)
        kind = payload.get("kind", "job")
        new_task = AgentTask(
            user_id=current_user.id,
            command_text=task.command_text,
            task_type="post_job" if kind == "job" else "post_service",
            params={"title": raw_title, "price": chosen_price},
            status="queued",
        )
        db.add(new_task)
        await _log(db, task.id, "success",
                   f"Got it — ₦{chosen_price:,.0f}. Creating your {'job' if kind == 'job' else 'service'}...")
        await db.commit()
        return {"status": "ok", "new_task_id": str(new_task.id)}

    # ── Category chosen for an AI-created service ────────────────────────────
    if action.startswith("category:") and payload.get("type") == "select_category":
        try:
            category_id = uuid.UUID(action.split(":", 1)[1])
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid category ID")
        raw_title = payload.get("raw_title", task.command_text)
        kind = payload.get("kind", "service")
        new_task = AgentTask(
            user_id=current_user.id,
            command_text=task.command_text,
            task_type="post_job" if kind == "job" else "post_service",
            params={
                "title": raw_title,
                "price": payload.get("price"),
                "category_id": str(category_id),
            },
            status="queued",
        )
        db.add(new_task)
        await _log(db, task.id, "success",
                   "Got it — finishing the listing in that category...")
        await db.commit()
        return {"status": "ok", "new_task_id": str(new_task.id)}

    # ── Post a job fallback ──────────────────────────────────────────────────
    if action in ("confirm", "post_job") and payload.get("type") in ("create_job_fallback", "select_service"):
        query = payload.get("query") or payload.get("title", "Service needed")
        price = payload.get("price") or payload.get("max_price")
        new_task = AgentTask(
            user_id=current_user.id,
            command_text=f"Post a job: {query}",
            task_type="post_job",
            params={"title": query, "price": price},
            status="queued"
        )
        db.add(new_task)
        await _log(db, task.id, "success", f"Got it! Posting a job for '{query}'...")
        await db.commit()
        return {"status": "ok", "new_task_id": str(new_task.id)}

    if payload.get("type") == "approve_payment" and action == "confirm":
        # Never claim money moved. The agent prepares, the human transfers.
        job_ref = payload.get("job_id")
        link = f"/dashboard/jobs?jobId={job_ref}" if job_ref else "/dashboard/jobs"
        await _log(db, task.id, "info",
                   f"Approved — but the transfer itself is yours to make. "
                   f"[Open the job and tap Fund Escrow]({link}).")
        await db.commit()
        return {"status": "ok", "payment_moved": False}

    await db.commit()
    return {"status": "ok"}


@router.get("/ai/logs", response_model=List[AgentLogOut])
async def recent_logs(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = 100,
):
    """Get recent log entries across all tasks for the current user."""
    result = await db.execute(
        select(AgentLog)
        .join(AgentTask, AgentLog.task_id == AgentTask.id)
        .where(AgentTask.user_id == current_user.id)
        .order_by(AgentLog.created_at.desc())
        .limit(limit)
    )
    return result.scalars().all()


@router.get("/ai/settings")
async def get_ai_settings(
    current_user: User = Depends(get_current_user),
):
    """AI engine status + the caller's own agent settings.

    Returning ``ai_settings`` here is what lets the client hydrate from the
    server. The frontend used to persist settings to localStorage and push them
    up, but never read them back — so a new browser showed "off" while the
    backend enforced whatever was actually stored.
    """
    groq_on = bool(settings.groq_keys_list)
    ai_settings = dict(current_user.ai_settings or {})
    return {
        "groq_enabled": groq_on,
        "groq_model": settings.GROQ_MODEL if groq_on else None,
        "agent_enabled": settings.AI_AGENT_ENABLED,
        "poll_interval_seconds": settings.AI_AGENT_POLL_INTERVAL_SECONDS,
        "nlp_engine": "groq" if groq_on else "rule-based",
        "ai_settings": ai_settings,
        "autonomy_level": ai_settings.get("autonomyLevel", "off"),
    }


@router.patch("/ai/memory")
async def update_memory_endpoint(
    memory_patch: Dict[str, Any],
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update agent memory keys."""
    await _save_memory(db, current_user.id, memory_patch)
    await db.commit()
    updated = await _load_memory(db, current_user.id)
    return {"status": "ok", "memory": updated}


@router.delete("/ai/memory/{key}")
async def forget_memory_key(
    key: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Forget a specific agent memory key."""
    from sqlalchemy import update as sa_update
    result = await db.execute(select(User).where(User.id == current_user.id))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    settings_now = dict(user.ai_settings or {})
    memory = dict(settings_now.get("memory", {}))
    if key in memory:
        del memory[key]
    settings_now["memory"] = memory
    await db.execute(sa_update(User).where(User.id == current_user.id).values(ai_settings=settings_now))
    await db.commit()
    return {"status": "ok", "forgotten": key, "memory": memory}