# Gigr demo — what to do & what to say

Yes, it's a walkthrough. But a walkthrough alone is flat: "here's a screen, here's
another screen". Give it a **spine** and it lands:

> **Hook** (why should I care) → **Problem** (what's broken today) → **Walkthrough** (watch me use it) → **Proof** (the bits nobody else has) → **Close** (the one line to remember)

You already have footage. What's missing is almost certainly **the 20 seconds
before it** — the reason anyone should keep watching. So Part 1 below is the
pre-roll to record fresh, and Part 2 maps onto the walkthrough you already have.

---

## Part 0 — Before you hit record

**Re-seed the demo data first.** I deleted it at your request, so the map is
nearly empty right now and would look broken on camera:

```bash
cd backend
python scripts/seed_demo_data.py --email demo@gigr.dev --lat 5.3903354 --lng 7.000361 --yes
```

Clean-up when you're finished (same command with `--cleanup --yes`).

Then:

- Sign in as `demo@gigr.dev` / `DemoPass!123`.
- **Do Not Disturb ON.** A WhatsApp banner mid-take ruins it.
- **Portrait, 1080p**, screen recording, phone in hand. Your screenshots are
  portrait, and this is a phone app — landscape will look wrong.
- **Pick one neighbourhood and stay there** for the whole video (Yaba is fine).
- Turn the theme to **light** for the walkthrough, then flip to **dark** once as
  a beat.
- Go through it **once without recording** so your thumbs know the taps.

---

## Part 1 — PRE-ROLL (record this fresh, ~20 seconds)

This is the "something before". Face or voice over a slow pan of the landing
page, or just the map breathing. No feature talk yet — just the problem.

**SAY:**

> "If you've ever needed someone — a plumber, a tailor, someone to help you move
> — you know how it goes. You ask around. You wait. You send money to someone
> you've never met, and you hope."
>
> "In Nigeria we call it *runs*. It works, but it's built on trust and luck."
>
> "This is Gigr. It's a map of your neighbourhood, an assistant that does the
> running around for you, and money that doesn't move until the work is done."

**DO:** at "neighbourhood", let the map breathe on screen — one slow pull so the
radius circle expands. Don't tap anything yet. Let it sit.

*(If you'd rather not be on camera, this works as pure voice-over on the map.
Nobody minds.)*

---

## Part 2 — WALKTHROUGH (the body)

Each block is **DO** (exact taps) then **SAY** (read it). Keep moving — silence
between taps reads as hesitation.

### 2.1 — Home (~15s)

**DO:** Land on Home. Let it settle for two seconds. Tap **More stats** open,
then closed.

**SAY:**

> "You open Gigr and it's already about you: what's active, what's waiting on
> you. Two numbers, because that's all that matters first thing. Everything else
> is one tap away."

### 2.2 — The map, and why it's the point (~30s)

**DO:** Go to **Jobs → Map**. Then: change the radius **5 km → 25 km**. Tap a pin
so its card appears. Then tap **Heat**.

**SAY:**

> "Here's my neighbourhood. This circle is how far out I'm looking — 5 km, 25 km,
> whatever I choose."
>
> "Every pin is a real person. Tap one and you see who they are, what they're
> asking, and how far away they are."
>
> "And if I just want to see where the work is concentrated — this is the heat
> view. That's my area's economy at a glance."

**Note:** jobs are **square** pins, services are **round**. Say it if a services
pin is on screen: *"squares are jobs, circles are services."*

### 2.3 — Switching to services (~15s)

**DO:** Go to **Services**. Point out the switcher stays pinned; scroll down so
it stays visible. Tap **Map**.

**SAY:**

> "Services is the flip side — people selling what they do. See this switcher
> stays put while I scroll? Small thing. Means I'm never lost."

### 2.4 — Distance and service area (~15s)

**DO:** Open a service. Show the **radius circle** and the route line with the
"km away · min drive" figure.

**SAY:**

> "Each provider sets how far they'll travel, and you can see it drawn. That
> distance is a real road distance, not a straight line."

### 2.5 — The agent (the money shot, ~45s)

**DO:** Go Home. Tap the **lightning bolt** in the header. Type:

> `find someone that does woodworks near me under 20k`

Wait. Let the trace lines appear, then the result cards.

**SAY:**

> "Now this is the part I actually care about. I don't want to scroll, I want to
> *ask*."
>
> "So: 'find someone that does woodworks near me under twenty thousand.'"
>
> "Watch what it does. It reads my location, it searches real providers, it
> respects my budget — and it shows me exactly what it did. That's not a chatbot.
> That's the app doing the work."

**Then** tap one result and let the request open.

> "One tap and it's a real request, with a real conversation attached."

### 2.6 — Autonomy, and the fact it can't spend your money (~30s)

**DO:** Go to **AI Settings** (under More). Show the autonomy selector and the
guardrail line. Move **off → high** and back.

**SAY:**

> "You decide how much rope it gets. Low just replies for me. Medium negotiates.
> High applies to jobs that match. Total goes looking for work while I sleep."
>
> "And every level has a hard daily limit — enforced on the server, not just a
> label in a menu."

**Then** in the agent type: `pay for this job`.

> "But the one thing it will never do is move my money. It finds the job, tells
> me what's needed, and hands me the link. I fund escrow. It never claims a
> payment happened — because it didn't."

*(This is your trust moment. Do not cut it.)*

### 2.7 — Dark mode, one beat (~5s)

**DO:** Toggle the theme.

**SAY:** *"And it's a real dark mode. Because of course it is."*

---

## Part 3 — CLOSE (~10s)

**DO:** Back to the map. One slow pan.

**SAY:**

> "A map of your neighbourhood. An assistant that does the running. And money
> that stays put until the job's done."
>
> "Gigr. Trust works."

---

## The 60-second cut

If you need a short version for socials, keep only: **2.2** (map + heat) →
**2.5** (the agent) → **2.6** (won't move your money). Skip Home, Services and
autonomy detail. Open on the map, not a logo.

## Practical tips

- **Never say "blockchain", "escrow", or "on-chain" unless explaining it in
  plain words.** You already do this well in the app; keep the video the same.
- **Tap deliberately, then hold.** Fast taps look nervous on playback.
- **Record the agent section last**, once you're warmed up — it's the one people
  rewatch.
- If a step misfires, **don't stop the take.** Keep going and cut it later; the
  flow matters more than a clean run.
- **Subtitles.** Most people watch muted. Your "SAY" lines are short enough to
  caption directly.

## What I could not check

I couldn't open your `demo.mp4` — this machine's bundled ffmpeg has no H.264
decoder, and my attempt to frame-grab it through Chrome was cut off. So I don't
know what's already in it. **Part 2 is written to line up with the app as it
behaves now**, so match each block to your existing footage and only re-record
the ones that don't match — plus all of Part 1, which is the bit you're missing.
