# AI Phone Calls (Twilio) — Implementation

This document explains the **outbound voice-call** feature: how the Gigr AI agent
phones a user when it finishes a background task, how the spoken content is made
**unique per call**, and everything that was added to the codebase.

---

## 1. What it does (user's view)

- A user saves their phone number and opts in under **AI Settings → Phone Call Alerts**.
- They tick *when* they want to be called: item found, negotiation done, job posted, task failed.
- When the background agent finishes a matching task, their phone rings and a voice
  reads a short, personalised message (e.g. *"Good news Ada, I found 3 options for a plumber. Open the app to review and book."*).
- A dismissible reminder ("**Want a call when I'm done?**") nudges users who haven't set it up.

Nothing about the call is hard-coded — the message is generated per task and per user.

---

## 2. How dynamic per-call content works

Twilio doesn't let you push text into a call directly. Instead, when you start a call you
give Twilio a **webhook URL** (the `Url` parameter). When the callee picks up, Twilio makes
an HTTP request to that URL and **speaks whatever TwiML you return**. We exploit that to make
content dynamic:

```
1. Agent finishes a task and decides what to say for THIS user.
2. Backend saves that text in the `voice_calls` table, keyed by a random `token`.
3. Backend calls Twilio:  POST /Calls.json  with
       To   = user's phone
       From = TWILIO_FROM_NUMBER
       Url  = {PUBLIC_BASE_URL}/api/v1/voice/twiml/{token}
4. User answers → Twilio GETs/POSTs that Url.
5. Backend looks up the row by `token` and returns:
       <Response><Say>…personalised message…</Say></Response>
6. Twilio reads it aloud. Status updates POST back to /voice/status/{token}.
```

The `token` is an unguessable `secrets.token_urlsafe(24)` value, and every webhook request is
verified with Twilio's `X-Twilio-Signature` (HMAC-SHA1 of the URL + params, keyed by the auth
token). So the public endpoint can't be scraped or spoofed.

This is exactly the "content per call" pattern requested: a dynamic endpoint keyed by an
identifier, with the content stored server-side before the call is placed.

---

## 3. Backend changes

| File | What |
|------|------|
| `app/core/config.py` | New settings: `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM_NUMBER`, `TWILIO_VOICE_ENABLED`, `TWILIO_VALIDATE_SIGNATURE`, `TWILIO_VOICE`, `PUBLIC_BASE_URL`, plus a `twilio_enabled` property. |
| `app/models/voice_call.py` | New `VoiceCall` model — one row per call (token, to_number, message, trigger, status, call_sid, task_id). Auto-created on startup by `init_db()`. |
| `app/models/__init__.py` | Registers `VoiceCall` so its table is created. |
| `app/services/twilio_client.py` | Talks to the Twilio REST API via `httpx` (same style as `brevo_client.py`). `build_say_twiml`, `validate_signature`, `place_call`, `create_and_place_call`, and the high-level `maybe_call_user` gate. Also `call_prefs_for` (defaults) and `CALL_TRIGGERS`. |
| `app/api/v1/endpoints/voice.py` | Endpoints (below). |
| `app/api/v1/endpoints/ai.py` | After a task finishes, `_maybe_trigger_call` builds a `(trigger, message)` pair from the task type/result and calls `maybe_call_user`. Best-effort — never breaks a task. |
| `app/main.py` | Mounts the voice router. |

### Endpoints (all under `/api/v1`)

**Public (Twilio → us, signature-verified):**
- `GET|POST /voice/twiml/{token}` — returns the personalised `<Say>` TwiML.
- `POST /voice/status/{token}` — Twilio posts call lifecycle; mirrored onto the row.

**Authenticated (app → us):**
- `GET  /voice/settings` — `{ phone_number, call: { enabled, triggers, reminderDismissed }, twilio_configured, from_number, triggers_available }`.
- `PATCH /voice/settings` — update phone number and/or call prefs.
- `POST /voice/call` — place a one-off **test call** to yourself.
- `GET  /voice/history` — recent calls placed to you.

### Where preferences live

No migration for prefs: they're stored in the existing `users.ai_settings` JSONB under a
`call` key, and the phone number in the existing `users.phone_number` column.

