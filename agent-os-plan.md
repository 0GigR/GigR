# Gigr Agent OS — Build Plan

## Current State Audit

### What exists today

**Backend (`/backend/app/api/v1/endpoints/ai.py` — 2,632 lines)**

- NLP layer: Groq Llama-3 primary, regex rule-based fallback
- Task types: `find_service`, `find_job`, `negotiate`, `post_job`, `post_service`, `navigate`, `pay`, `reply_message`, `generic`
- Haversine proximity filter on search results
- Memory: stored in `user.ai_settings.memory` (last_search, usual prices)
- Proactive hunting: background loop (`AI_AGENT_PROACTIVE_INTERVAL_SECONDS = 900`)
- Auto-negotiation: creates a job + sends opening offer message
- Price suggestion: Groq asked for fair Naira rate, auto-posts after 10s timeout
- Twilio voice calls with per-trigger preferences
- Agent loop: polls DB every N seconds, max concurrent tasks configurable

**Frontend (`/frontend/src/`)**

- `agentStore.ts`: Zustand store with tasks, unreadCount, polling, WS push, AI settings, voice settings
- `AgentActivityPanel.tsx`: slide-in panel showing task history + logs
- `AgentBell.tsx`: notification bell with badge
- `VoiceAssistant.tsx`: floating mic button + popup, text + voice input
- `AISettingsPage.tsx`: autonomy level, voice toggle, call preferences
- `MapExplorer.tsx` and `NeighborhoodMap.tsx`: Leaflet maps (OSM tiles)
- `webmcp/tools.ts`: browser-side tool registry (navigate, search, open_item)
- `geo.ts`: frontend geolocation wrapper

**Feature flag pattern (backend config)**

- `AI_AGENT_ENABLED`, `AI_AGENT_PROACTIVE_ENABLED`, `AI_AUTONOMOUS_PAYMENT_ENABLED`
- `TWILIO_VOICE_ENABLED`, `NUDGE_ENABLED`
- Pattern: env var -> `Settings` field -> injected via `require_ai_enabled` dependency

**Gaps and weaknesses**

- Agent panel has no map view — results are text-only cards
- No multi-step conversational context (single command -> single task, no memory of prior exchange in same session)
- No agent reasoning transparency (user cannot see why the agent did something)
- `webmcp/tools.ts` has tools but no agent actually calls them from the backend — it is an unused bridge
- No proactive surface in the UI (user must open the panel to know the agent did something)
- Voice input is a floating button — not integrated into the panel or the command flow
- Autonomy levels exist in the store but only `negotiate` checks them on the backend
- No visual hierarchy in the agent panel — all log entries look the same
- Map and agent are completely disconnected — no live pins, no "show me on map"
- No streaming of agent thoughts — user stares at a spinner

---

## Feature Flag Strategy

All new agent features gated behind `FEATURE_AGENT_*` env vars. Pattern:

```
FEATURE_AGENT_MAP_RESULTS=true
FEATURE_AGENT_STREAMING=false
FEATURE_AGENT_MULTI_TURN=true
FEATURE_AGENT_PROACTIVE_SURFACE=true
FEATURE_AGENT_SMART_APPLY=false
FEATURE_AGENT_PLANNER=false
FEATURE_AGENT_PREMIUM=false
```

Frontend reads from `import.meta.env.VITE_FEATURE_*`.

All flags default to `true` (open) now. Setting `FEATURE_AGENT_PREMIUM=true` activates paywall checks. Security controls (auth, rate limits) are never gated behind flags.

---

## Phase 1 — Intelligence Upgrades

### 1.1 Multi-turn conversational context

**Problem:** every command is stateless. "Find a plumber" then "make it cheaper" fails.

**Plan:**
- Backend: session context stored in `agent_task.params.session_context` (array of last 5 exchanges)
- Frontend: `agentStore` tracks `activeSessionId`. Each new command from the same open session passes the `session_id`
- NLP system prompt gains a `[session history]` block injected before the user message
- Agent resolves pronouns ("make it cheaper", "cancel that") against session context

**Files:** `ai.py` (parse_command, new session store), `agentStore.ts`, `VoiceAssistant.tsx`
**Feature flag:** `FEATURE_AGENT_MULTI_TURN`

### 1.2 Reasoning transparency

**Problem:** user sees a spinner, then a result card. No insight into what happened.

