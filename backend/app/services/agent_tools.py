"""Tool-calling registry for the Gigr agent.

The agent used to be a one-shot intent parser: a command was classified into a
single bucket and handled once, so anything requiring more than one step
("find a plumber near me under 10k and check my open jobs") was impossible.

This module gives the model real, typed tools backed by the actual database, a
grounded snapshot of who the user is, and a bounded loop that can chain calls —
so the agent can look things up, act, and then explain what it did.

Every tool returns a compact, JSON-serialisable dict. Results are deliberately
trimmed: they go straight back into the model's context window.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Awaitable, Callable, Dict, List, Optional
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.category import Category
from ..models.job import Job
from ..models.service import ServiceListing
from ..models.user import User
from . import groq_client

logger = logging.getLogger(__name__)

# Print only the assistant's own words here; the model may add more.
MAX_STEPS = 4
_MAX_RESULTS = 5
_DESC_CHARS = 180


# ── Small helpers ─────────────────────────────────────────────────────────────

def norm_words(text: str) -> set[str]:
    """Lowercase word set with light suffix stripping ("Plumber" → "plumb")."""
    words: set[str] = set()
    for word in re.findall(r"[a-z]{3,}", (text or "").lower()):
        for suffix in ("ings", "ing", "ers", "er", "es", "s"):
            if len(word) > len(suffix) + 2 and word.endswith(suffix):
                word = word[: -len(suffix)]
                break
        words.add(word)
    return words


async def pick_category(db: AsyncSession, text: str) -> Optional[Category]:
    """Best-effort category match. Returns None when nothing matches confidently.

    Shared with the posting handlers in ``endpoints/ai.py`` — this used to be
    ``select(Category).limit(1)`` (literally the first row in the table), so
    every AI-created listing landed in an arbitrary category.
    """
    categories = (await db.execute(select(Category))).scalars().all()
    if not categories:
        return None

    haystack = (text or "").lower()
    text_words = norm_words(text)
    best: Optional[Category] = None
    best_score = 0.0
    for category in categories:
        name = (category.name or "").strip()
        if not name:
            continue
        if name.lower() in haystack:
            score = 3.0
        else:
            score = float(len(text_words & norm_words(name)))
        if score > best_score:
            best, best_score = category, score
    return best if best_score >= 1.0 else None


def _trim(text: Optional[str], limit: int = _DESC_CHARS) -> str:
    clean = (text or "").strip().replace("\n", " ")
    return clean[:limit] + ("…" if len(clean) > limit else "")


def _service_card(service: ServiceListing) -> Dict[str, Any]:
    return {
        "id": str(service.id),
        "title": service.title,
        "price": float(service.price),
        "description": _trim(service.description),
        "distance_km": getattr(service, "distance_km", None),
        "provider_id": str(service.provider_id),
    }


def _job_card(job: Job) -> Dict[str, Any]:
    return {
        "id": str(job.id),
        "title": job.title,
        "price": float(job.price),
        "status": job.status,
        "description": _trim(job.description),
        "distance_km": getattr(job, "distance_km", None),
        "is_mine": None,  # filled by the caller when relevant
    }


import math


def _haversine_km(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    earth_radius_km = 6371.0
    delta_lat = math.radians(lat2 - lat1)
    delta_lng = math.radians(lng2 - lng1)
    arc = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(delta_lng / 2) ** 2
    )
    chord = 2 * math.atan2(math.sqrt(arc), math.sqrt(1 - arc))
    return earth_radius_km * chord


def _user_location(user: User) -> Optional[Dict[str, float]]:
    lat, lng = getattr(user, "location_lat", None), getattr(user, "location_lng", None)
    if lat is None or lng is None:
        return None
    return {"lat": float(lat), "lng": float(lng)}


def _error(message: str) -> Dict[str, Any]:
    return {"ok": False, "error": message}


# ── Tool implementations ──────────────────────────────────────────────────────

async def _tool_search_services(db: AsyncSession, user: User, args: Dict[str, Any]) -> Dict[str, Any]:
    from ..crud.service import get_services_nearby, search_services_by_text

    search_query = str(args.get("query") or "").strip()
    price_ceiling = args.get("max_price")
    search_radius_km = float(args.get("radius_km") or 10)
    user_coords = _user_location(user)

    if search_query:
        candidates = await search_services_by_text(db, search_query, limit=30)
    elif user_coords:
        candidates = await get_services_nearby(
            db, user_coords["lat"], user_coords["lng"], radius_km=search_radius_km, limit=15
        )
    else:
        candidates = await search_services_by_text(db, "service", limit=15)

    candidate_services = [s for s in candidates if str(s.provider_id) != str(user.id)]

    if user_coords:
        for candidate in candidate_services:
            if candidate.latitude is not None and candidate.longitude is not None:
                candidate.distance_km = round(
                    _haversine_km(
                        user_coords["lat"],
                        user_coords["lng"],
                        float(candidate.latitude),
                        float(candidate.longitude),
                    ),
                    1,
                )
            else:
                candidate.distance_km = None
        candidate_services.sort(
            key=lambda s: (s.distance_km if s.distance_km is not None else 99999.0, float(s.price))
        )

    nearby_matches = [
        s for s in candidate_services
        if s.distance_km is not None and s.distance_km <= search_radius_km
    ] if user_coords else candidate_services

    active_matches = nearby_matches if nearby_matches else candidate_services

    if price_ceiling is not None:
        try:
            budget_matches = [s for s in active_matches if float(s.price) <= float(price_ceiling)]
            if budget_matches:
                active_matches = budget_matches
        except (TypeError, ValueError):
            pass

    cards = [_service_card(s) for s in active_matches[:_MAX_RESULTS]]
    outside_note = None
    if user_coords and not nearby_matches and candidate_services:
        nearest_distance = candidate_services[0].distance_km
        distance_label = f" ({nearest_distance:g} km away)" if nearest_distance is not None else ""
        outside_note = (
            f"None found within {search_radius_km:g} km, but found {len(candidate_services)} provider(s) "
            f"further away{distance_label}."
        )

    return {
        "ok": True,
        "count": len(cards),
        "total_found": len(candidate_services),
        "services": cards,
        "note": outside_note or (
            "Use request_service with a service id to open a request."
            if cards else "No matching providers found."
        ),
    }


async def _tool_search_jobs(db: AsyncSession, user: User, args: Dict[str, Any]) -> Dict[str, Any]:
    from ..crud.job import get_open_jobs_nearby, search_jobs_by_text

    query = str(args.get("query") or "").strip()
    min_price = args.get("min_price")
    radius_km = float(args.get("radius_km") or 15)
    location = _user_location(user)

    if location:
        jobs = await get_open_jobs_nearby(
            db, location["lat"], location["lng"], radius_km=radius_km,
            exclude_user_id=user.id, limit=15,
        )
        if not jobs and query:
            jobs = await search_jobs_by_text(db, query, limit=15)
    else:
        jobs = await search_jobs_by_text(db, query or "job", limit=15)

    jobs = [j for j in jobs if j.status == "open" and str(j.client_id) != str(user.id)]
    if min_price is not None:
        try:
            jobs = [j for j in jobs if float(j.price) >= float(min_price)]
        except (TypeError, ValueError):
            pass

    cards = [_job_card(j) for j in jobs[:_MAX_RESULTS]]
    for card in cards:
        card.pop("is_mine", None)
    return {
        "ok": True,
        "count": len(cards),
        "jobs": cards,
        "note": "Use apply_to_job with a job id to apply."
        if cards else "No matching open jobs found.",
    }


async def _tool_my_jobs(db: AsyncSession, user: User, args: Dict[str, Any]) -> Dict[str, Any]:
    from ..crud.job import get_jobs_by_client, get_jobs_by_provider

    as_client = await get_jobs_by_client(db, user.id, limit=10)
    as_provider = await get_jobs_by_provider(db, user.id, limit=10)

    def summarise(job: Job, role: str) -> Dict[str, Any]:
        return {
            "id": str(job.id),
            "title": job.title,
            "price": float(job.price),
            "status": job.status,
            "role": role,
        }

    return {
        "ok": True,
        "posting": [summarise(j, "client") for j in as_client[:5]],
        "working_on": [summarise(j, "provider") for j in as_provider[:5]],
        "counts": {
            "as_client": len(as_client),
            "as_provider": len(as_provider),
        },
    }


async def _tool_my_applications(db: AsyncSession, user: User, args: Dict[str, Any]) -> Dict[str, Any]:
    from ..crud.application import get_applications_by_applicant
    from ..crud.job import get_job_by_id

    applications = await get_applications_by_applicant(db, user.id, limit=10)
    out: List[Dict[str, Any]] = []
    for application in applications[:5]:
        job = await get_job_by_id(db, application.job_id)
        out.append({
            "job_id": str(application.job_id),
            "job_title": job.title if job else None,
            "job_status": job.status if job else None,
            "proposed_price": float(application.proposed_price) if application.proposed_price else None,
            "applied_at": application.created_at.isoformat() if application.created_at else None,
        })
    return {"ok": True, "count": len(applications), "applications": out}


async def _tool_get_wallet(db: AsyncSession, user: User, args: Dict[str, Any]) -> Dict[str, Any]:
    if not user.wallet_public_key:
        return {
            "ok": True,
            "connected": False,
            "note": "No Solana wallet connected yet. You can connect or fund your wallet from the dashboard.",
        }

    from ..api.v1.endpoints.users import get_my_balance
    try:
        balance_res = await get_my_balance(current_user=user)
        sol_amount = balance_res.get("sol", 0.0)
        usdc_amount = balance_res.get("usdc", "0.00")
        wallet_key = user.wallet_public_key
        return {
            "ok": True,
            "connected": True,
            "wallet_public_key": wallet_key,
            "sol_balance": sol_amount,
            "usdc_balance": usdc_amount,
            "note": f"Wallet {wallet_key[:4]}...{wallet_key[-4:]} has {sol_amount} SOL and {usdc_amount} USDC. Funding and releasing escrow are manual actions in the app.",
        }
    except Exception as balance_exc:
        wallet_key = user.wallet_public_key
        return {
            "ok": True,
            "connected": True,
            "wallet_public_key": wallet_key,
            "note": f"Connected wallet: {wallet_key[:4]}...{wallet_key[-4:]} (balance check warning: {balance_exc})",
        }


async def _tool_get_my_location(db: AsyncSession, user: User, args: Dict[str, Any]) -> Dict[str, Any]:
    location = _user_location(user)
    if not location:
        return {
            "ok": True,
            "location": None,
            "note": "No saved location. Ask the user to enable location in Profile "
                    "before doing anything location-specific.",
        }
    return {"ok": True, "location": location}


async def _tool_apply_to_job(db: AsyncSession, user: User, args: Dict[str, Any]) -> Dict[str, Any]:
    from ..crud.application import create_application, get_application_by_applicant_and_job
    from ..crud.job import get_job_by_id
    from ..schemas.application import ApplicationCreate

    job_id_raw = args.get("job_id")
    if not job_id_raw:
        return _error("job_id is required")
    try:
        job_id = UUID(str(job_id_raw))
    except (ValueError, TypeError):
        return _error("job_id is not a valid id")

    job = await get_job_by_id(db, job_id)
    if not job:
        return _error("job not found")
    if str(job.client_id) == str(user.id):
        return _error("this is the user's own job")
    if job.status != "open":
        return _error(f"job is not open (status={job.status})")
    if await get_application_by_applicant_and_job(db, user.id, job_id):
        return {"ok": True, "already_applied": True, "job_title": job.title}

    message = str(args.get("message") or "").strip() or (
        f"Hi! I'm interested in “{job.title}”. I've read the brief and I'm "
        f"available to start. (Applied by my Gigr assistant.)"
    )
    await create_application(
        db, user.id, ApplicationCreate(job_id=job.id, message=message)
    )
    return {"ok": True, "applied": True, "job_id": str(job.id), "job_title": job.title}


async def _tool_request_service(db: AsyncSession, user: User, args: Dict[str, Any]) -> Dict[str, Any]:
    from ..crud.job import create_job
    from ..crud.message import create_message
    from ..crud.service import get_service_by_id
    from ..schemas.job import JobCreate

    service_id_raw = args.get("service_id")
    if not service_id_raw:
        return _error("service_id is required")
    try:
        service_id = UUID(str(service_id_raw))
    except (ValueError, TypeError):
        return _error("service_id is not a valid id")

    service = await get_service_by_id(db, service_id)
    if not service:
        return _error("service not found")
    if str(service.provider_id) == str(user.id):
        return _error("the user owns this service")

    location = None
    if service.latitude is not None and service.longitude is not None:
        location = f"SRID=4326;POINT({service.longitude} {service.latitude})"
    if location is None:
        location = None  # jobs may legitimately be location-less

    job = await create_job(
        db,
        user.id,
        JobCreate(
            title=service.title,
            description=f"Request for service: {service.title}",
            price=service.price,
        ),
    )
    job.provider_id = service.provider_id
    job.service_listing_id = service.id
    job.category_id = service.category_id
    job.status = "requested"
    if location:
        job.location = location
    await db.flush()

    note = str(args.get("note") or "").strip()
    content = note or (
        f"Hi! My Gigr assistant matched me with your service “{service.title}”. "
        f"I'd like to go ahead."
    )
    try:
        await create_message(db, job.id, user.id, content, is_agent=True)
    except Exception as exc:  # the request itself already succeeded
        logger.warning("[agent] request message failed: %s", exc)

    return {
        "ok": True,
        "job_id": str(job.id),
        "service": service.title,
        "price": float(service.price),
    }


async def _tool_post_job(db: AsyncSession, user: User, args: Dict[str, Any]) -> Dict[str, Any]:
    from ..crud.job import create_job
    from ..schemas.job import JobCreate

    title = str(args.get("title") or "").strip()
    if not title:
        return _error("title is required")
    try:
        price = float(args.get("price"))
    except (TypeError, ValueError):
        return _error("a numeric price is required")

    location = _user_location(user)
    category = await pick_category(db, f"{title} {args.get('description') or ''}")

    job = await create_job(
        db,
        user.id,
        JobCreate(
            title=title[:255],
            description=str(args.get("description") or title),
            price=price,
            latitude=location["lat"] if location else None,
            longitude=location["lng"] if location else None,
            category_id=category.id if category else None,
        ),
    )
    return {
        "ok": True,
        "job_id": str(job.id),
        "title": job.title,
        "price": price,
        "category": category.name if category else None,
    }


async def _tool_navigate(db: AsyncSession, user: User, args: Dict[str, Any]) -> Dict[str, Any]:
    page = str(args.get("page") or "").strip().lower()
    routes = {
        "home": "/dashboard",
        "dashboard": "/dashboard",
        "jobs": "/dashboard/jobs",
        "services": "/dashboard/services",
        "messages": "/dashboard/messages",
        "activity": "/dashboard/activity",
        "disputes": "/dashboard/disputes",
        "profile": "/dashboard/profile",
        "ai": "/dashboard/ai-settings",
    }
    route = routes.get(page)
    if not route:
        return _error(f"unknown page '{page}'")
    return {"ok": True, "route": route, "page": page}


# ── Registry ──────────────────────────────────────────────────────────────────

_TOOL_TABLE: Dict[str, Dict[str, Any]] = {
    "search_services": {
        "description": (
            "Find service providers the user could hire. Prefers providers near "
            "the user's saved location."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What the user needs, e.g. 'plumber'."},
                "max_price": {"type": "number", "description": "Maximum price in Naira."},
                "radius_km": {"type": "number", "description": "Search radius in km (default 10)."},
            },
            "required": ["query"],
        },
        "handler": _tool_search_services,
    },
    "search_jobs": {
        "description": "Find open jobs the user could apply to, nearest first.",
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Keywords, e.g. 'electrical'."},
                "min_price": {"type": "number", "description": "Minimum pay in Naira."},
                "radius_km": {"type": "number", "description": "Search radius in km (default 15)."},
            },
            "required": [],
        },
        "handler": _tool_search_jobs,
    },
    "my_jobs": {
        "description": "List the user's own jobs — the ones they posted and the ones they're working on.",
        "parameters": {"type": "object", "properties": {}, "required": []},
        "handler": _tool_my_jobs,
    },
    "my_applications": {
        "description": "List jobs the user has applied to, with their status.",
        "parameters": {"type": "object", "properties": {}, "required": []},
        "handler": _tool_my_applications,
    },
    "get_wallet": {
        "description": "Get the user's wallet public key.",
        "parameters": {"type": "object", "properties": {}, "required": []},
        "handler": _tool_get_wallet,
    },
    "get_my_location": {
        "description": "Get the user's saved location. Call this before location-specific work.",
        "parameters": {"type": "object", "properties": {}, "required": []},
        "handler": _tool_get_my_location,
    },
    "apply_to_job": {
        "description": "Apply to an open job on the user's behalf. Only call when the user asked to apply.",
        "parameters": {
            "type": "object",
            "properties": {
                "job_id": {"type": "string", "description": "The job id from search_jobs or my_jobs."},
                "message": {"type": "string", "description": "Optional application message."},
            },
            "required": ["job_id"],
        },
        "handler": _tool_apply_to_job,
    },
    "request_service": {
        "description": "Open a request with a provider for one of their services.",
        "parameters": {
            "type": "object",
            "properties": {
                "service_id": {"type": "string", "description": "The service id from search_services."},
                "note": {"type": "string", "description": "Optional opening message."},
            },
            "required": ["service_id"],
        },
        "handler": _tool_request_service,
    },
    "post_job": {
        "description": "Post a new job on the user's behalf. Only when the user clearly wants to hire someone.",
        "parameters": {
            "type": "object",
            "properties": {
                "title": {"type": "string"},
                "price": {"type": "number", "description": "Budget in Naira."},
                "description": {"type": "string"},
            },
            "required": ["title", "price"],
        },
        "handler": _tool_post_job,
    },
    "navigate": {
        "description": "Take the user to a page in the app.",
        "parameters": {
            "type": "object",
            "properties": {
                "page": {
                    "type": "string",
                    "enum": ["home", "jobs", "services", "messages", "activity",
                             "disputes", "profile", "ai"],
                }
            },
            "required": ["page"],
        },
        "handler": _tool_navigate,
    },
}


def tool_specs() -> List[Dict[str, Any]]:
    """OpenAI/Groq-compatible tool definitions."""
    return [
        {
            "type": "function",
            "function": {
                "name": name,
                "description": spec["description"],
                "parameters": spec["parameters"],
            },
        }
        for name, spec in _TOOL_TABLE.items()
    ]


def tool_names() -> List[str]:
    return list(_TOOL_TABLE.keys())


async def execute_tool(
    db: AsyncSession, user: User, name: str, args: Dict[str, Any]
) -> Dict[str, Any]:
    """Run one tool by name, never raising — the model needs a usable result."""
    spec = _TOOL_TABLE.get(name)
    if not spec:
        return _error(f"unknown tool '{name}'")
    try:
        return await spec["handler"](db, user, args or {})
    except Exception as exc:
        logger.warning("[agent] tool %s failed: %s", name, exc, exc_info=True)
        return _error(f"{name} failed: {exc}")


# ── Grounded context ──────────────────────────────────────────────────────────

async def build_user_context(db: AsyncSession, user: User) -> Dict[str, Any]:
    """A compact, factual snapshot the model can rely on instead of guessing."""
    from ..crud.application import get_applications_by_applicant
    from ..crud.job import get_jobs_by_client, get_jobs_by_provider

    location = _user_location(user)
    as_client = await get_jobs_by_client(db, user.id, limit=5)
    as_provider = await get_jobs_by_provider(db, user.id, limit=5)
    applications = await get_applications_by_applicant(db, user.id, limit=5)

    return {
        "display_name": user.display_name,
        "has_location": location is not None,
        "location": location,
        "wallet_connected": bool(user.wallet_public_key),
        "jobs_posted": [
            {"id": str(j.id), "title": j.title, "status": j.status, "price": float(j.price)}
            for j in as_client[:5]
        ],
        "jobs_working_on": [
            {"id": str(j.id), "title": j.title, "status": j.status, "price": float(j.price)}
            for j in as_provider[:5]
        ],
        "applications": len(applications),
    }


SYSTEM_PROMPT = """You are Gigr's in-app assistant for a hyperlocal services marketplace in Nigeria.

