# Competitive landscape — hyperlocal services + AI agents

Researched for the demo/video narrative. Directional, based on public search
results, not a paid analyst report. Treat links as sources, not endorsements.

## The honest headline

**Yes, comparable things exist — and the incumbents are moving fast.** But nobody
I found combines all four of what Gigr does: hyperlocal radius discovery, an
*in-app* agent with user-controlled autonomy tiers, on-chain escrow with
verifiable reputation, and a design point aimed at an informal economy.

That combination — not "AI in a marketplace" — is the defensible story.

## 1. Incumbents adding an agent (the real threat)

**Thumbtack + OpenAI.** Thumbtack partnered with OpenAI to power home services
inside ChatGPT. This is the most serious competitive fact found: a large,
well-funded home-services marketplace with real supply, now reachable through an
assistant people already use.
[businesswire](https://www.businesswire.com/news/home/20251006760229/en/Thumbtack-Partners-with-OpenAI-to-Power-Home-Services-in-ChatGPT)

**Airtasker on ChatGPT.** Airtasker plugged into ChatGPT and reports a surge in
AI-referred tasks. Same pattern: the marketplace becomes a tool the assistant
calls.
[theaustralian.com.au](https://www.theaustralian.com.au/business/stockhead/content/airtasker-plugs-into-chatgpt-as-aireferred-tasks-surge/news-story/7af1c22f1f5537722c4a15087bdbdbde)

**What this means for Gigr.** The "assistant finds you a tradesperson" feature is
becoming table stakes. Do not pitch that as the innovation. Their agent lives in
*their* chat surface; Gigr's lives in the app, next to the map, with the money.

## 2. Agent-native local commerce (infrastructure)

**QasperAI MCP server.** Search, availability, price quotes, inquiries and
bookings with real local businesses, exposed over MCP — "the infrastructure for
agent-native local commerce". This is the closest thing to a platform bet on
agents booking humans.
[github.com/qasperai/mcp-server](https://github.com/qasperai/mcp-server)

**MeatLayer.** Positioned as a marketplace where AI hires humans for physical
world tasks — conceptually adjacent enough to watch.
[tech.yahoo.com](https://tech.yahoo.com/ai/deals/articles/meatlayer-building-marketplace-where-ai-000500579.html)

**Nuuduu.** Consumer local-services product; worth a look for UX comparison.
[producthunt.com](https://www.producthunt.com/products/nuuduu)

## 3. On-chain agents (adjacent, but not local)

**AgenC** — a protocol where AI agents get hired and paid on Solana mainnet.
[tetsuo-ai/AgenC](https://github.com/tetsuo-ai/AgenC)

**aijobs** — on-chain marketplace where agents compete for GitHub bounties and
earn stablecoins across Celo, Base, Polygon and Solana.
[AtlasNexusTech/aijobs](https://github.com/AtlasNexusTech/aijobs)

**Agentripe** — x402 / ERC-8004 / A2A plumbing.
[Agentripe](https://github.com/Agentripe/Agentripe)

**The pattern:** the crypto-plus-agent space is almost entirely *agent-to-agent
digital work* — bounties, code, APIs. Human hands in a physical neighbourhood,
paid through escrow, is not where that crowd is looking.

## Where Gigr actually differs

| Axis | Incumbents (Thumbtack/Airtasker) | Agent infra (QasperAI/MeatLayer) | On-chain agent projects | Gigr |
|---|---|---|---|---|
| Hyperlocal radius discovery | Weak (city-level) | No | No | **Yes** |
| In-app agent that acts | Inside ChatGPT | Yes, as a service | Yes | **Yes, in the app beside the map** |
| User-controlled autonomy tiers with enforced caps | No | No | No | **Yes** |
| Escrow + verifiable reputation on-chain | No | No | Yes, but digital work | **Yes, for physical work** |
| Informal-economy design point | No (US-centric) | No | No | **Yes** |

The two rows nobody else has: **autonomy the user actually controls, with
server-enforced limits**, and **escrow for physical-world work in an informal
economy**.

## What to claim in the video (and what not to)

**Claim:**
- "Change the radius and the map redraws your neighbourhood." Nobody in this
  landscape leads with the map.
- "You decide how much rope the agent gets — and the server enforces the limit,
  it is not a label in a menu."
- "The one thing it will never do is move your money."

**Do not claim:**
- "First AI that finds you a service." Thumbtack shipped that with OpenAI.
- "First on-chain marketplace." That space is crowded with agent work.

**The fair one-line positioning:** *everyone else is putting a marketplace inside
a chat window; Gigr puts an agent inside a neighbourhood, with the user holding
the wallet.*

## Gaps in this research

I searched public sources only, in a handful of queries. I did not check pricing,
funding, or Nigeria/Africa-specific competitors in depth, and I did not verify
current feature sets beyond what the sources above state. Before you lean on any
of this publicly, verify the Thumbtack and Airtasker claims directly — they are
the ones a judge or investor will already know about.
