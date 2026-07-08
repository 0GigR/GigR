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

router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 1: NLP — parse natural language into structured intent
# ═══════════════════════════════════════════════════════════════════════════════

# System prompt for Groq Llama-3 NLP
_GROQ_SYSTEM_PROMPT = """You are a command parser for Gigr, a freelance services marketplace.
Extract the user's intent from their message and return ONLY a JSON object with these fields:

{
  "task_type": "find_service" | "find_job" | "post_service" | "post_job" | "negotiate" | "navigate" | "pay" | "reply_message" | "generic",
  "params": {
    "query": "search query string",
    "max_price": 5000,          // number in naira, null if not specified
    "min_price": 5000,          // number in naira
    "title": "title",           // for post_job or post_service
    "price": 5000,              // number in naira
    "job_id": "optional id",    // for pay
    "page": "jobs|services|messages|activity|disputes|profile|home"  // for navigate
  },
  "response": "brief confirmation message to show user"
}

Rules:
- "post_job" = user wants to HIRE SOMEONE / create a task
- "post_service" = user wants to WORK / offer their skills
- "find_service" = user wants to look for someone to hire
- "find_job" = user is a freelancer looking for open jobs to apply to
- "negotiate" = user wants to find AND negotiate price (e.g. "find someone for 5k and negotiate")
- Numbers: convert "5k" → 5000, "10k" → 10000, "₦5,000" → 5000, "five thousand" → 5000
- If unclear, default to "search" with whatever query you can extract
- Return ONLY the JSON, no markdown, no explanation"""


async def _parse_command_groq(text: str) -> Optional[Dict[str, Any]]:
    """Call Groq Llama-3 to parse the command into structured intent.
    Returns None if Groq is not configured or the call fails."""
    if not settings.GROQ_API_KEY:
        return None

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={
                    "Authorization": f"Bearer {settings.GROQ_API_KEY}",
                    "Content-Type": "application/json",
                },
                json={
                    "model": settings.GROQ_MODEL,
                    "messages": [
                        {"role": "system", "content": _GROQ_SYSTEM_PROMPT},
                        {"role": "user", "content": text},
                    ],
                    "temperature": 0.1,
                    "max_tokens": 300,
                },
            )
            response.raise_for_status()
            content = response.json()["choices"][0]["message"]["content"].strip()
            # Strip markdown code fences if Groq wrapped in ```json ... ```
            content = re.sub(r"```(?:json)?\s*", "", content).strip("` ")
            return json.loads(content)
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
            "params": {"query": query or text, "min_price": price},
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
            "params": {"query": query or text, "max_price": price},
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