```jsonc
ai_settings.call = {
  "enabled": false,
  "triggers": { "item_found": true, "negotiation_done": true, "job_posted": false, "task_failed": false },
  "reminderDismissed": false
}
```

### Triggers → spoken message

Computed in `ai.py::_build_call_message`:

| Task outcome | Trigger | Example message |
|--------------|---------|-----------------|
| `find_service` found ≥1 result | `item_found` | "I found 3 options for a plumber…" |
| `negotiate` completed | `negotiation_done` | "I've finished negotiating…" |
| `post_job` created | `job_posted` | "Your job … is now posted…" |
| any task `failed` | `task_failed` | "I wasn't able to finish your request…" |

A call is only placed if: Twilio is configured **and** the user has a phone number **and**
`call.enabled` **and** that specific trigger is ticked.

---

## 4. Frontend changes

| File | What |
|------|------|
| `store/agentStore.ts` | New `VoiceSettings`/`CallPrefs`/`CallTriggers` types; `voiceSettings` state; `fetchVoiceSettings`, `updateVoiceSettings`, `placeTestCall` actions. |
| `components/agent/CallSettingsCard.tsx` | The **AI Settings** section: phone input + Save, master toggle, per-trigger checkboxes, "save us as a contact" hint, and a **test call** button. |
| `pages/AISettingsPage.tsx` | Renders `CallSettingsCard`. |
| `components/agent/CallReminderPrompt.tsx` | The dismissible **"Want a call when I'm done?"** nudge. Dismissal persists to `ai_settings.call.reminderDismissed`. |
| `components/DashboardLayout.tsx` | Mounts `CallReminderPrompt`. |

The reminder shows only when server-side calling is configured, the user hasn't set it up,
and hasn't dismissed it before.

---

## 5. Configuration

Add to `backend/.env` (see `.env.example`):

```env
TWILIO_ACCOUNT_SID=ACxxxxxxxx
TWILIO_AUTH_TOKEN=your_auth_token
TWILIO_FROM_NUMBER=+14787805138
TWILIO_VOICE_ENABLED=true
TWILIO_VALIDATE_SIGNATURE=true
TWILIO_VOICE=Polly.Joanna
PUBLIC_BASE_URL=https://your-backend.example.com
```

- **`PUBLIC_BASE_URL`** must be a URL Twilio's servers can reach (no trailing slash). Twilio
  fetches TwiML from `{PUBLIC_BASE_URL}/api/v1/voice/twiml/{token}`.
- **Local development:** `localhost` is not reachable by Twilio. Run
  `ngrok http 8000` and set `PUBLIC_BASE_URL` to the printed `https://…ngrok…` URL.
- If Twilio isn't fully configured, `settings.twilio_enabled` is `False`, the feature is a
  no-op, and the UI shows "Calling isn't switched on for this server yet."

### ⚠️ Security note on the credentials in this repo

The Auth Token pasted during setup is a **live secret**. It was written to `backend/.env`
(git-ignored) but was also exposed in chat, so **rotate it** in the
[Twilio Console](https://console.twilio.com) → *Account → API keys & tokens*, then update
`TWILIO_AUTH_TOKEN`. Rotating invalidates the exposed value and any signatures made with it.

---

## 6. Caller-ID / "save to contacts" strategy

You can't guarantee how a carrier displays your number, so the reliable play is to help users
recognise you:

1. **Consistent number.** Always call a given user from the **same** `TWILIO_FROM_NUMBER`.
   Rotating numbers breaks contact-saving and trips spam filters. (Enforced: the from-number
   is a single server setting.)
2. **Ask them to save it.** `CallSettingsCard` shows: *"Our calls come from {number}. Save it
   as 'Gigr AI'."* If you add SMS later, include the same line in the message body.
3. **Optional upgrade:** register the number with a CNAM / branded-calling program in Twilio so
   "Gigr" shows on supported carriers.

---

## 7. Manual test

1. Configure `.env` (with a real `PUBLIC_BASE_URL` / ngrok) and restart the backend.
2. In the app: **AI Settings → Phone Call Alerts** → enter your number → **Save**.
3. Toggle **Allow the AI to call me** on, tick a trigger, click **Send me a test call** — your
   phone should ring and speak the test message.
4. Run a real command (e.g. *"find a plumber for 5k"*). When it completes, you get the call and
   an "📞 Called you…" entry appears in the agent activity log.
