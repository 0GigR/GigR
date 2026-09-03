# Gigr — WebMCP tools for agents

Gigr exposes an **agent-native interface** through [WebMCP](https://docs.mcp-b.ai): a set of structured tools an AI agent (e.g. ChatGPT's in-app browser, or Chrome with `chrome://flags/#enable-webmcp-testing`) can call directly inside the Gigr web app. An agent can now do things that were previously only possible by hand — **find a real local provider, verify their on-chain reputation, hire them, fund a Solana escrow on the user's behalf, and release the money when the work is done.**

| File | What it is |
|---|---|
| `frontend/src/lib/webmcp/tools.ts` | The 14 tool definitions (name, description, JSON input schema, `execute`). Pure & dependency-injected. |
| `frontend/src/lib/webmcp/registry.ts` | Registers/unregisters tools as the auth state flips, using WebMCP's AbortSignal lifecycle. |
| `frontend/src/lib/webmcp/index.ts` | Wires the tools to the real app (axios + zustand auth store + `document.modelContext`) and exports `initWebMCP()`. |
| `frontend/src/lib/webmcp/webmcp.test.ts` | Unit tests (`npm test`). |
| `frontend/src/main.tsx` | Calls `initWebMCP()` once at boot. |

## Why there is no "agent login"

WebMCP tools **execute inside the user's already-open, already-authenticated tab**. Each `execute` reuses Gigr's existing axios client, which sends the same HttpOnly cookie / Bearer token the signed-in user already has. So an agent calling a tool *is* the logged-in user — there is no separate service account, no OAuth flow for the agent to solve.

What we *do* gate is **exposure**:

- **Signed out** → an agent only sees browsing tools (`get_auth_status`, `get_user_location`, `search_providers`, `get_provider_reputation`).
- **Signed in** → every tool is registered.

The sensitive tools (`fund_escrow`, `release_escrow`, `post_job`, …) are **not merely runtime-checked** — on a logged-out session they are never in the tool list at all. The registry keeps one `AbortController` per tool and aborts it the moment the user signs out (WebMCP has no `unregisterTool`; a tool dies when its registration `AbortSignal` fires). Each gated `execute` also double-checks auth as defence in depth. There is deliberately **no attempt to automate the Google OAuth popup** — that stays a human-in-the-loop moment by design.

## The tools

All prices are in **Nigerian Naira (₦)**. The escrow transaction itself converts to USDC on-chain. Every tool returns a JSON object; failures return `{ ok: false, error: "…" }` with an agent-readable reason.

### Always available (signed out)

| Tool | Input | What it does | Backend |
|---|---|---|---|
| `get_auth_status` | — | Reports whether the user is signed in, who they are, and which tools sign-in unlocks. **Call first.** | local |
| `get_user_location` | — | **Gets the user's location automatically so the agent never has to ask** — saved Gigr profile location, else browser GPS. Feeds `search_providers`/`post_job`. | `GET /users/me` • browser Geolocation |
| `search_providers` | `category` / `query`, `latitude`, `longitude`, `radius_km`, `limit` | Finds providers & their service listings to hire. With lat/lon the results are PostGIS proximity-ranked. Each result is enriched with the provider's name, verification and reputation snapshot. | `GET /services/search/nearby` • `GET /services/search/text` • `GET /users/{id}` • `GET /categories` |
| `get_provider_reputation` | `provider_id`, `max_vouches` | A provider's verifiable trust record: star-rating average/count **plus** the number of on-chain verified vouches (cNFTs minted after completed jobs) with their NFT + transaction ids. | `GET /users/{id}` • `GET /vouches/user/{id}` |

### Available after sign-in

| Tool | Input | What it does | Backend |
|---|---|---|---|
| `post_job` | `title`, `description`, `price`, `category`, optional `min_price`/`max_price`/`lat`/`lon` | **Client side:** creates a hiring job listing (status `open`); matching nearby providers get notified. Use this when the user wants to HIRE someone. | `POST /jobs/` |
| `post_service` | `title`, `price`, `category`, `latitude`, `longitude`, optional `description`/range/`radius_km` | **Provider side — "hire me".** Publishes a service the user OFFERS so clients can find and hire them (opposite of `post_job`). Call `get_user_location` for the coordinates. | `POST /services/` |
| `get_job_status` | `job_id` | Current job state plus the **next sensible action** an agent should take. | `GET /jobs/{id}` |
| `list_my_jobs` | `role` (`client`/`provider`), optional `status` | The user's own jobs, to decide which to fund/release/message. | `GET /jobs/?my=…` |
| `fund_escrow` | `job_id` | **Moves real USDC into the on-chain escrow** for an assigned job (client only). Idempotent. Refuses with a clear reason if the job has no hired provider. | `GET /jobs/{id}` + `POST /jobs/{id}/fund` |
| `release_escrow` | `job_id` | Releases the escrow so the provider gets paid (client only). No-op with explanation if already completed. | `GET /jobs/{id}` + `POST /jobs/{id}/release` |
| `accept_job` | `job_id` | Provider side: accepts a requested service request so the client can fund. | `GET /jobs/{id}` + `POST /jobs/{id}/accept-request` |
| `send_message` | `job_id`, `content` | Posts into the job's Contract Room chat (client ↔ provider). | `POST /messages/` |
| `get_notifications` | — | Latest notifications with read state + unread count. | `GET /notifications` |
| `set_display_currency` | `code` (`USD`/`GBP`/`EUR`) | Switches the currency Gigr *displays* prices in (default NGN). Display-only — stored & settled amounts are always Naira. Reloads the app. | local preference |

## The escrow state machine the agent navigates

```
open ──(client assigns a provider)──▶ assigned ──(client funds)──▶ funded
  ▲                                    │                            │
  └── provider applies / client hires  │              provider submits work
                                        ▼                            ▼
  requested ──(provider accepts_job)──▶ assigned          in_progress
                                                             │ client releases
                                                             ▼
                                                          completed  (provider paid)
```

`get_job_status` returns a human/agent readable `next_actions` line for each state, so the agent never has to guess the state machine. Because `fund_escrow` requires a **hired** provider, a realistic full-loop demo uses two roles: a **client agent** that finds, verifies and hires, and a **provider agent** that accepts and works — the whole point of a two-sided marketplace.

## Example agent flows

**Client: "hire a plumber near me and hold the money safely"**
1. `get_user_location()` → coordinates, no questions asked
2. `search_providers({ category: "Plumbing", latitude, longitude, radius_km: 10 })`
3. `get_provider_reputation({ provider_id })` → pick someone with a solid on-chain vouch count
4. Hire (request their service) → provider's agent runs `accept_job`
5. `fund_escrow({ job_id })` → USDC locked in escrow
6. Provider does the work → provider marks it submitted
7. `release_escrow({ job_id })` → provider paid, job `completed`
8. `send_message({ job_id, content })` to confirm scope along the way

**Provider: "get me hired — I want to offer piano lessons"**
1. `get_user_location()` → coordinates
2. `post_service({ title: "Piano lessons for beginners", price: 15000, category: "Music", latitude, longitude })` → your "hire me" listing is live
3. `list_my_jobs({ role: "provider", status: "requested" })` → clients who requested your service
4. `accept_job({ job_id })` → start work once they fund

**Provider: "what do I have to accept today?"**
1. `list_my_jobs({ role: "provider", status: "requested" })`
2. `accept_job({ job_id })` for each
3. `get_job_status({ job_id })` to watch for funding, then do the work.

**Preferences: "show me prices in dollars"**
- `set_display_currency({ code: "USD" })` — display-only; stored/escrowed amounts stay Naira (₦). Also settable from the currency picker in the dashboard header.

## Testing

```bash
cd frontend
npm test          # vitest — unit tests over tools.ts + registry.ts
npm run build     # tsc typecheck + Vite build (runs in CI)
```

The tests prove the two behaviours that matter for WebMCP:
- **tools.ts** — every `execute` calls the right API endpoint with the right payload, shapes its output for an agent, and blocks payment tools while signed out.
- **registry.ts** — only public tools exist on a signed-out session; signing in registers the rest; signing out **aborts their AbortSignals** (unregistering them); signing back in re-registers.

## Try it live

1. Open the deployed Gigr app in **ChatGPT's in-app browser** (WebMCP on by default), or Chrome with `chrome://flags/#enable-webmcp-testing`.
2. Ask the agent to "find a plumber nearby and show me their reputation", "post a job to fix my sink for ₦15,000", or — after signing in — "fund the escrow for job X".
3. Watch it call the tools and report back. Signed out, the agent can browse but cannot see payment tools.

## Deliberately skipped (for now)

- **`dispute_job`** — a compelling "impact" story but real scope; it's the natural next tool (jobs already have a full dispute flow).
- **`upload_job_photo`** — binary upload through an agent tool is heavy engineering for little judging value.
- **Automating Google OAuth** — cross-origin OAuth popups are a human-in-the-loop step WebMCP can't (and shouldn't) drive.
