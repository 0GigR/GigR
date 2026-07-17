"""
Voice-call endpoints.

Public (called by Twilio's servers, no user auth — protected by an unguessable
token + X-Twilio-Signature validation):
  * ``POST/GET /voice/twiml/{token}``   → dynamic per-call TwiML
  * ``POST      /voice/status/{token}`` → Twilio call-status callback

Authenticated (called by the app):
  * ``GET   /voice/settings``  → phone + call preferences + config status
  * ``PATCH /voice/settings``  → update phone + call preferences
  * ``POST  /voice/call``      → place a manual / test call to yourself
  * ``GET   /voice/history``   → recent calls placed to the user
"""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import select, update as sa_update
from sqlalchemy.ext.asyncio import AsyncSession

from ....core.config import settings
from ....core.database import async_session
from ....core.dependencies import get_db, get_current_user, require_ai_enabled
from ....models.user import User
from ....models.voice_call import VoiceCall
from ....services import twilio_client
from ....services.twilio_client import CALL_TRIGGERS, build_say_twiml, call_prefs_for

logger = logging.getLogger(__name__)
router = APIRouter()


# ═══════════════════════════════════════════════════════════════════════════════
# Public webhooks (Twilio → us)
# ═══════════════════════════════════════════════════════════════════════════════

async def _validate_twilio_request(request: Request, form: Dict[str, str]) -> None:
    """Raise 403 unless the request carries a valid Twilio signature."""
    # Reconstruct the exact URL we handed to Twilio (from PUBLIC_BASE_URL, so it
    # matches even behind a TLS-terminating proxy).
    base = (settings.PUBLIC_BASE_URL or str(request.base_url)).rstrip("/")
    full_url = base + request.url.path
    signature = request.headers.get("X-Twilio-Signature")
    if not twilio_client.validate_signature(full_url, form, signature):
        logger.warning("[voice] Rejected request with bad Twilio signature: %s", request.url.path)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Invalid signature")


@router.api_route("/voice/twiml/{token}", methods=["GET", "POST"])
async def voice_twiml(token: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Return the personalised TwiML for a specific queued call."""
    form = dict(await request.form()) if request.method == "POST" else dict(request.query_params)
    await _validate_twilio_request(request, form)

    result = await db.execute(select(VoiceCall).where(VoiceCall.token == token))
    call = result.scalar_one_or_none()

    message = call.message if call else "Hello from Gigr. This call is no longer available. Goodbye."
    return Response(content=build_say_twiml(message), media_type="application/xml")


@router.post("/voice/status/{token}")
async def voice_status(token: str, request: Request, db: AsyncSession = Depends(get_db)):
    """Twilio posts call-lifecycle updates here; we mirror them onto the row."""
    form = dict(await request.form())
    await _validate_twilio_request(request, form)

    call_status = form.get("CallStatus")
    call_sid = form.get("CallSid")
    if call_status:
        values: Dict[str, Any] = {"status": call_status}
        if call_sid:
            values["call_sid"] = call_sid
        await db.execute(sa_update(VoiceCall).where(VoiceCall.token == token).values(**values))
        await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ═══════════════════════════════════════════════════════════════════════════════
# Authenticated app endpoints
# ═══════════════════════════════════════════════════════════════════════════════

class CallTriggerPrefs(BaseModel):
    item_found: Optional[bool] = None
    negotiation_done: Optional[bool] = None
    job_posted: Optional[bool] = None
    task_failed: Optional[bool] = None


class VoiceSettingsUpdate(BaseModel):
    phone_number: Optional[str] = None
    enabled: Optional[bool] = None
    triggers: Optional[CallTriggerPrefs] = None
    reminderDismissed: Optional[bool] = None


def _settings_payload(user: User) -> Dict[str, Any]:
    return {
        "phone_number": user.phone_number,
        "call": call_prefs_for(user),
        "twilio_configured": settings.twilio_enabled,
        "from_number": settings.TWILIO_FROM_NUMBER or None,
        "triggers_available": list(CALL_TRIGGERS),
    }


@router.get("/voice/settings")
async def get_voice_settings(current_user: User = Depends(get_current_user)):
    """Return the user's phone + call preferences and whether calling is configured."""
    return _settings_payload(current_user)


@router.patch("/voice/settings")
async def update_voice_settings(
    body: VoiceSettingsUpdate,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update the user's phone number and/or call preferences (stored in ai_settings.call)."""
    # Phone number lives on the user row.
    if body.phone_number is not None:
        phone = body.phone_number.strip()
        current_user.phone_number = phone or None

    # Call prefs live under ai_settings["call"].
    ai_settings = dict(current_user.ai_settings or {})
    prefs = call_prefs_for(current_user)  # start from normalised current prefs

    if body.enabled is not None:
        prefs["enabled"] = body.enabled
    if body.reminderDismissed is not None:
        prefs["reminderDismissed"] = body.reminderDismissed
    if body.triggers is not None:
        merged = dict(prefs["triggers"])
        for key, value in body.triggers.model_dump(exclude_none=True).items():
            merged[key] = value
        prefs["triggers"] = merged

    ai_settings["call"] = prefs
    current_user.ai_settings = ai_settings

    # SQLAlchemy doesn't always detect in-place JSONB mutation — assign explicitly.
    await db.execute(
        sa_update(User)
        .where(User.id == current_user.id)
        .values(phone_number=current_user.phone_number, ai_settings=ai_settings)
    )
    await db.commit()
    await db.refresh(current_user)
    return _settings_payload(current_user)


class PlaceCallRequest(BaseModel):
    message: Optional[str] = None
    to_number: Optional[str] = None  # defaults to the user's saved number


@router.post("/voice/call", status_code=status.HTTP_201_CREATED)
async def place_manual_call(
    body: PlaceCallRequest,
    current_user: User = Depends(require_ai_enabled),
    db: AsyncSession = Depends(get_db),
):
    """Place a one-off call to the user — used by the 'Test call' button."""
    if not settings.twilio_enabled:
        raise HTTPException(status_code=503, detail="Calling is not configured on the server.")

    to_number = (body.to_number or current_user.phone_number or "").strip()
    if not to_number:
        raise HTTPException(status_code=400, detail="No phone number on file. Add one first.")

    message = (body.message or "").strip() or (
        f"Hello {current_user.display_name}, this is a test call from your Gigr AI assistant. "
        "Calling is set up correctly. Goodbye."
    )

    call = await twilio_client.create_and_place_call(
        db,
        user_id=current_user.id,
        to_number=to_number,
        message=message,
        trigger="test",
    )
    await db.commit()
    if call.status == "failed":
        raise HTTPException(status_code=502, detail=call.error or "Failed to place call.")
    return {"id": str(call.id), "status": call.status, "call_sid": call.call_sid, "to": to_number}


class VoiceCallOut(BaseModel):
    id: str
    trigger: str
    to_number: str
    message: str
    status: str
    call_sid: Optional[str] = None
    created_at: Optional[str] = None


@router.get("/voice/history", response_model=List[VoiceCallOut])
async def call_history(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = 20,
):
    """Recent calls placed to the current user, newest first."""
    result = await db.execute(
        select(VoiceCall)
        .where(VoiceCall.user_id == current_user.id)
        .order_by(VoiceCall.created_at.desc())
        .limit(min(limit, 100))
    )
    return [
        VoiceCallOut(
            id=str(c.id),
            trigger=c.trigger,
            to_number=c.to_number,
            message=c.message,
            status=c.status,
            call_sid=c.call_sid,
            created_at=c.created_at.isoformat() if c.created_at else None,
        )
        for c in result.scalars().all()
    ]
