# Devpost submission — PayPal AI Hackathon

> Paste/adapt each section into the matching Devpost field. Fill the three
> `<<…>>` placeholders after you deploy and record the video.

**Project name:** Gigr
**Tagline:** An AI agent that hires local help for you — with the money held safely in PayPal escrow until the work is done.

---

## Inspiration

In the informal economy — plumbers, cleaners, tailors, repairmen — neither side
trusts the other. Clients fear paying for work that never happens; providers fear
never being paid. There is no recourse for either, and the less powerful side
(the provider) loses most often. Escrow fixes this, but escrow means holding other
people's money — so it has to be boringly safe, and fully explainable.

## What it does

Gigr is a hyper-local services marketplace where **PayPal is the escrow and an AI
agent runs the legwork**.

1. You say *"find me a verified plumber near me and hire them."* The agent searches
   nearby providers (PostGIS), checks their trust record, and opens a contract room.
2. When you agree a price, the agent **prepares the PayPal checkout** and hands you
   an approval link. **You approve it in PayPal** — the agent can never charge you.
3. The payment is captured and **held in escrow**; the provider sees the funds are
   real and starts work.
4. You release it (or it auto-releases when the review window lapses) and Gigr
   **pays the provider out via PayPal Payouts**. Cancel, or win a dispute, and the
   capture is **refunded**.
5. If it goes wrong, an **AI arbiter** reads the chat, scope changes and
   work-submission record and recommends *release / refund / split %*. A human
   admin applies it — and PayPal executes a partial refund plus a payout.
6. Every vouch is anchored to the real PayPal payout that paid for the job, so
   reputation can't be faked.

## How we built it

- **PayPal (central):** Orders v2 (checkout + approval), Payments v2 (capture &
  full/partial refunds), Payouts v1 (provider payment), Webhooks with signature
  verification (`CHECKOUT.ORDER.APPROVED`, `PAYMENT.CAPTURE.*`, `PAYOUTS-ITEM.*`).
  Every money call is idempotent (`PayPal-Request-Id` / unique `sender_batch_id`);
  the USD amount is quoted once per job so release/refund never re-convert.
  A `payment_events` ledger records every step.
- **AI:** Groq `gpt-oss-120b` tool-calling agent (search, hire, negotiate within
  user-set autonomy caps, `prepare_escrow_payment`, `payment_status`); the AI
  dispute arbiter (structured JSON → validated into a closed set of outcomes,
  untrusted chat text fenced as data); Whisper voice commands.
- **Agentic commerce:** the same flow is exposed to *external* agents (e.g. ChatGPT's
  browser) as WebMCP tools — `fund_escrow` returns a PayPal approval link
  (`requires_human_approval: true`), `get_payment_status` reports the ledger.
  Money-moving tools only exist while the user is signed in.
- **Stack:** FastAPI + PostgreSQL/PostGIS, React PWA, **AG Grid** payments ledger,
  deployed with a **Render** blueprint.
- **One switch:** `PAYMENT_RAIL=paypal|solana`. The original Solana escrow still
  works behind the flag; with `paypal` the UI shows no wallets/USDC at all.

## Challenges

- **Idempotency under races:** a browser return, a webhook and an agent retry can
  all try to capture the same order. Capture/payout/refund keys + a unique webhook
  event id make each effect happen once (covered by tests).
- **NGN isn't settleable on PayPal:** prices are stored in Naira, so we quote USD
  once at checkout, store it, and use that exact figure for release and refund.
- **Keeping the model away from the money:** the arbiter only *recommends*; agents
  only *prepare*. Both are validated server-side and a human is the last step.

## Accomplishments we're proud of

- A complete, working escrow loop on PayPal: fund → capture → payout / refund /
  split, with webhooks as a safety net.
- Agentic checkout that is genuinely human-in-the-loop, not a demo trick.
- 41 DB-free unit tests + a full-stack PayPal flow test + 44 frontend tests.

## What we learned

PayPal's Orders → Capture → Payouts/Refund primitives map cleanly onto escrow, and
idempotency keys are the difference between a demo and something you'd trust with
money.

## What's next

PayPal Commerce Platform / partner onboarding for live multi-party payouts,
milestone (partial) releases, and a dispute-evidence upload step for the arbiter.

## Built with

`paypal-orders-v2` `paypal-payments-v2` `paypal-payouts` `paypal-webhooks` `groq`
`gpt-oss-120b` `whisper` `webmcp` `fastapi` `postgresql` `postgis` `react`
`typescript` `ag-grid` `render` `tailwindcss` `vite`

## Try it

- **Hosted demo:** <<https://… your Render URL …>>
- **Code:** <<https://github.com/GunroarCannon/… public repo URL …>> (MIT)
- **Video (<3 min):** <<YouTube URL>> — script in [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md)
- **Run it yourself:** README → *Run it*; sandbox PayPal setup in
  [`docs/PAYPAL_SETUP.md`](docs/PAYPAL_SETUP.md).

### Test credentials for judges

Create two Gigr accounts on the demo (client + provider). Use the sandbox PayPal
personal accounts listed here — <<paste sandbox buyer email/password and provider
email>> — the buyer approves checkout, the provider's email goes in *Profile →
Payments*. (Sandbox only — no real money.)

## Tools used (submission field)

| Tool | How it's used |
|---|---|
| PayPal REST (Orders, Payments, Payouts, Webhooks) | The entire escrow: fund, hold, pay out, refund, split, confirm |
| Groq `gpt-oss-120b` | Tool-calling agent; AI dispute arbiter; neutral jury briefs |
| Groq Whisper large-v3-turbo | Voice commands |
| WebMCP | Exposes the hire → fund → release flow to external AI agents |
| AG Grid Community | Payments ledger (admin totals + per-user history, CSV export) |
| Render | Hosting via `render.yaml` blueprint |

## How the project was significantly updated during the hackathon

Gigr existed before Oct 1, 2026 as a Solana-escrow marketplace. During the
submission period we added: the PayPal escrow rail (Orders/Payments/Payouts/
Webhooks) and `payment_events` ledger; the `PAYMENT_RAIL` switch with a rail-aware
UI; agent tools `prepare_escrow_payment` / `payment_status` and PayPal-aware WebMCP
tools; the AI dispute arbiter and split resolutions; PayPal-anchored vouches; the
AG Grid ledger and Payments page; Render blueprint; and the unit + flow test suites.