**Plan:**
- New `AgentLog` level: `think` (internal reasoning step, shown in lighter style)
- Backend writes `think` entries before each action: "Checking 23 providers in Lagos...", "Price above budget, filtering..."
- Frontend: `think` entries render as small muted text, collapsed by default, expandable per-task

**Files:** `ai.py` (log calls), `AgentActivityPanel.tsx`
**Feature flag:** `FEATURE_AGENT_REASONING_VISIBLE`

### 1.3 Autonomy capability matrix

**Problem:** only `negotiate` checks `autonomyLevel`. `find_service` can auto-request without user enabling medium+ autonomy.

**Capability matrix:**

| Action | Min autonomy |
|---|---|
| Search only | off |
| Auto-navigate | off |
| Auto-negotiate message | medium |
| Auto-apply to job | high |
| Auto-request service | high |
| Proactive hunt | total |

- Backend checks matrix before every action. If blocked, logs a helpful message with what setting to enable.

**Files:** `ai.py`, `agentStore.ts`

### 1.4 Memory enrichment

**Extend memory schema:**
- `preferred_categories: string[]`
- `location_name: string` (human readable, e.g. "Lekki Phase 1")
- `price_sensitivity: 'low' | 'mid' | 'high'` (derived from past searches)
- `last_active_job_id: string`

Backend derives and updates on every task completion. NLP enrichment block gets richer hints.

**Files:** `ai.py` (_load_memory, _save_memory, parse_command)

---

## Phase 2 — Agent OS Shell (UI)

The agent needs a command center feel — not a side panel. Think macOS Spotlight meets Perplexity meets Google Maps.

### 2.1 Command Palette

**Visual concept:** centered, fullscreen-overlay command palette. Dark glass morphism. Activated by `Cmd/Ctrl+K`, the mic button, or the bell.

**Layout:**
```
[mic]  Type or speak a command...          [send]
-------------------------------------------------
RECENT                      SUGGESTIONS
Find plumber for 5k         "Find a cleaner near you"
Post job: fix my AC         "Check your active jobs"
```

- Input is a single field with inline voice waveform visualizer while listening
- Real-time completions from previous commands and common patterns
- Results appear inline below, streaming in
- Keyboard navigable

**Files:** new `components/agent/CommandPalette.tsx`, update `VoiceAssistant.tsx` to delegate to it
**Feature flag:** `VITE_FEATURE_AGENT_COMMAND_PALETTE`

### 2.2 Agent Activity Panel — redesign

**Task card states:**

```
[RUNNING]  Find plumber near me             2s ago
  > Checked 14 providers in Lagos
  > Filtering by budget (max 10k)...
  [spinner]

[DONE]  Posted: "Shoelace Tying Assistant"  5m ago
  > Job is live. 0 applicants so far.
  [View Job]  [Share]

[PENDING]  Which service do you want?
  > Emeka's Plumbing  -- 8,000
  > Tunde Repairs     -- 9,500
  [Select]  [Post job instead]
```

**Design tokens:**
- `running`: amber left border, pulsing dot
- `done/success`: green left border, check
- `failed`: red left border
- `pending`: violet left border, pulsing ring
- Log entries appear with a 50ms stagger animation

**Files:** `AgentActivityPanel.tsx`

### 2.3 Inline Map Results

When agent finds services or jobs, it renders them on a mini map inside the agent panel — not just text cards.

- `AgentLog` entries with `render_type: "service_cards"` carry lat/lng (backend change adds these)
- New `components/agent/AgentResultMap.tsx` — compact Leaflet map (250px tall) embedded in the log entry
- Provider pins are custom SVG markers
- Selected pin triggers `select_service:<id>` dialog response automatically
- "Show on full map" button opens `MapExplorer` with the same pins

**Backend change:** `service_cards` data in `_handle_find_service` adds `latitude`, `longitude` fields.

**Files:** new `components/agent/AgentResultMap.tsx`, `ai.py`, `AgentActivityPanel.tsx`
**Feature flag:** `VITE_FEATURE_AGENT_MAP_RESULTS`

### 2.4 Live agent status bar

- Thin 4px bar at the top of the dashboard (below nav)
- Running tasks: violet-to-indigo gradient sweep animation
- Completed: flashes green for 2s, disappears
- Failed: red for 3s
- Clicking opens agent panel

**Files:** new `components/agent/AgentStatusBar.tsx`, `DashboardLayout.tsx`

### 2.5 Proactive agent toast

