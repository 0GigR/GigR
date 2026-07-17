"""
Live Twilio call test — places ONE real phone call with a fun, randomly-chosen message.

The message comes from Groq if it's up; if Groq is down/misconfigured it falls back to
a random line from a built-in list — so the test still works and still proves the call
path independently of the AI.

WHY INLINE TwiML: this test hands Twilio the spoken text directly via the `Twiml`
parameter, instead of pointing Twilio at your webhook `Url`. That means it does NOT
depend on ngrok / PUBLIC_BASE_URL being reachable — it isolates "can I place a call and
generate a message" from your tunnel setup. (Your real app still uses the webhook flow.)

USAGE:
    cd backend
    python scripts/test_twilio_call.py --to +2348012345678
    python scripts/test_twilio_call.py --to +2348012345678 --no-groq   # force the list
    python scripts/test_twilio_call.py --to +2348012345678 --dry-run    # print, don't call

Notes:
  * On a Twilio TRIAL account you'll hear the "trial" preamble and must press a key
    before the message plays, and --to must be a VERIFIED number.
  * Requires TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER in backend/.env.
"""

import argparse
import asyncio
import random
import sys

import httpx

sys.path.insert(0, ".")

from app.core.config import settings          # noqa: E402
from app.services.twilio_client import build_say_twiml  # noqa: E402

# Fallback messages used when Groq is unavailable. Kept short + friendly.
_FALLBACK_MESSAGES = [
    "Hello from Gigr! This is a test call. If you can hear me, your calling setup works. Goodbye!",
    "Hi there! Your Gigr AI assistant is calling to say everything is wired up correctly.",
    "Good news! This test call means your phone number and Twilio are talking to each other. Nice work.",
    "Greetings from Gigr. Consider this a friendly ping to confirm your voice calls are working.",
    "Beep boop! Your robot assistant here, confirming that test calls are fully operational.",
]


async def _message_from_groq() -> str | None:
    """Ask Groq for a short, upbeat test line. Returns None if Groq is unavailable."""
    keys = settings.groq_keys_list
    if not keys:
        return None
    prompt = (
        "Write ONE short, cheerful spoken sentence (max 25 words) for a test phone call "
        "from an app called Gigr confirming the call system works. Plain text only, no quotes."
    )
    try:
        async with httpx.AsyncClient(timeout=10.0) as c:
            r = await c.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {keys[0]}", "Content-Type": "application/json"},
                json={
                    "model": settings.GROQ_MODEL,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 1.0,   # high → varied message each run
                    "max_tokens": 60,
                },
            )
            r.raise_for_status()
            text = r.json()["choices"][0]["message"]["content"].strip().strip('"')
            return text or None
    except Exception as exc:
        print(f"  [groq] unavailable ({exc}); using fallback list", file=sys.stderr)
        return None


async def _place_inline_call(to_number: str, message: str) -> dict:
    """Place a call whose spoken content is inline TwiML (no webhook needed)."""
    api_url = (
        f"https://api.twilio.com/2010-04-01/Accounts/{settings.TWILIO_ACCOUNT_SID}/Calls.json"
    )
    form = {
        "To": to_number,
        "From": settings.TWILIO_FROM_NUMBER,
        "Twiml": build_say_twiml(message),   # inline instructions, reuses your <Say> builder
    }
    async with httpx.AsyncClient(timeout=20.0) as c:
        resp = await c.post(
            api_url,
            data=form,
            auth=(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN),
        )
        if resp.status_code >= 400:
            raise RuntimeError(f"Twilio HTTP {resp.status_code}: {resp.text[:500]}")
        return resp.json()


async def main() -> int:
    ap = argparse.ArgumentParser(description="Place one test Twilio call with a random message.")
    ap.add_argument("--to", help="Destination phone in E.164 (e.g. +2348012345678). "
                                 "Defaults to TWILIO_FROM_NUMBER if omitted.")
    ap.add_argument("--no-groq", action="store_true", help="Skip Groq, use the fallback list.")
    ap.add_argument("--dry-run", action="store_true", help="Pick a message and print it, but don't call.")
    args = ap.parse_args()

    # 1) Pick the message.
    message = None
    if not args.no_groq:
        print("Fetching a message from Groq...")
        message = await _message_from_groq()
    if message:
        print(f"  source: GROQ ({settings.GROQ_MODEL})")
    else:
        message = random.choice(_FALLBACK_MESSAGES)
        print("  source: fallback list")
    print(f"  message: {message!r}\n")

    if args.dry_run:
        print("[dry-run] Not placing a call.")
        return 0

    # 2) Preconditions for a real call.
    if not settings.twilio_enabled:
        print("[X] Twilio is not fully configured (SID / token / from-number / PUBLIC_BASE_URL).",
              file=sys.stderr)
        print("    Note: this test itself doesn't need PUBLIC_BASE_URL, but `twilio_enabled` "
              "checks it. Set it, or comment this guard out for a pure call test.", file=sys.stderr)
        return 1

    to_number = (args.to or settings.TWILIO_FROM_NUMBER or "").strip()
    if not to_number:
        print("[X] No --to number and no TWILIO_FROM_NUMBER to fall back to.", file=sys.stderr)
        return 1

    # 3) Place the call.
    print(f"Placing call: {settings.TWILIO_FROM_NUMBER} -> {to_number} ...")
    try:
        data = await _place_inline_call(to_number, message)
    except Exception as exc:
        print(f"[X] Call failed: {exc}", file=sys.stderr)
        return 1

    print(f"[OK] Call queued. sid={data.get('sid')} status={data.get('status')}")
    print("     Your phone should ring shortly. (Trial account: press a key to skip the "
          "trial preamble, and make sure --to is a verified number.)")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
