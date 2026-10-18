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
from ..core.config import settings
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
    p = float(service.price) if getattr(service, "price", None) is not None else None
    min_p = float(service.min_price) if getattr(service, "min_price", None) is not None else None
    max_p = float(service.max_price) if getattr(service, "max_price", None) is not None else None
    if p is not None and p > 0:
        price_display = f"₦{p:,.0f}"
    elif min_p is not None and max_p is not None and min_p > 0 and max_p > 0:
        price_display = f"₦{min_p:,.0f} - ₦{max_p:,.0f}"
    elif min_p is not None and min_p > 0:
        price_display = f"From ₦{min_p:,.0f}"
    elif max_p is not None and max_p > 0:
        price_display = f"Up to ₦{max_p:,.0f}"
    else:
        price_display = "Negotiable"

    return {
        "id": str(service.id),
        "title": service.title,
        "price": p or min_p or 0.0,
        "min_price": min_p,
        "max_price": max_p,
        "price_display": price_display,
        "description": _trim(service.description),
        "distance_km": getattr(service, "distance_km", None),
        "provider_id": str(service.provider_id),
    }


def _job_card(job: Job) -> Dict[str, Any]:
    p = float(job.price) if getattr(job, "price", None) is not None else None
    min_p = float(job.min_price) if getattr(job, "min_price", None) is not None else None
    max_p = float(job.max_price) if getattr(job, "max_price", None) is not None else None
    if p is not None and p > 0:
        price_display = f"₦{p:,.0f}"
    elif min_p is not None and max_p is not None and min_p > 0 and max_p > 0:
        price_display = f"₦{min_p:,.0f} - ₦{max_p:,.0f}"
    elif min_p is not None and min_p > 0:
        price_display = f"From ₦{min_p:,.0f}"
    elif max_p is not None and max_p > 0:
        price_display = f"Up to ₦{max_p:,.0f}"
    else:
        price_display = "Negotiable"

    return {
        "id": str(job.id),
        "title": job.title,
        "price": p or min_p or 0.0,
        "min_price": min_p,
        "max_price": max_p,
        "price_display": price_display,
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
    search_radius_raw = args.get("radius_km")
    is_unlimited = search_radius_raw is not None and float(search_radius_raw) == 0
    search_radius_km = 0.0 if is_unlimited else (float(search_radius_raw) if search_radius_raw is not None else 10.0)
    user_coords = _user_location(user)

    candidate_services = []
    if search_query:
        candidates = await search_services_by_text(db, search_query, limit=30)
        candidate_services = [s for s in candidates if str(s.provider_id) != str(user.id)]
        if not candidate_services:
            query_lower = search_query.lower()
            from ..api.v1.endpoints.ai import RELATED_SERVICE_CATEGORIES
            for cat_key, alt_terms in RELATED_SERVICE_CATEGORIES.items():
                if cat_key in query_lower or any(t in query_lower for t in alt_terms):
                    for alt in alt_terms:
                        if alt.lower() != query_lower:
                            more_candidates = await search_services_by_text(db, alt, limit=20)
                            candidate_services.extend([s for s in more_candidates if str(s.provider_id) != str(user.id)])
                            if candidate_services:
                                break
                    if candidate_services:
                        break
    elif user_coords:
        candidates = await get_services_nearby(
            db, user_coords["lat"], user_coords["lng"], radius_km=search_radius_km, limit=15
        )
        candidate_services = [s for s in candidates if str(s.provider_id) != str(user.id)]
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

        def _tool_svc_rank(s):
            p = float(s.price) if getattr(s, "price", None) is not None else None
            min_p = float(s.min_price) if getattr(s, "min_price", None) is not None else None
            max_p = float(s.max_price) if getattr(s, "max_price", None) is not None else None
            if (p is not None and p > 0) or (min_p is not None and min_p > 0 and max_p is not None and max_p > 0):
                pricing_tier = 0
            elif (min_p is not None and min_p > 0) or (max_p is not None and max_p > 0):
                pricing_tier = 1
            else:
                pricing_tier = 2  # Penalize missing pricing to the bottom
            return (pricing_tier, s.distance_km if s.distance_km is not None else 99999.0)

        candidate_services.sort(key=_tool_svc_rank)

    nearby_matches = [
        s for s in candidate_services
        if is_unlimited or (s.distance_km is not None and s.distance_km <= search_radius_km)
    ] if user_coords else candidate_services

    active_matches = nearby_matches if nearby_matches else candidate_services

    if price_ceiling is not None:
        try:
            budget_matches = [
                s for s in active_matches
                if (getattr(s, "price", None) is not None and float(s.price) <= float(price_ceiling))
                or (getattr(s, "min_price", None) is not None and float(s.min_price) <= float(price_ceiling))
                or (getattr(s, "price", None) is None and getattr(s, "min_price", None) is None)
            ]
            if budget_matches:
                active_matches = budget_matches
        except (TypeError, ValueError):
            pass

    cards = [_service_card(s) for s in active_matches[:_MAX_RESULTS]]
    outside_note = None
    if user_coords and not is_unlimited and not nearby_matches and candidate_services:
        nearest_distance = candidate_services[0].distance_km
        distance_label = f" ({nearest_distance:g} km away)" if nearest_distance is not None else ""
        outside_note = (
            f"None found within {search_radius_km:g} km, but recommended {len(candidate_services)} provider(s) "
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
    raw_radius = args.get("radius_km")
    is_unlimited = raw_radius is not None and float(raw_radius) == 0
    radius_km = 0.0 if is_unlimited else (float(raw_radius) if raw_radius is not None else 15.0)
    location = _user_location(user)

    if location:
        jobs = await get_open_jobs_nearby(
            db, location["lat"], location["lng"], radius_km=radius_km,
            exclude_user_id=user.id, limit=25,
        )
        if not jobs and query:
            jobs = await search_jobs_by_text(db, query, limit=25)
    else:
        jobs = await search_jobs_by_text(db, query or "job", limit=25)

    jobs = [j for j in jobs if j.status == "open" and str(j.client_id) != str(user.id)]

    def _tool_job_rank(j):
        p = float(j.price) if getattr(j, "price", None) is not None else None
        min_p = float(j.min_price) if getattr(j, "min_price", None) is not None else None
        max_p = float(j.max_price) if getattr(j, "max_price", None) is not None else None
        if (p is not None and p > 0) or (min_p is not None and min_p > 0 and max_p is not None and max_p > 0):
            tier = 0
        elif (min_p is not None and min_p > 0) or (max_p is not None and max_p > 0):
            tier = 1
        else:
            tier = 2
        return (tier, getattr(j, "distance_km", 99999.0) or 99999.0)

    jobs.sort(key=_tool_job_rank)

    if min_price is not None:
        try:
            jobs = [
                j for j in jobs
                if (getattr(j, "price", None) is not None and float(j.price) >= float(min_price))
                or (getattr(j, "max_price", None) is not None and float(j.max_price) >= float(min_price))
            ]
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
    from ..core.config import settings

    if settings.PAYMENT_RAIL == "paypal":
        return {
            "ok": True,
            "rail": "paypal",
            "paypal_account_linked": bool(user.paypal_email),
            "note": "Payments run through PayPal escrow. A provider needs a linked PayPal account "
                    "to be paid; clients approve each escrow payment in PayPal themselves.",
        }
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


async def _owned_job(db: AsyncSession, user: User, args: Dict[str, Any], *, as_client: bool):
    """Resolve ``job_id`` to a job the user may act on, or an error dict."""
    from ..crud.job import get_job_by_id

    raw = args.get("job_id")
    if not raw:
        return None, _error("job_id is required")
    try:
        job_id = UUID(str(raw))
    except (ValueError, TypeError):
        return None, _error("job_id is not a valid id")
    job = await get_job_by_id(db, job_id)
    if not job:
        return None, _error("job not found")
    if as_client and str(job.client_id) != str(user.id):
        return None, _error("only the client who posted this job can pay for it")
    if not as_client and str(user.id) not in (str(job.client_id), str(job.provider_id)):
        return None, _error("this is not the user's job")
    return job, None


async def _tool_prepare_escrow_payment(db: AsyncSession, user: User, args: Dict[str, Any]) -> Dict[str, Any]:
    """Create the PayPal checkout for a job's escrow and hand back the approval link.

    This is agentic commerce with a human in the loop: the agent does all the
    legwork (finds the order, converts the price, creates the PayPal order) but
    the money only moves when the *user* opens the link and approves it in PayPal.
    """
    from fastapi import HTTPException

    from ..core.config import settings
    from ..crud.user import get_user_by_id
    from . import paypal_escrow

    if settings.PAYMENT_RAIL != "paypal":
        return _error("PayPal payments are not the active rail on this deployment")

    job, err = await _owned_job(db, user, args, as_client=True)
    if err:
        return err
    if not job.provider_id:
        return _error("this job has no hired provider yet — hire someone first")
    if job.status == "funded" or job.paypal_capture_id:
        return {"ok": True, "already_funded": True, "job_title": job.title,
                "note": "Escrow is already funded."}
    if job.status != "assigned":
        return _error(f"job is '{job.status}'; escrow can only be funded once a provider is hired (assigned)")

    provider = await get_user_by_id(db, job.provider_id)
    base = (settings.FRONTEND_URL or "http://localhost:5173").rstrip("/")
    try:
        checkout = await paypal_escrow.start_checkout(
            db, job, provider,
            client_id=user.id,
            return_url=f"{base}/dashboard/paypal/return?job={job.id}",
            cancel_url=f"{base}/dashboard/activity?paypal=cancelled&job={job.id}",
        )
        await db.commit()
    except HTTPException as exc:
        await db.rollback()
        return _error(str(exc.detail))

    return {
        "ok": True,
        "job_id": str(job.id),
        "job_title": job.title,
        "amount": checkout["amount"],
        "currency": checkout["currency"],
        "approval_url": checkout["approval_url"],
        "requires_human_approval": True,
        "note": "Nothing has been charged. The user must open approval_url and approve the "
                "payment in PayPal; it is then held in escrow until they release it.",
    }


async def _tool_payment_status(db: AsyncSession, user: User, args: Dict[str, Any]) -> Dict[str, Any]:
    from . import paypal_escrow

    job, err = await _owned_job(db, user, args, as_client=False)
    if err:
        return err
    summary = paypal_escrow.payment_summary(job)
    return {"ok": True, "job_title": job.title, "job_status": job.status, **summary}


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

    # Idempotency check: don't create duplicate requests for the same service
    existing_res = await db.execute(
        select(Job).where(
            Job.client_id == user.id,
            Job.service_listing_id == service.id,
            Job.status.in_(["requested", "assigned", "in_progress"])
        )
    )
    existing_job = existing_res.scalars().first()
    if existing_job:
        return {
            "ok": True,
            "already_requested": True,
            "job_id": str(existing_job.id),
            "service": service.title,
            "price": float(service.price),
            "note": f"You already have an active request for '{service.title}' (Job ID: {str(existing_job.id)[:8]}).",
        }

    location = None
    if service.latitude is not None and service.longitude is not None:
        from ..core.geo import to_wkt_point
        location = to_wkt_point(service.latitude, service.longitude)

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


async def _tool_cancel_jobs(db: AsyncSession, user: User, args: Dict[str, Any]) -> Dict[str, Any]:
    from ..crud.job import cancel_job_offchain
    from ..crud.notification import create_notification

    job_id_raw = args.get("job_id")
    all_pending = bool(args.get("all_pending"))
    query = str(args.get("query") or "").strip().lower()

    # Find jobs eligible for cancellation (client is current user, pre-funded: requested, open, assigned)
    stmt = select(Job).where(
        Job.client_id == user.id,
        Job.status.in_(["requested", "open", "assigned"])
    )
    result = await db.execute(stmt)
    eligible_jobs = list(result.scalars().all())

    if not eligible_jobs:
        return {
            "ok": True,
            "cancelled_count": 0,
            "cancelled": [],
            "note": "You have no pending requests or open jobs to cancel."
        }

    targets = []
    if job_id_raw:
        try:
            target_uuid = UUID(str(job_id_raw))
            targets = [j for j in eligible_jobs if j.id == target_uuid]
        except (ValueError, TypeError):
            pass
    elif query and not all_pending:
        targets = [j for j in eligible_jobs if query in (j.title or "").lower() or query in (j.description or "").lower()]
        if not targets:
            targets = eligible_jobs
    else:
        targets = eligible_jobs

    if not targets:
        return {
            "ok": True,
            "cancelled_count": 0,
            "cancelled": [],
            "note": f"No active requests found matching '{job_id_raw or query}'."
        }

    cancelled_titles = []
    for job in targets:
        await cancel_job_offchain(db, job)
        cancelled_titles.append(job.title)
        if job.provider_id:
            try:
                await create_notification(
                    db,
                    user_id=job.provider_id,
                    title="Request Cancelled",
                    message=f"Request for '{job.title}' was cancelled by {user.display_name or 'the client'}.",
                    link="/dashboard/activity",
                    type="cancelled",
                )
            except Exception:
                pass

    await db.flush()
    return {
        "ok": True,
        "cancelled_count": len(targets),
        "cancelled": cancelled_titles,
        "note": f"Cancelled {len(targets)} request(s): {', '.join(cancelled_titles)}."
    }


# ── Registry ──────────────────────────────────────────────────────────────────

_TOOL_TABLE: Dict[str, Dict[str, Any]] = {
    "cancel_requests_or_jobs": {
        "description": "Cancel pending service requests or open jobs posted by the user. Use when user asks to cancel their requests, cancel all of them, or cancel a specific request.",
        "parameters": {
            "type": "object",
            "properties": {
                "job_id": {"type": "string", "description": "Specific job or request id to cancel, if known."},
                "all_pending": {"type": "boolean", "description": "Set to true if user wants to cancel all pending requests or all open jobs."},
                "query": {"type": "string", "description": "Filter by job title or service name, e.g. 'massage', 'fumigation'."},
            },
            "required": [],
        },
        "handler": _tool_cancel_jobs,
    },
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
        "description": "Get the user's payment setup: whether a PayPal account is linked "
                       "(PayPal rail) or the wallet public key (Solana rail).",
        "parameters": {"type": "object", "properties": {}, "required": []},
        "handler": _tool_get_wallet,
    },
    "prepare_escrow_payment": {
        "description": "Create the PayPal checkout that funds a job's escrow and return an approval "
                       "link for the user. Use when the user wants to pay/fund a job they hired "
                       "someone for. You cannot charge anyone: the user must open the link and "
                       "approve in PayPal. Never say the payment is done.",
        "parameters": {
            "type": "object",
            "properties": {
                "job_id": {"type": "string", "description": "The assigned job's id (from my_jobs)."},
            },
            "required": ["job_id"],
        },
        "handler": _tool_prepare_escrow_payment,
    },
    "payment_status": {
        "description": "Where a job's money is right now: unfunded, awaiting_approval, escrowed, "
                       "released or refunded, with the amount. Use before claiming anything about "
                       "a payment.",
        "parameters": {
            "type": "object",
            "properties": {
                "job_id": {"type": "string", "description": "The job's id (from my_jobs)."},
            },
            "required": ["job_id"],
        },
        "handler": _tool_payment_status,
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
        "payment_rail": settings.PAYMENT_RAIL,
        "paypal_account_linked": bool(getattr(user, "paypal_email", None)),
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


SYSTEM_PROMPT = """You are Gigidy AI, the friendly and reliable marketplace assistant on Gigr in Nigeria.

Tone and style:
- Warm, helpful, straightforward, and respectful.
- Speak clearly in natural, relatable English suitable for local Nigerian users. No stiff corporate jargon, no robotic disclaimers.
- Keep final replies brief (1-3 sentences) and say concretely what you found or did.

Rules:
- Prefer calling a tool over guessing. Never invent jobs, providers, prices or ids.
- Prices are in Naira. Use the user's saved location for anything location-specific;
  call get_my_location first if you are unsure whether one exists.
- NEVER invent a budget or max_price. If the user did not specify a price or budget, do not pass max_price.
- When the user mentions physical symptoms or pain (e.g. "my back hurts", "sore body"), call search_services with a relevant query like "massage" or "physiotherapy" WITHOUT any max_price.
- When the user asks about their wallet, balance, funds, SOL, or USDC, call get_wallet.
- When the user asks to cancel their requests, cancel jobs, or cancel all of them, call cancel_requests_or_jobs to cancel them immediately.
- Only apply to jobs, request services, or post jobs when the user actually asked for it.
- You can NEVER move money yourself. For a job the user has hired someone for you MAY call
  prepare_escrow_payment, which only creates a PayPal checkout and returns an approval link the
  user must open and approve in PayPal. Releasing escrow is always the user's own action in the
  app. Never claim a payment happened — call payment_status and report exactly what it says.
- Be brief: 1-3 sentences in the final answer, and say concretely what you did.
"""


def _summarise_step(name: str, result: Dict[str, Any]) -> str:
    """A short human-readable line for the activity log."""
    if not result.get("ok", True):
        return f"{name} failed: {result.get('error')}"
    if name == "cancel_requests_or_jobs":
        return f"cancelled {result.get('cancelled_count', 0)} request(s)"
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
        return "checked payment setup" if result.get("rail") == "paypal" else "checked wallet balance"
    if name == "prepare_escrow_payment":
        if result.get("already_funded"):
            return "escrow already funded"
        return f"prepared PayPal checkout ({result.get('amount')} {result.get('currency')}) — awaiting your approval"
    if name == "payment_status":
        return f"payment status: {result.get('state')}"
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