- Slides in from bottom-right when a proactive task completes
- "Your agent found 3 plumbers matching your last search" with [View] [Dismiss]
- Has "GX" (Gigr agent) monogram in a dark circle as avatar
- Different from generic toasts (sonner) — has action buttons and richer layout

**Files:** new `components/agent/AgentProactiveToast.tsx`, `DashboardLayout.tsx`
**Feature flag:** `VITE_FEATURE_AGENT_PROACTIVE_SURFACE`

---

## Phase 3 — Visual Language

The agent UI has its own visual identity — distinct from the rest of the app.

### 3.1 Design tokens (agent-specific)

```css
--agent-bg: #0a0a0f;
--agent-surface: #12121a;
--agent-border: #1e1e2e;
--agent-accent: #7c3aed;
--agent-accent-glow: rgba(124,58,237,0.15);
--agent-text-primary: #e2e2f0;
--agent-text-muted: #6b6b8a;
--agent-running: #f59e0b;
--agent-success: #10b981;
--agent-error: #ef4444;
--agent-pending: #7c3aed;
```

### 3.2 SVG Illustration set

Inline SVG components — no raster, no emoji, no Lottie dependency. Single accent color per scene. Animate via CSS `@keyframes` only.

| Context | Scene |
|---|---|
| No tasks yet | Robot at a desk, waiting |
| Agent running | Radar ping circles, gear |
| Task failed | Broken circuit wire |
| No results found | Empty map with search pin |
| Success (job posted) | Poster on a board, check |
| Voice listening | Abstract sound waveform |

**Files:** `components/agent/illustrations/*.tsx`

### 3.3 Animated mic button

- Rest: dark circle, grey `MicOff` icon
- Hover: soft violet glow ring expands (CSS transition)
- Listening: 3 sonar rings pulse outward (CSS `@keyframes`, staggered), `Mic` icon in white
- Processing: custom brain SVG path rotates

All CSS, no JS animation library for this layer.

**Files:** `VoiceAssistant.tsx`

### 3.4 Custom map pins

Replace Leaflet's default blue drop pin:

- Service provider pin: dark circle with provider initial, violet ring
- Job pin: square badge with price in Naira
- User location: pulsing green dot
- Selected state: scale 1.3x, glow ring

Implemented as `L.DivIcon` with inline SVG.

**Files:** `MapExplorer.tsx`, `NeighborhoodMap.tsx`, new `lib/mapPins.ts`

---

## Phase 4 — Agent Becomes an OS

### 4.1 Agent Planner (multi-step tasks)

User says "clean my apartment and fix the AC". Agent breaks it into two sub-tasks, runs them in parallel.

- New `task_type: "plan"` with child task IDs
- NLP prompt gets planner mode: detects compound requests, returns `{"task_type": "plan", "steps": [...]}`
- Backend creates and runs child tasks, waits for all to complete
- Frontend: plan tasks show as parent card with collapsible child cards

**Feature flag:** `FEATURE_AGENT_PLANNER`

### 4.2 Smart job matching and auto-apply

Agent watches incoming jobs, applies on behalf of the provider when the job matches skills and rate.

- New background loop: every interval, fetch open jobs not yet applied to
- Match score: category overlap + price range + proximity
- If score > threshold AND autonomy is `high`: auto-apply with Groq-generated cover letter
- `task_type: "apply_job"` already in the type enum — implement the handler

**Feature flag:** `FEATURE_AGENT_SMART_APPLY`

### 4.3 Agent memory cards

New section in `AISettingsPage`: "What your agent knows"

- Cards showing: location, typical budget, preferred categories, last search
- Each card has [Edit] and [Forget] buttons
- Forget clears that specific memory key via PATCH `/users/me`

**Files:** `AISettingsPage.tsx`, new `components/agent/MemoryCards.tsx`

### 4.4 Live map sync

When a `find_service` task runs, the `MapExplorer` (if open) shows a "searching" pulse overlay. As `AgentLog` with `render_type: "service_cards"` arrives via WS push, map pins animate in. Map shows "Agent mode" ribbon. Clearing resets to default view.

**Files:** `MapExplorer.tsx`, `agentStore.ts`, new `hooks/useAgentMapSync.ts`
**Feature flag:** `VITE_FEATURE_AGENT_MAP_RESULTS`

### 4.5 Streaming agent reasoning

- New endpoint: `GET /ai/tasks/{id}/stream` (server-sent events)
- Each `AgentLog` insert triggers an SSE push
- Frontend: `EventSource` connected when task is running, appends entries live
- Final summary streams token by token

