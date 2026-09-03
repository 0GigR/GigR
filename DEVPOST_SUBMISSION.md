# Devpost submission — copy-paste text description

> Paste/adapt the sections below into the Devpost "Description" field.
> Keep it under ~400 words for readability.

---

## Gigr — Verifiable Trust for Local Work, now agent-native

**The problem.** In hyper-local services markets (plumbers, cleaners, repairmen), neither side trusts the other. Clients fear paying for work never done; providers fear never getting paid. Gigr solves this with on-chain escrow — money is locked in a Solana escrow until work is done — and with verifiable reputation minted as on-chain NFTs after every completed job.

**Why this is a strong fit for WebMCP.** Hiring someone is a *multi-step, judgement-heavy* task: find a real nearby provider, verify their trust record, agree a price, hold the money safely, and release it only when the work is right. Today all of that means clicking through maps, profiles, ratings and wallets. With WebMCP, an agent does the legwork while the human keeps control of the decisions that matter.

**What people and agents can now do together that was impossible before.** An agent browsing Gigr can:
- `get_user_location` — get the user's location automatically, never needing to ask for an address,
- `search_providers` — find real local providers ranked by proximity (PostGIS),
- `get_provider_reputation` — pull a provider's *verifiable* on-chain vouch record before hiring, not just a star rating,
- `post_job` — turn "fix my sink" into a live job listing with budget and category,
- `fund_escrow` and `release_escrow` — actually move USDC into and out of the on-chain escrow on the user's behalf,
- `accept_job`, `send_message`, `list_my_jobs`, `get_job_status`, `get_notifications` — run the whole two-sided job lifecycle.

So the demo story an agent can now complete end-to-end is: *"find me a verified plumber near me, hire them, and hold the money in escrow until the job is done — then pay them."* The human stays in the loop for sign-in and final release.

**How we implemented WebMCP.** Gigr exposes 14 tools via the WebMCP imperative API — `document.modelContext.registerTool(def, { signal })`. Each tool's `execute` runs in the user's already-authenticated tab and reuses the app's existing API layer, so an agent acts as the signed-in user with **no separate agent login**. Sensitive tools (`fund_escrow`, `release_escrow`, `post_job`, …) are only *registered* while the user is signed in — on a signed-out session an agent literally never sees them (registration is torn down via the tool's AbortSignal on logout). `fund_escrow`/`release_escrow` drive the real Solana escrow smart contract (USDC on devnet); reputation reads come from on-chain cNFT vouches.

**Live URL:** https://gigrr.vercel.app — open in ChatGPT's in-app browser or Chrome with WebMCP enabled, then ask the agent to find a provider or post a job.
