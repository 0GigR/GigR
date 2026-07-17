# AI Agent — How It Works

This document explains the AI/agent layer end-to-end: how a natural-language command
becomes a completed action, where Groq fits in, and — importantly — **how to tell
whether Groq is actually being used or silently falling back to regex.**

Everything AI-related lives in one file: `backend/app/api/v1/endpoints/ai.py`.

---

## 1. The big picture

```
User types a command  ("post a job for a plumber, 5k")
        │
        ▼
POST /api/v1/ai/command          ← creates an AgentTask row (status="pending")
        │
        ▼
parse_command(text)              ← turns text into structured intent
        │   ├── _parse_command_groq()   (PRIMARY — Groq Llama-3)
        │   └── _parse_command_rules()  (FALLBACK — regex, no network)
        ▼
AgentTask saved with task_type + params
        │
        ▼
agent_loop()  (background coroutine, polls every N seconds)
        │
        ▼
_execute_task()  → dispatches on task_type to a handler:
        find_service · find_job · post_job · post_service ·
        negotiate · pay · reply_message · navigate
        │
        ▼
Handler does the work, writes AgentLog rows, sets task.result + status="completed"
        │
        ▼
Frontend polls GET /ai/tasks/{id} (and /ai/logs) to show progress
```

Two independent "brains" appear in this flow, and it's worth being clear they are
**separate**:

| Concern | Function | Model call |
|---------|----------|------------|
| Understanding the command (intent + params) | `parse_command` → `_parse_command_groq` | Groq |
| Writing a clean job/service title + description | `_groq_improve_posting` | Groq |
| Suggesting a fair price | `_suggest_price` | Groq |

If Groq is down/misconfigured, **all three** fall back to regex/rules. That's why a
single bad `GROQ_MODEL` makes the whole agent feel "dumber" at once.

---

## 2. NLP layer — how a command is parsed

### Primary path: Groq (`_parse_command_groq`, line ~120)

- Uses the keys from `settings.groq_keys_list` (from `GROQ_API_KEY` and/or the
  comma-separated `GROQ_API_KEYS`). Multiple keys = automatic failover on rate limits
  (`_call_groq_with_fallback`, line ~84).
- Sends `_GROQ_SYSTEM_PROMPT` (line ~56) which instructs the model to return **only**
  a JSON object: `{ task_type, params, response }`.
- Model is `settings.GROQ_MODEL`. **This must be a model Groq currently serves** — see §5.

### Fallback path: rules (`_parse_command_rules`, line ~218)

- Pure regex. No network. Always available.
- Detects verbs (`post/create/find/negotiate/pay…`), extracts a price
  (`_extract_price`, handles `5k`, `₦5,000`, "five thousand"), and a title.
- Deliberately conservative — it's a safety net, not a replacement.

### The switch (`parse_command`, line ~346)

```python
groq_result = await _parse_command_groq(enriched)
if groq_result and groq_result.get("task_type"):
    return groq_result          # Groq understood it
return _parse_command_rules(text)   # fall back
```

**Key point:** the fallback is *silent by design* — if Groq errors, the `except` logs a
warning and returns `None`, and the user still gets an answer from regex. Great for
uptime, terrible for noticing that Groq has been broken for a week. §4 fixes that.

---

## 3. Execution — how intent becomes action

- `agent_loop()` (line ~1608) runs as a background asyncio task, polling the DB for
  `pending` tasks every `AI_AGENT_POLL_INTERVAL_SECONDS` (default 30s), up to
  `AI_AGENT_MAX_CONCURRENT_TASKS` at once.
- Each task is run by `_execute_task()` (dispatch at line ~1353), which routes on
  `task_type` to the matching handler. Handlers are all `async` and inline in the file.
- Handlers write progress to `AgentLog` via `_log(...)`, which the frontend streams.
- `post_job` / `post_service` additionally call `_groq_improve_posting` to turn the raw
  command into a clean title + description (see `voice-calls-twilio.md`'s sibling logic
  and the title-cleaning notes).

### API routes (all under `/api/v1`)