async def parse_command(text: str, memory: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Parse a natural language command into structured intent.

    Tries Groq Llama-3 first (better understanding). Falls back to
    rule-based regex parser if Groq key is missing or the call fails.
    """
    # Enrich text with memory context so Groq can fill in omitted details
    enriched = text
    if memory:
        hints = []
        if memory.get("last_search"):
            hints.append(f"user previously searched for: {memory['last_search']}")
        if memory.get("usual_price_job"):
            hints.append(f"user's typical job budget: ₦{memory['usual_price_job']:,.0f}")
        if memory.get("usual_price_service"):
            hints.append(f"user's typical service rate: ₦{memory['usual_price_service']:,.0f}")
        if hints:
            enriched = f"{text} [context: {'; '.join(hints)}]"

    groq_result = await _parse_command_groq(enriched)
    if groq_result and groq_result.get("task_type"):
        return groq_result
    return _parse_command_rules(text)


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
        job.status = "assigned"
        await db.flush()

        msg_content = f"Hi! My AI assistant matched me with your service '{service.title}'. I would like to proceed."
        if task.params.get("max_price"):
            msg_content += f" My budget is ₦{task.params['max_price']:,.0f}."

        msg = await create_message(db, job.id, task.user_id, msg_content)
        await db.flush()

        from ....api.v1.endpoints.messages import manager
        await manager.broadcast_new_message(msg)

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

    await _log(db, task.id, "action", f"Searching for services: '{query}'{location_note}" + (f" (max ₦{max_price:,.0f})" if max_price else ""))

    services = await search_services_by_text(db, query, limit=50)
    services = [s for s in services if s.provider_id != task.user_id]

    # Proximity filter: prefer results within 20 km, fall back to all if too few
    if user_lat and user_lng:
        nearby = [
            s for s in services
            if s.latitude and s.longitude
            and _haversine_km(user_lat, user_lng, float(s.latitude), float(s.longitude)) <= 20
        ]
        services = nearby if len(nearby) >= 3 else services

    if max_price:
        filtered = [s for s in services if float(s.price) <= max_price]
    else:
        filtered = services

    if filtered:
        service_cards = [
            {"id": str(s.id), "title": s.title, "price": float(s.price), "description": s.description or ""}
            for s in filtered[:5]
        ]
        dialog_options = [
            {"label": f"{s['title']} — ₦{s['price']:,.0f}", "action": f"select_service:{s['id']}"}
            for s in service_cards
        ]
        dialog_options.append({"label": "Post a job instead", "action": "post_job"})
        dialog_options.append({"label": "Cancel", "action": "cancel"})

        await _log(db, task.id, "success",
                   f"Found {len(filtered)} matching service(s). Which would you like me to request?",
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
        return {"found": True, "count": len(filtered), "services": service_cards}
    else:
        closest = sorted(services, key=lambda s: float(s.price))[:3]
        if closest:
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
    if user_lat and user_lng:
        with_distance = []
        for j in jobs:
            jlat, jlng = j.latitude, j.longitude
            if jlat is not None and jlng is not None:
                d = _haversine_km(user_lat, user_lng, float(jlat), float(jlng))
                with_distance.append((d, j))
        nearby = sorted([(d, j) for d, j in with_distance if d <= 25], key=lambda x: x[0])
        if len(nearby) >= 3:
            jobs = [j for _, j in nearby]
        # else: keep the full text-matched list (location_note already reflects intent)

    if min_price:
        filtered = [j for j in jobs if float(j.price) >= min_price]
    else:
        filtered = jobs

    if filtered:
        job_cards = [
            {"id": str(j.id), "title": j.title, "price": float(j.price), "description": getattr(j, 'description', '') or ""}
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
    ai_negotiate = (user.ai_settings or {}).get("aiNegotiateEnabled", False)
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


async def _groq_improve_posting(raw_text: str, kind: str) -> Dict[str, str]:
    """Use Groq to generate a professional title and description from raw user text.

    kind: "job" | "service"
    Returns {"title": ..., "description": ...} or falls back to simple formatting.
    """
    if not settings.GROQ_API_KEY:
        # Rule-based fallback: capitalise and trim
        title = raw_text.strip().rstrip(".,!?")[:60]
        title = title[0].upper() + title[1:] if title else raw_text[:60]
        desc = f"{'Looking for' if kind == 'job' else 'Offering'}: {raw_text.strip()}"
        return {"title": title, "description": desc}

    system = (
        "You are a professional copywriter for Gigr, a Nigerian freelance marketplace. "
        "Given a raw user command, produce a clean job listing. "
        "Return ONLY a JSON object with exactly two fields: "
        '"title" (max 60 chars, professional, imperative, no filler) and '
        '"description" (2-3 sentences explaining the work and any stated requirements). '
        "Do not add prices to the title. Do not invent details not in the input."
    )
    user_prompt = (
        f"User wants to {'hire someone for' if kind == 'job' else 'offer a service:'}: {raw_text}"
    )

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {settings.GROQ_API_KEY}", "Content-Type": "application/json"},
                json={
                    "model": settings.GROQ_MODEL,
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": user_prompt}],
                    "temperature": 0.4,
                    "max_tokens": 200,
                },
            )
            resp.raise_for_status()
            content = resp.json()["choices"][0]["message"]["content"].strip()
            content = re.sub(r"```(?:json)?\s*", "", content).strip("` ")
            parsed = json.loads(content)
            return {
                "title": str(parsed.get("title", raw_text))[:60],
                "description": str(parsed.get("description", raw_text)),
            }
    except Exception as exc:
        logger.warning("[agent] Groq posting improvement failed (%s), using raw text", exc)
        title = raw_text.strip()[:60]
        return {"title": title, "description": f"{'Looking for' if kind == 'job' else 'Offering'}: {raw_text.strip()}"}


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
        return {"created": False, "waiting_for_price": True}

    await _log(db, task.id, "action", "Writing a professional job listing...")
    content = await _groq_improve_posting(raw_title, "job")
    title = content["title"]
    desc = content["description"] + f"\n\nBudget: ₦{price:,.0f}"

    await _log(db, task.id, "action", f"Posting job: '{title}' — ₦{price:,.0f}")
    try:
        job_in = JobCreate(title=title, description=desc, price=price)
        job = await create_job(db, task.user_id, job_in)
        await db.commit()
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
    from ....models.service import Category
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
        return {"created": False, "waiting_for_price": True}

    # Try to match a category from the title
    cat_result = await db.execute(select(Category).limit(1))
    category = cat_result.scalar_one_or_none()
    if not category:
        await _log(db, task.id, "error", "No service categories in the system. Cannot create service.")
        return {"created": False, "error": "Missing categories"}

    await _log(db, task.id, "action", "Writing a professional service listing...")
    content = await _groq_improve_posting(raw_title, "service")
    title = content["title"]
    desc = content["description"]

    # Use user's stored location if available
    user_res = await db.execute(select(User).where(User.id == task.user_id))
    poster = user_res.scalar_one_or_none()
    lat = poster.location_lat or 0.0 if poster else 0.0
    lng = poster.location_lng or 0.0 if poster else 0.0

    await _log(db, task.id, "action", f"Posting service: '{title}' — ₦{price:,.0f}")
    try:
        service_in = ServiceCreate(
            category_id=category.id, title=title, description=desc,
            price=price, latitude=lat, longitude=lng,
        )
        service = await create_service(db, task.user_id, service_in)
        await db.commit()
        await _log(db, task.id, "success",
                   f"Service **'{title}'** listed for ₦{price:,.0f}. "
                   f"Clients can now find and request it. [View in Services](/dashboard/services)")
        return {"created": True, "service_id": str(service.id), "title": title, "price": price}
    except Exception as exc:
        await db.rollback()
        await _log(db, task.id, "error", f"Failed to create service: {exc}")
        return {"created": False, "error": str(exc)}


async def _handle_payment(task: AgentTask, db: AsyncSession) -> Dict[str, Any]:
    """Handle AI payments using either autonomous placeholder logic or interactive dialog."""
    params = task.params or {}
    
    # 1. Check if AI Autonomous Payment is enabled via env var
    if settings.AI_AUTONOMOUS_PAYMENT_ENABLED:
        await _log(db, task.id, "action", "Initiating autonomous payment via Solana smart contract...")
        # In a real production system, this would call get_platform_payer() and submit a transaction.
        await _log(db, task.id, "success", "Autonomous payment completed successfully.")
        return {"payment_method": "autonomous", "status": "success"}
    
    # 2. Fallback to interactive dialog
    await _log(db, task.id, "action", "Preparing payment for approval...")
    
    dialog_payload = {
        "type": "approve_payment",
        "title": "Payment Request",
    }
    
    await _log(db, task.id, "warning", 
               "I cannot securely sign Solana transactions on your behalf. "
               "I have prepared the payment. Please approve it to continue.", 
               data={"action_payload": dialog_payload})
               
    return {"payment_method": "manual_dialog_requested", "status": "pending_user_approval"}

async def _handle_reply_message(task: AgentTask, db: AsyncSession) -> Dict[str, Any]:
    """Handle AI auto-replies to incoming messages."""
    await _log(db, task.id, "action", "Analyzing incoming message...")
    
    reply_content = "Hi! I am the AI assistant. My human is currently away but they have received your message and will get back to you soon."
    
    if settings.GROQ_API_KEY:
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {settings.GROQ_API_KEY}",
                        "Content-Type": "application/json",
                    },
                    json={
                        "model": settings.GROQ_MODEL,
                        "messages": [
                            {"role": "system", "content": "You are a helpful AI assistant for a user on Gigr, a freelance marketplace. The user is away. Draft a polite auto-reply to the following message. Keep it to 1-2 sentences."},
                            {"role": "user", "content": task.command_text},
                        ],
                        "temperature": 0.5,
                        "max_tokens": 150,
                    },
                )
                response.raise_for_status()
                reply_content = response.json()["choices"][0]["message"]["content"].strip()
        except Exception as exc:
            await _log(db, task.id, "warning", f"Failed to generate dynamic AI reply ({exc}), using fallback.")
            
    await _log(db, task.id, "success", f"Drafted and sent auto-reply: '{reply_content}'")
    
    return {"status": "success", "reply": reply_content}

# ═══════════════════════════════════════════════════════════════════════════════
# SECTION 3: Agent loop — background asyncio coroutine
# ═══════════════════════════════════════════════════════════════════════════════

_running_tasks: set[str] = set()  # tracks currently executing task IDs


async def _execute_task(task_id: str):
    """Execute a single agent task in its own DB session."""
    _running_tasks.add(task_id)
    try:
        async with async_session() as db:
            # Re-fetch task inside this session
            result = await db.execute(select(AgentTask).where(AgentTask.id == uuid.UUID(task_id)))
            task = result.scalar_one_or_none()
            if not task or task.status != "queued":
                return

            # Mark as running
            task.status = "running"
            task.updated_at = datetime.now(timezone.utc)
            await db.flush()

            # Load user's memory context and inject into params
            memory = await _load_memory(db, task.user_id)
            if memory and task.params is not None:
                task.params = {**task.params, "_memory": memory}
            elif memory:
                task.params = {"_memory": memory}

            await _log(db, task.id, "info", f"Agent started working on: \"{task.command_text}\"")
            
            # --- NLP Parsing moved to background loop to avoid blocking the UI ---
            if task.task_type == "pending":
                await _log(db, task.id, "info", "Parsing command intent...")
                parsed = await parse_command(task.command_text, memory=memory)
                task.task_type = parsed.get("task_type", "generic")
                
                # Merge original params (like ai_negotiate_enabled) with parsed params
                orig_params = task.params or {}
                new_params = parsed.get("params", {})
                task.params = {**orig_params, **new_params}
                
                await _log(db, task.id, "info", f"Interpreted as: {parsed.get('response', task.task_type)}")
                await db.flush()

            # Dispatch to the right handler
            try:
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
                elif task.task_type == "reply_message":
                    task.result = await _handle_reply_message(task, db)
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
                else:  # generic
                    # Try to get a real conversational response from Groq
                    groq_reply = None
                    if settings.GROQ_API_KEY:
                        try:
                            async with httpx.AsyncClient(timeout=10.0) as client:
                                resp = await client.post(
                                    "https://api.groq.com/openai/v1/chat/completions",
                                    headers={"Authorization": f"Bearer {settings.GROQ_API_KEY}"},
                                    json={
                                        "model": settings.GROQ_MODEL,
                                        "messages": [
                                            {"role": "system", "content": "You are a friendly AI assistant built into Gigr, a local freelance marketplace app. Answer the user's question helpfully and concisely in 1-3 sentences. If the question is about using Gigr, help them. Otherwise, stay on topic."},
                                            {"role": "user", "content": task.command_text},
                                        ],
                                        "temperature": 0.7, "max_tokens": 200,
                                    }
                                )
                                resp.raise_for_status()
                                groq_reply = resp.json()["choices"][0]["message"]["content"].strip()
                        except Exception:
                            pass
                    reply = groq_reply or "I'm Gigidy, your Gigr AI assistant! I can help you find services, post jobs, or navigate the app. Try: 'find a plumber for 5k'."
                    await _log(db, task.id, "info", reply)
                    task.result = {"message": reply}

                task.status = "completed"
                task.completed_at = datetime.now(timezone.utc)
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
        if not settings.GROQ_API_KEY or round_num >= 3:
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
                resp = await client.post(
                    "https://api.groq.com/openai/v1/chat/completions",
                    headers={"Authorization": f"Bearer {settings.GROQ_API_KEY}", "Content-Type": "application/json"},
                    json={
                        "model": settings.GROQ_MODEL,
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": f"Provider replied: \"{provider_reply}\""},
                        ],
                        "temperature": 0.3, "max_tokens": 150,
                    }
                )
                resp.raise_for_status()
                raw = resp.json()["choices"][0]["message"]["content"].strip()
                raw = re.sub(r"```(?:json)?\s*", "", raw).strip("` ")
                decision_data = json.loads(raw)
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
        select(AgentLog).where(AgentLog.task_id == task.id).order_by(AgentLog.created_at.desc()).limit(1)
    )
    last_log = log_result.scalar_one_or_none()

    if not last_log or not last_log.data or "action_payload" not in last_log.data:
        raise HTTPException(status_code=400, detail="No pending dialog for this task")

    payload = last_log.data["action_payload"]

    # Clear the action_payload so the dialog goes away on next poll
    new_data = dict(last_log.data)
    new_data.pop("action_payload", None)
    last_log.data = new_data

    action = response.action

    if action == "cancel":
        await _log(db, task.id, "info", "Okay, action cancelled.")
        await db.commit()
        return {"status": "cancelled"}

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
        await _log(db, task.id, "success", "Payment approved (simulated).")
        await db.commit()
        return {"status": "ok"}

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
    """Return the current AI engine status and user-facing config info."""
    return {
        "groq_enabled": bool(settings.GROQ_API_KEY),
        "groq_model": settings.GROQ_MODEL if settings.GROQ_API_KEY else None,
        "agent_enabled": settings.AI_AGENT_ENABLED,
        "poll_interval_seconds": settings.AI_AGENT_POLL_INTERVAL_SECONDS,
        "nlp_engine": "groq" if settings.GROQ_API_KEY else "rule-based",
    }