**Feature flag:** `FEATURE_AGENT_STREAMING`

---

## Phase 5 — Paywall Gating

All premium features open now (`FEATURE_AGENT_PREMIUM=false`).

When `FEATURE_AGENT_PREMIUM=true`:

| Feature | Free | Premium |
|---|---|---|
| Manual commands | unlimited | unlimited |
| Multi-turn context | 3 turns | 10 turns |
| Proactive hunting | off | on |
| Auto-negotiate | off | on |
| Auto-apply | off | on |
| Agent planner | off | on |
| Streaming reasoning | off | on |
| Memory cards | basic | full |
| Map results | pins only | pins + routing |

**Implementation:**
- Backend: `require_premium_agent` dependency (reads `user.subscription_tier`)
- Frontend: `useAgentFeature(flag)` hook — reads env var AND user tier
- Locked features show a `PremiumGate` component — blurred preview + "Unlock with Pro" overlay
- No feature is removed in free tier — visibly locked so user understands the value

**Files:** new `lib/featureFlags.ts`, new `components/agent/PremiumGate.tsx`, backend `dependencies.py`

---

## Build Order

Each sprint is independently deployable and does not break what came before it.

### Sprint 1 — Foundation
1. Add `FEATURE_AGENT_*` env vars to `.env.example` and backend `config.py`
2. `lib/featureFlags.ts` (frontend) and `require_ai_feature(flag)` (backend)
3. Autonomy capability matrix on backend
4. Memory schema extension (backward compatible — additive keys only)

### Sprint 2 — Intelligence
5. Multi-turn session context
6. `think` log level (backend + frontend render)
7. Memory enrichment (derived on task completion)
8. Smarter proactive hunt using enriched memory

### Sprint 3 — Command Palette
9. `CommandPalette.tsx`
10. Mic button delegates to palette
11. Real-time command suggestions

### Sprint 4 — Activity Panel + Surfaces
12. `AgentStatusBar.tsx` wired into `DashboardLayout`
13. Task card redesign (design tokens, borders, log stagger)
14. `AgentProactiveToast.tsx`
15. `AgentResultMap.tsx` inline in log entries

### Sprint 5 — Visual Language
16. SVG illustration set
17. Animated mic button
18. Custom map pins (`lib/mapPins.ts`)

### Sprint 6 — Agent OS Features
19. Agent Planner
20. Smart job matching + auto-apply
21. Memory cards in settings
22. Live map sync
23. Streaming reasoning (SSE)

### Sprint 7 — Paywall
24. `PremiumGate.tsx`
25. `useAgentFeature(flag)` hook
26. Backend `require_premium_agent` dependency
27. Wire all premium gates

---

## File Map

### New files

```
frontend/src/
  components/agent/
    CommandPalette.tsx
    AgentResultMap.tsx
    AgentStatusBar.tsx
    AgentProactiveToast.tsx
    MemoryCards.tsx
    PremiumGate.tsx
    illustrations/
      AgentWaiting.tsx
      AgentRunning.tsx
      AgentFailed.tsx
      NoResults.tsx
      JobPosted.tsx
      VoiceListening.tsx
  hooks/
    useAgentMapSync.ts
    useAgentFeature.ts
  lib/
    featureFlags.ts
    mapPins.ts

backend/app/
  core/
    agent_features.py
  services/
    agent_session.py
```

### Files extended (never rewritten)

```
frontend/src/store/agentStore.ts
frontend/src/components/agent/AgentActivityPanel.tsx
frontend/src/components/agent/AgentBell.tsx
frontend/src/components/VoiceAssistant.tsx
frontend/src/components/map/MapExplorer.tsx
frontend/src/pages/AISettingsPage.tsx
frontend/src/lib/webmcp/tools.ts
backend/app/api/v1/endpoints/ai.py
backend/app/core/config.py
backend/app/core/dependencies.py
```

---

## House Standard Compliance

- No emojis anywhere — illustrations are SVG, status uses text labels (`[OK]`, `[FAIL]`)
- Feature flags follow `FEATURE_<DOMAIN>_<NAME>`, declared in config only, never read ad hoc
- Security controls are never gated behind feature flags
- New backend files follow layer structure: session helper is a `service`, not stuffed into `ai.py`
- Each sprint is independently deployable
- Existing routes, models, and component APIs are extended only — not replaced