| Route | Purpose |
|-------|---------|
| `POST /ai/command` | Submit a command → creates a task |
| `GET /ai/tasks` | List your tasks |
| `GET /ai/tasks/{id}` | One task + status/result |
| `DELETE /ai/tasks/{id}` | Cancel a task |
| `POST /ai/tasks/{id}/respond` | Answer an agent prompt (e.g. provide a price) |
| `GET /ai/logs` | Recent agent log lines |

---

## 4. Is Groq working, or is it always falling back?

This was the hard question, because the fallback is silent and the logs are noisy.
There is now a **one-command health check** that answers it definitively — no log
scraping, no browser devtools.

```bash
cd backend
python scripts/check_groq.py
```

It checks three things **in order** and stops at the first failure, so you know exactly
where the break is:

1. **Is a key configured?** (else it will *always* use rules)
2. **Live API ping** — does the key authenticate, and is `GROQ_MODEL` still alive?
   Distinguishes the three failure modes that look identical from the app:
   - `401/403` → key rejected (rotate the key)
   - `400 … decommissioned` → the model was retired (change `GROQ_MODEL`, see §5)
   - `429` → rate limited (key is fine, just throttled)
3. **End-to-end `parse_command()`** — proves Groq actually parsed a real command
   rather than the regex fallback catching it.

Test a specific command:

```bash
python scripts/check_groq.py "post a job for a plumber, 5k"
```

List the models your key is allowed to use:

```bash
python scripts/check_groq.py --models
```

**Healthy output looks like:**

```
== Groq configuration
[OK] 1 key(s) configured. Model = llama-3.1-8b-instant
== Live API ping
[OK] HTTP 200 - reply: 'Pong'
== End-to-end parse_command()
[OK] Groq parsed it -> task_type='post_job', params={'title': 'plumber', 'price': 5000}
[OK] Groq IS being used.
```

### Quick manual signal (no script)

Groq and rules produce recognisably different output for the same input. Groq cleans
the title (`"pijama makers"`); rules tend to echo more of the raw phrasing. If job
titles suddenly look like raw sentences again, suspect Groq is down and run the check.

---

## 5. Choosing a Groq model (and the gotcha that bit us)

**Groq retires models regularly.** When a model is decommissioned, every call returns
`HTTP 400 model_decommissioned`, the agent swallows it, and you silently drop to regex —
with *nothing obvious* in the app. This is exactly what happened with the old default
`llama3-8b-8192`.

- Current working default: **`llama-3.1-8b-instant`** (free, fast, 8B — direct successor).
- Bigger/smarter option: `llama-3.3-70b-versatile` (still free tier, slower).
- Always confirm with `python scripts/check_groq.py --models` — it lists exactly what
  *your* key can call today.

Set it in `backend/.env`:

```env
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.1-8b-instant
```

Restart the backend after changing `.env` (it's only read at startup).

---

## 6. Configuration reference

```env
# One key, or many (comma-separated) for rate-limit failover:
GROQ_API_KEY=gsk_xxxxxxxx
GROQ_API_KEYS=gsk_key1,gsk_key2        # optional, additive
GROQ_MODEL=llama-3.1-8b-instant        # MUST be a currently-served model
GROQ_WHISPER_MODEL=whisper-large-v3-turbo   # for voice-command transcription

AI_AGENT_ENABLED=true
AI_AGENT_POLL_INTERVAL_SECONDS=30
AI_AGENT_MAX_CONCURRENT_TASKS=5
AI_AGENT_TASK_TIMEOUT_SECONDS=300
```

Leaving all Groq keys blank is valid — the agent runs entirely on the rule-based
parser. It's just less flexible with unusual phrasings.

---

## 7. TL;DR troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Titles look like raw sentences | Groq falling back to rules | `python scripts/check_groq.py` |
| "AI feels dumb" all of a sudden | `GROQ_MODEL` decommissioned | `--models`, update `.env`, restart |
| Nothing happens on a command | agent loop not running / task stuck | check `AI_AGENT_ENABLED`, `/ai/logs` |
| Works then stops after a while | rate limited (429) | add a 2nd key to `GROQ_API_KEYS` |