You can call tools to look things up and to act on the user's behalf. Rules:
- Prefer calling a tool over guessing. Never invent jobs, providers, prices or ids.
- Prices are in Naira. Use the user's saved location for anything location-specific;
  call get_my_location first if you are unsure whether one exists.
- NEVER invent a budget or max_price. If the user did not specify a price or budget, do not pass max_price.
- When the user mentions physical symptoms or pain (e.g. "my back hurts", "sore body"), call search_services with a relevant query like "massage" or "physiotherapy" WITHOUT any max_price.
- When the user asks about their wallet, balance, funds, SOL, or USDC, call get_wallet.
- Only apply to jobs, request services, or post jobs when the user actually asked for it.
- You can NEVER move money. Escrow funding and release are manual actions the user
  performs in the app — never claim a payment happened.
- Be brief: 1-3 sentences in the final answer, and say concretely what you did.
"""


def _summarise_step(name: str, result: Dict[str, Any]) -> str:
    """A short human-readable line for the activity log."""
    if not result.get("ok", True):
        return f"{name} failed: {result.get('error')}"
    if name in ("search_services", "search_jobs"):
        return f"{name}: {result.get('count', 0)} result(s)"
    if name == "my_jobs":
        counts = result.get("counts", {})
        return f"my_jobs: {counts.get('as_client', 0)} posted, {counts.get('as_provider', 0)} in progress"
    if name == "my_applications":
        return f"my_applications: {result.get('count', 0)}"
    if name == "apply_to_job":
        return f"applied to “{result.get('job_title')}”" if result.get("applied") else "already applied"
    if name == "request_service":
        return f"requested “{result.get('service')}”"
    if name == "post_job":
        return f"posted “{result.get('title')}”"
    if name == "navigate":
        return f"navigate → {result.get('route')}"
    if name == "get_my_location":
        return "checked location" if result.get("location") else "no saved location"
    if name == "get_wallet":
        return "checked wallet balance"
    return name


async def run_agent_loop(
    db: AsyncSession,
    user: User,
    command: str,
    *,
    max_steps: int = MAX_STEPS,
) -> Dict[str, Any]:
    """Let the model plan and call tools, then answer.

    Returns ``{"reply", "steps", "context", "used_tools"}``. ``reply`` is None
    when no LLM is configured, so the caller can fall back to the rule-based
    response.
    """
    if not groq_client.has_llm():
        return {"reply": None, "steps": [], "used_tools": [], "reason": "no_llm"}

    context = await build_user_context(db, user)
    messages: List[Dict[str, Any]] = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "system",
            "content": "USER CONTEXT (authoritative, do not contradict):\n"
                       + json.dumps(context, default=str),
        },
        {"role": "user", "content": command},
    ]

    steps: List[Dict[str, Any]] = []
    used_tools: List[str] = []

    for _ in range(max(1, max_steps)):
        try:
            response = await groq_client.chat(
                messages, tools=tool_specs(), temperature=0.2, max_tokens=900,
                reasoning_effort="low",
            )
        except Exception as exc:
            logger.warning("[agent] tool-calling step failed: %s", exc)
            return {"reply": None, "steps": steps, "used_tools": used_tools,
                    "context": context, "reason": "llm_error"}

        message = groq_client.message_of(response)
        tool_calls = message.get("tool_calls") or []

        if not tool_calls:
            reply = (message.get("content") or "").strip()
            return {"reply": reply or None, "steps": steps,
                    "used_tools": used_tools, "context": context}

        messages.append({
            "role": "assistant",
            "content": message.get("content") or "",
            "tool_calls": tool_calls,
        })

        for call in tool_calls:
            function = call.get("function") or {}
            name = function.get("name") or ""
            raw_args = function.get("arguments") or "{}"
            try:
                args = json.loads(raw_args) if isinstance(raw_args, str) else (raw_args or {})
            except json.JSONDecodeError:
                args = {}

            result = await execute_tool(db, user, name, args)
            used_tools.append(name)
            steps.append({
                "tool": name,
                "args": args,
                "ok": bool(result.get("ok", True)),
                "summary": _summarise_step(name, result),
                # Keep the log line and the navigation intent for the UI.
                "route": result.get("route"),
            })
            messages.append({
                "role": "tool",
                "tool_call_id": call.get("id"),
                "content": json.dumps(result, default=str)[:4000],
            })

    # Out of steps — ask for a wrap-up from what we already gathered.
    try:
        final = await groq_client.chat(messages, temperature=0.3, max_tokens=300)
        reply = groq_client.text_of(final)
    except Exception:
        reply = ""
    return {
        "reply": reply or "I've done what I can for now — check your activity for the details.",
        "steps": steps,
        "used_tools": used_tools,
        "context": context,
        "hit_step_limit": True,
    }
