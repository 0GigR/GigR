# Gigr demo video — shot-by-shot script

Focus per your instruction: **the hyperlocal/maps experience and the AI agent**.
Target length **2:00** (a 0:60 cut is marked below). Everything listed here exists
in the app today; nothing is aspirational.

## Before you record

1. **Start the backend and frontend** so the changes in this session are live.
2. **Seed demo data** so the map is not empty — see
   `backend/scripts/seed_demo_data.py`. Out of the box only 2 of 38 jobs carry
   coordinates, which makes the map look broken on camera.
3. **Sign in as the demo account**, and in **Profile → Display currency** pick
   NGN so the numbers read cleanly.
4. **Set the agent's autonomy** to *high* (Settings → AI Agent) so the autonomy
   screen has something to show.
5. **Allow location** when the browser asks, and pick a known neighbourhood
   (e.g. Yaba, Lagos) in the create form so the map centres somewhere real.
6. Turn on **Do Not Disturb** — the push and location banners are now suppressed
   when already enabled, but a fresh profile may still show one.
7. Record at **1080p, 60fps** if you can: the marker springs and the radius
   breathe are the details that sell it.

## The script

### 0:00–0:12 — Cold open on the map

**Screen:** Jobs → **Map** tab.

**Do:** Let the radius circle breathe for a beat, then tap **1 km → 5 km → 25 km**.

**Narration:** *"This is Gigr. Not a list of jobs — a map of your
neighbourhood. Change the radius and the map redraws what's actually around
you."*

> Deliberately no feature list and no logo animation. Open on the thing that
> makes it different.

### 0:12–0:25 — Clustering and card sync

**Do:** Zoom out so the pins collapse into cluster bubbles; tap a cluster to
drill in. Then tap a listing card on the right and let the map fly to that pin.
Tap a pin and let its card scroll into view.

**Narration:** *"Pins group as you zoom out, so it never turns into confetti.
Tap a card and the map flies to it; tap a pin and the card comes to you. The two
are the same object."*

### 0:25–0:33 — Dark mode and detail

**Do:** Toggle the theme. Then open a pin's popup showing distance, price and
the provider.

**Narration:** *"Dark mode is the real map, not a screenshot. Every listing
carries its distance because the server computes it — no guessing on the
device."*

### 0:33–0:48 — The agent does the work

**Screen:** Tap the **lightning** icon to open the agent, type:

> `find me a plumber near me under 5000`

**Do:** Let the activity feed show the tool call it makes, then the results.

**Narration:** *"Now watch what happens when I stop tapping. I ask in plain
language. The agent reads my saved location, searches real providers within
range, respects my budget — and shows me exactly which tool it called."*

### 0:48–1:02 — Acting, not just answering

**Do:** Tap **Request** on one result. Show the request landing as a real job
with a real conversation.

**Narration:** *"One tap and it's a real request, with a real conversation
attached. This isn't a chatbot bolted onto a marketplace — it's an agent that
can act."*

> Short cut: you can end at 1:02 here for a 60-second version.

### 1:02–1:18 — Autonomy, with limits

**Screen:** Settings → AI Agent.

**Do:** Show the level selector and the guardrail line ("up to 40 autonomous
actions and 10 automatic applications per day"). Move from *off* to *total* and
back.

**Narration:** *"You decide how much rope it gets. Low replies for you. Medium
negotiates. High applies to matching jobs. Total hunts for providers while you
sleep — and every level has a hard daily limit the server enforces, not just a
label in a menu."*

### 1:18–1:34 — Money is still yours

**Do:** In the agent, type `pay for this job`. Show that it refuses to move
money, explains what is needed, and hands you a link to fund escrow.

**Narration:** *"The one thing it will never do is move your money. It finds the
job, explains what's needed, and hands you the link. You fund escrow. It does
not claim a payment happened — because it didn't."*

> This is the part that builds trust with an audience that has been burned by
> apps. Do not cut it.

### 1:34–1:50 — Service area and ETA

**Do:** Open a service detail page. Point at the provider's own radius circle,
then at the road route line and the "km away · min drive" figure.

**Narration:** *"Providers set how far they'll travel, and you can see it drawn.
Routing is real road distance, not a straight line."*

### 1:50–2:00 — Close

**Screen:** Back to the map, one slow full-radius breathe.

**Narration:** *"Hyperlocal discovery, an agent that can act, and escrow that
holds the money until the work is done. That's Gigr."*

## Shot checklist

| # | Time | Screen | Must be visible |
|---|---|---|---|
| 1 | 0:00 | Jobs → Map | Breathe animation, radius change |
| 2 | 0:12 | Jobs → Map | Cluster → drill-down, card ↔ pin sync |
| 3 | 0:25 | Map popup + theme toggle | Distance, dark tiles |
| 4 | 0:33 | Agent panel | Tool call in the feed, results |
| 5 | 0:48 | Agent → request | Real job + conversation |
| 6 | 1:02 | AI Settings | Level selector, guardrail line |
| 7 | 1:18 | Agent `pay` | Refusal + fund link |
| 8 | 1:34 | Service detail | Radius circle, route line, ETA |
| 9 | 1:50 | Map | Closing breathe |

## Honest caveats

- **The map is only as full as the data.** Seed the demo data first.
- **Routing comes from OSRM's public demo server.** It is free and needs no key,
  but it is a shared community service: if it is slow during recording, the
  screen falls back to a straight-line estimate, which is labelled
  "straight line" on screen. That is truthful, not broken.
- **Do not record the historical jobs.** Some older listings still have
  command-text titles from the bug fixed in this session; the seeder creates
  clean ones, so record from the demo account.
