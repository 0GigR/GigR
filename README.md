# Gigr — AI-agent-powered local work, paid safely through PayPal

> Hire a plumber with a sentence. Your AI agent finds a verified local pro, prepares
> the PayPal checkout, and the money sits in **PayPal-backed escrow** until you say
> the work is done. An **AI arbiter** settles disputes. You always approve the money.

Built for the **PayPal AI Hackathon** — *Best Use of PayPal + AI* and *Agentic Commerce*.

**Live demo:** _set after deploying (see [Deploy on Render](#deploy-on-render))_ ·
**Walkthrough:** [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) ·
**PayPal setup:** [`docs/PAYPAL_SETUP.md`](docs/PAYPAL_SETUP.md)

---

## The problem

In the informal economy (plumbers, cleaners, tailors, repairmen) neither side trusts
the other. Clients fear paying for work that never happens; providers fear never
being paid. Cash-on-delivery and bank transfers give neither side recourse, and the
person with the least leverage (the provider) loses most often.

## What Gigr does

1. **Post or find work** on a hyper-local map, in plain language or by voice.
2. **Hire** — chat in a contract room, agree a price, amend scope when reality changes.
3. **Escrow through PayPal** — the client approves a PayPal payment; it is captured and
   held. The provider can start work knowing the money is real.
4. **Release** — the client releases it (or it auto-releases after the review window)
   and PayPal **pays the provider out**. Cancel or lose a dispute and PayPal **refunds**.
5. **Reputation that can't be faked** — every vouch is tied to a real, paid-out PayPal
   transaction.

## How PayPal is used (the core, not an add-on)

| Capability | PayPal API | Where |
|---|---|---|
| Client funds escrow | **Orders v2** (`CAPTURE`) + approval flow | `services/paypal_escrow.start_checkout / capture_checkout` |
| Escrow = captured payment | **Payments v2** captures | `Job.paypal_capture_id` |
| Release to provider | **Payouts v1** | `release_to_provider` |
| Cancel / dispute refund | **Payments v2 refunds** (full + partial) | `refund_to_client`, `split_escrow` |
| Safety net | **Webhooks** + signature verification | `api/v1/endpoints/payments.py` |
| Never double-charge | `PayPal-Request-Id`, unique `sender_batch_id` | `services/paypal_client.py` |

Plus: a per-job **payment ledger** (`payment_events`), a user **Payments** page and an
admin **AG Grid** ledger with live totals (held / captured / paid out / refunded).

## How AI is used

| AI feature | What it does | Money safety |
|---|---|---|
| **Agentic checkout** | The in-app agent (tool-calling LLM) and external agents (WebMCP, e.g. ChatGPT's browser) run the whole hire flow. `prepare_escrow_payment` creates the PayPal order and returns an approval link. | An agent **can never charge anyone** — the human approves in PayPal. |
| **AI arbiter** | On a dispute, an LLM reads the chat, scope amendments and work-submission record and recommends **release / refund / split %** with its reasoning and evidence gaps. | It only *recommends*; an admin applies it, and only then does PayPal move money. Chat text is fenced as untrusted data. |
| **Voice + negotiation agent** | Whisper voice commands, auto-reply, price negotiation within user-set autonomy levels and daily caps. | Autonomy policy has hard caps; payments are never autonomous. |
| **Neutral jury briefs** | Summarises each dispute for the neighbour jury. | Read-only. |

LLM: Groq (`openai/gpt-oss-120b`, Whisper large-v3-turbo) with key rotation and a
deterministic fallback when no key is set.

## Architecture

```mermaid
flowchart LR
  subgraph Client
    PWA[React PWA<br/>Vite · TS · Tailwind]
    AG[External AI agent<br/>WebMCP tools]
  end
  subgraph API[FastAPI]
    Jobs[Jobs / Escrow routes]
    Agent[Tool-calling agent<br/>+ autonomy policy]
    Arb[AI dispute arbiter]
    Hook[PayPal webhook]
  end
  PWA -->|REST/WS| API
  AG -->|acts as signed-in user| PWA
  Jobs --> PP[(PayPal<br/>Orders · Payments · Payouts)]
  Hook <-->|verified events| PP
  Agent --> Groq[(Groq LLM)]
  Arb --> Groq
  API --> DB[(PostgreSQL + PostGIS)]
```

### Escrow lifecycle

```mermaid
sequenceDiagram
  participant C as Client / their agent
  participant G as Gigr API
  participant P as PayPal
  participant V as Provider
  C->>G: fund job (or agent: prepare_escrow_payment)
  G->>P: create order (USD quote stored on the job)
  G-->>C: approval link
  C->>P: approves payment (human step)
  P-->>G: return + CHECKOUT.ORDER.APPROVED webhook
  G->>P: capture → job FUNDED (escrow)
  V->>G: submit work
  alt client releases / review window lapses
    G->>P: payout to provider's PayPal
  else cancel or dispute for client
    G->>P: refund capture
  else dispute split
    G->>P: partial refund + payout of remainder
  end
```

## Run it

### Judges: fastest path

Use the hosted demo (above), or run locally with the three commands below. You need
a free PayPal **sandbox** app — [`docs/PAYPAL_SETUP.md`](docs/PAYPAL_SETUP.md) takes ~10 minutes and
gives you test buyer/provider accounts.

### Local

Prerequisites: Python 3.11+, Node 20+, PostgreSQL 16 with PostGIS
(`docker run -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgis/postgis:16-3.4`).

```bash
# 1. backend
cd backend
python -m venv venv && source venv/bin/activate      # Windows: venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env                                  # then edit — see below
uvicorn app.main:app --reload --port 8000

# 2. frontend (new terminal)
cd frontend
npm install
echo "VITE_API_URL=http://localhost:8000/api/v1" > .env
npm run dev                                           # http://localhost:5173
```

Minimum `backend/.env`:

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/postgres
SECRET_KEY=any-long-random-string
ADMIN_SECRET=any-other-random-string
FRONTEND_URL=http://localhost:5173

PAYMENT_RAIL=paypal
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=...          # sandbox app credentials
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=...         # optional but recommended

GROQ_API_KEYS=...             # free at console.groq.com — enables the agent + AI arbiter
```

Everything else (Google sign-in, email, image uploads, push) is optional and the
feature simply stays off without its keys. Tables are created/migrated on startup.

### One switch: PayPal ⇄ Solana

`PAYMENT_RAIL` selects the money layer for the whole app. `paypal` (default) is
described above. `solana` restores the original on-chain USDC escrow
(`GIGR_PROGRAM_ID`, `SOLANA_RPC_URL`, `PLATFORM_KEYPAIR`, `WALLET_ENCRYPTION_KEY`,
`USDC_MINT_DEVNET` become required and are validated at boot).

The frontend reads the rail from `GET /api/v1/config/public`, so with `paypal`
**nothing Solana-related appears anywhere** — no wallet, no USDC, no cNFT badges — and
flipping the env var flips the UI with no rebuild. Each job remembers the rail that
funded it, so switching never strands money already in escrow.

### Tests

```bash
cd backend && pip install -r requirements-dev.txt
DATABASE_URL=... SECRET_KEY=x ADMIN_SECRET=y python -m pytest tests/unit   # no DB needed (41 tests)
python -m pytest tests                                                     # full suite, needs PostGIS
cd ../frontend && npm test                                                 # 44 tests (WebMCP tools etc.)
```

`tests/test_paypal_flow.py` drives the real API + DB against an in-memory PayPal fake
(approval-before-capture, idempotent capture/release, refund, split, webhooks).

## Deploy on Render

`render.yaml` is a Blueprint: Render → **New → Blueprint** → this repo. It provisions
PostGIS-capable Postgres, the API (Docker) and the static PWA. Then set the
`sync: false` variables (PayPal credentials, `FRONTEND_URL`, `VITE_API_URL`,
`GROQ_API_KEYS`) and add the PayPal webhook URL
(`https://<api>/api/v1/payments/paypal/webhook`).

## Repo map

```
backend/app/services/paypal_client.py   PayPal REST client (OAuth, retries, idempotency, webhooks)
backend/app/services/paypal_escrow.py   escrow: checkout → capture → payout / refund / split
backend/app/services/dispute_arbiter.py AI arbiter (recommend release / refund / split %)
backend/app/services/agent_tools.py     the agent's tools (incl. prepare_escrow_payment)
backend/app/api/v1/endpoints/payments.py config, webhook, ledgers
frontend/src/lib/webmcp/tools.ts        WebMCP tools for external agents
frontend/src/components/PaymentsLedger.tsx  AG Grid payments ledger
render.yaml                             one-click Render deploy
```

## Hackathon notes

**What's new for this hackathon** (the project existed before; PayPal + agentic commerce
were added from Oct 1, 2026): PayPal Orders/Payments/Payouts/Webhooks escrow rail and
payment ledger; the `PAYMENT_RAIL` switch with a rail-aware UI; agent
`prepare_escrow_payment`/`payment_status` tools and rail-aware WebMCP tools; the AI
dispute arbiter with split resolutions; AG Grid ledger; PayPal-anchored vouches;
Render blueprint; the `tests/unit` + `test_paypal_flow.py` suites.

**Honest limits.** The sandbox demo holds escrow in the platform's PayPal business
account; live multi-party payments would use PayPal's marketplace/partner products
(see the end of [`docs/PAYPAL_SETUP.md`](docs/PAYPAL_SETUP.md)). The AI arbiter is advisory by design.

**Tools used:** PayPal REST (Orders v2, Payments v2, Payouts v1, Webhooks), Groq
(gpt-oss-120b, Whisper), AG Grid Community, Render, WebMCP, FastAPI, React, PostGIS.

## License

[MIT](LICENSE)
