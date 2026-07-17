"""
Twilio voice-call client + AI-agent calling helpers.

Follows the same lightweight ``httpx``-against-the-REST-API pattern as
``brevo_client.py`` / ``underdog_client.py`` — no extra SDK dependency.

Flow (dynamic content *per call*):

  1. The agent decides what to say to a specific user and calls
     :func:`maybe_call_user`.
  2. We persist that text in a ``VoiceCall`` row keyed by a random ``token``.
  3. We ask Twilio to dial the user, pointing its ``Url`` webhook at
     ``{PUBLIC_BASE_URL}/api/v1/voice/twiml/{token}``.
  4. When Twilio rings that URL, ``voice.py`` looks the row up by token and
     returns the personalised ``<Say>`` TwiML.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import logging
import secrets
import uuid
from typing import Any, Dict, Mapping, Optional
from xml.sax.saxutils import escape as _xml_escape

import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from ..core.config import settings
from ..models.voice_call import VoiceCall

logger = logging.getLogger(__name__)

# Trigger keys the UI exposes as checkboxes. Keep in sync with the frontend.
CALL_TRIGGERS = ("item_found", "negotiation_done", "job_posted", "task_failed")

# Sensible defaults when a user hasn't configured calling yet.
_DEFAULT_CALL_PREFS: Dict[str, Any] = {
    "enabled": False,
    "triggers": {
        "item_found": True,
        "negotiation_done": True,
        "job_posted": False,
        "task_failed": False,
    },
    "reminderDismissed": False,
}


def call_prefs_for(user) -> Dict[str, Any]:
    """Return a user's call preferences merged over the defaults."""
    raw = (getattr(user, "ai_settings", None) or {}).get("call") or {}
    prefs = {**_DEFAULT_CALL_PREFS, **raw}
    prefs["triggers"] = {**_DEFAULT_CALL_PREFS["triggers"], **(raw.get("triggers") or {})}
    return prefs


# ── TwiML helpers ─────────────────────────────────────────────────────────────

def build_say_twiml(text: str) -> str:
    """Render a <Say> TwiML document that speaks ``text`` (XML-escaped)."""
    voice = settings.TWILIO_VOICE or "alice"
    spoken = _xml_escape(text or "Hello from Gigr.")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>'
        "<Response>"
        f'<Say voice="{_xml_escape(voice)}">{spoken}</Say>'
        "</Response>"
    )


# ── Twilio request signature validation ───────────────────────────────────────

def validate_signature(url: str, params: Mapping[str, str], signature: Optional[str]) -> bool:
    """Verify Twilio's ``X-Twilio-Signature`` header.

    Twilio signs: the full request URL, followed by each POST param appended as
    ``key + value`` in alphabetical key order, HMAC-SHA1'd with the auth token
    and base64-encoded. See https://www.twilio.com/docs/usage/security
    """
    if not settings.TWILIO_VALIDATE_SIGNATURE:
        return True
    if not signature or not settings.TWILIO_AUTH_TOKEN:
        return False

    data = url
    for key in sorted(params.keys()):
        data += key + str(params[key])

    mac = hmac.new(settings.TWILIO_AUTH_TOKEN.encode("utf-8"), data.encode("utf-8"), hashlib.sha1)
    expected = base64.b64encode(mac.digest()).decode("utf-8")
    return hmac.compare_digest(expected, signature)


# ── Low-level: place a call ───────────────────────────────────────────────────

async def place_call(to_number: str, twiml_url: str, status_callback_url: Optional[str] = None) -> Dict[str, Any]:
    """Place an outbound call via the Twilio REST API. Returns the Twilio JSON."""
    api_url = (
        f"https://api.twilio.com/2010-04-01/Accounts/{settings.TWILIO_ACCOUNT_SID}/Calls.json"
    )
    form: Dict[str, str] = {
        "To": to_number,
        "From": settings.TWILIO_FROM_NUMBER,
        "Url": twiml_url,          # Twilio fetches dynamic TwiML from here
        "Method": "POST",
    }
    if status_callback_url:
        form["StatusCallback"] = status_callback_url
        form["StatusCallbackMethod"] = "POST"

    async with httpx.AsyncClient(timeout=15.0) as client:
        resp = await client.post(
            api_url,
            data=form,
            auth=(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN),
        )
        resp.raise_for_status()
        return resp.json()


# ── High-level: create + place a personalised call ────────────────────────────

def _webhook_base() -> str:
    return (settings.PUBLIC_BASE_URL or "").rstrip("/") + "/api/v1/voice"


async def create_and_place_call(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    to_number: str,
    message: str,
    trigger: str = "manual",
    task_id: Optional[uuid.UUID] = None,
) -> VoiceCall:
    """Persist the spoken content, then dial the user. Row status reflects outcome."""
    token = secrets.token_urlsafe(24)
    call = VoiceCall(
        user_id=user_id,
        token=token,
        to_number=to_number,
        message=message,
        trigger=trigger,
        task_id=task_id,
        status="created",
    )
    db.add(call)
    await db.flush()  # persist so the TwiML webhook can find it the instant Twilio calls

    if not settings.twilio_enabled:
        call.status = "failed"
        call.error = "Twilio not configured (missing credentials or PUBLIC_BASE_URL)"
        await db.flush()
        logger.warning("[twilio] Skipped call to %s — Twilio not configured", to_number)
        return call

    base = _webhook_base()
    twiml_url = f"{base}/twiml/{token}"
    status_url = f"{base}/status/{token}"
    try:
        data = await place_call(to_number, twiml_url, status_url)
        call.call_sid = data.get("sid")
        call.status = data.get("status", "queued")
        logger.info("[twilio] Placed %s call to %s (sid=%s)", trigger, to_number, call.call_sid)
    except httpx.HTTPStatusError as exc:
        call.status = "failed"
        call.error = f"HTTP {exc.response.status_code}: {exc.response.text[:400]}"
        logger.error("[twilio] Call to %s failed: %s", to_number, call.error)
    except Exception as exc:  # noqa: BLE001 — best-effort, never raise to caller
        call.status = "failed"
        call.error = str(exc)[:400]
        logger.error("[twilio] Call to %s errored: %s", to_number, exc)

    await db.flush()
    return call


async def maybe_call_user(
    db: AsyncSession,
    user,
    *,
    trigger: str,
    message: str,
    task_id: Optional[uuid.UUID] = None,
) -> Optional[VoiceCall]:
    """Call the user for ``trigger`` if their prefs + phone allow it.

    Returns the ``VoiceCall`` row when a call is attempted, else ``None``.
    Never raises — calling is a best-effort side-effect of a task.
    """
    try:
        if not settings.twilio_enabled:
            return None
        phone = (getattr(user, "phone_number", None) or "").strip()
        if not phone:
            return None

        prefs = call_prefs_for(user)
        if not prefs.get("enabled"):
            return None
        if not prefs.get("triggers", {}).get(trigger, False):
            return None

        return await create_and_place_call(
            db,
            user_id=user.id,
            to_number=phone,
            message=message,
            trigger=trigger,
            task_id=task_id,
        )
    except Exception as exc:  # noqa: BLE001
        logger.error("[twilio] maybe_call_user failed for trigger=%s: %s", trigger, exc)
        return None
