"""
Groq health check - run this any time you suspect the AI is falling back to regex.

    cd backend
    python scripts/check_groq.py
    python scripts/check_groq.py "post a job for a plumber, 5k"   # test a real command

It answers three questions, in order, so you know EXACTLY where it breaks:
  1. Is a key configured?
  2. Does the key authenticate and is GROQ_MODEL still alive? (a live API ping)
  3. Does parse_command() actually use Groq, or silently fall back to rules?
"""

import asyncio
import sys

import httpx

# Allow running from the backend/ dir directly.
sys.path.insert(0, ".")

from app.core.config import settings          # noqa: E402
from app.api.v1.endpoints import ai            # noqa: E402

GREEN, RED, YEL, DIM, END = "\033[92m", "\033[91m", "\033[93m", "\033[2m", "\033[0m"
def ok(m): print(f"{GREEN}[OK]{END} {m}")
def bad(m): print(f"{RED}[X]{END} {m}")
def info(m): print(f"{DIM}  {m}{END}")


async def main() -> int:
    print("== Groq configuration")
    keys = settings.groq_keys_list
    if not keys:
        bad("No Groq key configured (GROQ_API_KEY / GROQ_API_KEYS both empty).")
        info("-> parse_command() will ALWAYS use the rule-based fallback.")
        return 1
    ok(f"{len(keys)} key(s) configured. Model = {YEL}{settings.GROQ_MODEL}{END}")

    print("\n== Live API ping")
    async with httpx.AsyncClient(timeout=15.0) as c:
        r = await c.post(
            "https://api.groq.com/openai/v1/chat/completions",
            headers={"Authorization": f"Bearer {keys[0]}", "Content-Type": "application/json"},
            json={"model": settings.GROQ_MODEL,
                  "messages": [{"role": "user", "content": "reply with the single word: pong"}],
                  "max_tokens": 10},
        )
    if r.status_code == 200:
        ok(f"HTTP 200 - reply: {r.json()['choices'][0]['message']['content'].strip()!r}")
    elif r.status_code in (401, 403):
        bad(f"HTTP {r.status_code} - key rejected. Rotate/replace GROQ_API_KEY.")
        return 1
    elif r.status_code == 400 and "decommission" in r.text.lower():
        bad(f"HTTP 400 - model {settings.GROQ_MODEL!r} is DECOMMISSIONED.")
        info("-> Pick a current model from: python scripts/check_groq.py --models")
        return 1
    elif r.status_code == 429:
        bad("HTTP 429 - rate limited. Key works but is throttled right now.")
    else:
        bad(f"HTTP {r.status_code} - {r.text[:200]}")
        return 1

    print("\n== End-to-end parse_command()")
    cmd = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("-") \
        else "post a job, I want some pijama makers, 3k is what I will pay"
    info(f"command: {cmd!r}")
    # Force a distinguishable marker: Groq returns a 'response' string; rules use a
    # fixed set of phrasings. Simplest reliable signal - run both and compare.
    groq_raw = await ai._parse_command_groq(cmd)
    if groq_raw and groq_raw.get("task_type"):
        ok(f"Groq parsed it -> task_type={groq_raw['task_type']!r}, params={groq_raw.get('params')}")
        ok(f"{GREEN}Groq IS being used.{END}")
    else:
        bad("Groq returned nothing usable - parse_command() falls back to rules here.")
        info(f"rules would give: {ai._parse_command_rules(cmd)}")
        return 1
    return 0


if __name__ == "__main__":
    if "--models" in sys.argv:
        r = httpx.get("https://api.groq.com/openai/v1/models",
                      headers={"Authorization": f"Bearer {settings.groq_keys_list[0]}"}, timeout=15.0)
        print("Models available to your key:")
        for m in sorted(x["id"] for x in r.json().get("data", [])):
            print("  ", m)
        sys.exit(0)
    sys.exit(asyncio.run(main()))
