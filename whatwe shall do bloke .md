## Completed tasks (from the GigR Stabilization Task List)

| # | Status |
|---|--------|
| **C1** (background emails) | Done |
| **C2** (button idempotency – Jobs + Activity) | Done |
| **H1** (separate Cancelled tab) | Done |
| **H2** (Start Working button) | Done |
| **H4** (assigned jobs hidden from Open) | Done |
| **H5** (loading feedback on buttons) | Done (via pending props) |
| **M1** (confirmation dialogs) | Done |
| **M5** (in‑app notification on service request) | Done (auto‑message via WebSocket) |

---

## What's left (priority order)

| # | Issue | Priority |
|---|-------|----------|
| **Dispute/Jury** | Money stuck; jury page empty; no notification; no resolution flow | **Critical – next** |
| **C3** | Duplicate prevention at API level (backend 409) | High |
| **M2** | Wallet balance auto‑refresh | High |
| **H3** | Timestamps on messages and cards | Medium |
| **M3** | Services search debounce | Medium |
| **M4** | Profile vouches with job context | Medium |
| **L1–L5** | Polish | Low |
| **W1–W2** | Onramp & wallet history | Low |

---

## What's wrong with disputes right now

1. **No jury notification** – when a dispute is created, jurors are not automatically selected or notified.
2. **No jury page** – there's a `/disputes/my-jury` endpoint (your teammate added it), but no frontend page to show it.
3. **No resolution flow** – after a jury votes, the escrow is not released/refunded automatically on‑chain.
4. **No way to withdraw a dispute** – if the parties resolve it themselves, the escrow stays locked.

---

## What we need to build (minimal for demo)

1. **Jury selection** – when a dispute is raised, the backend automatically selects 3–5 jurors from the same neighborhood with good reputation (already partially implemented in the backend).
2. **Jury notification** – send an email and an in‑app notification to selected jurors.
3. **Jury voting page** – a simple page where jurors see the dispute details and vote "Refund" or "Pay".
4. **Auto‑resolution** – once a majority is reached, the backend automatically calls `release_escrow` or `cancel_escrow`.
5. **Withdraw dispute** – allow either party to cancel the dispute before voting starts (if they resolve it themselves).
