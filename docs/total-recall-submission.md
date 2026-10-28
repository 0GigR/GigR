# Total Recall: Tatum x Walrus Memory

**Track:** Consumer Finance Apps
**Deadline:** 10 November 2026, 17:00 UTC

## The problem

Gigr is a marketplace for informal local work: a plumber, a tailor, a phone
repair. Reputation is the whole product. A user hires once, and the next time
they need someone they start from nothing: they cannot remember who was good,
what they paid, or who let them down.

That history exists. It sits in jobs, messages, ratings and disputes. It does
not survive the session, because an assistant that forgets you is no better
than a search box.

## What we built

Every user's history is turned into short factual sentences and stored in
**Walrus Memory**, in that user's own namespace. The agent recalls them by
meaning before it answers, so it opens with what it already knows.

Real output from one account after backfill:

```
Kosisochukwu hired a provider for Phone repair at 3000 naira (in_progress, 2026).
Kosisochukwu hired a provider for Plumbing - Installation at 200 naira (completed, 2026).
Kosisochukwu has completed 3 jobs as a client and 5 as a provider.
Kosisochukwu has an average rating of 4.0 from 1 rating.
Kosisochukwu has 19 contract room conversations.
Kosisochukwu was last active in messages on 25 October 2026.
```

Thirty-four sentences for that account. Twenty-eight for a second. The memory
page at `/dashboard/memory` lists them grouped by category, with an honest
count derived from what is actually rendered.

### Why sentences, not keys

The previous implementation stored four flat keys (`last_search`,
`usual_price_job`, ...). That is a settings cache: it cannot answer "who did I
hire and was it worth it". Walrus Memory recalls by meaning, so the stored unit
has to be a sentence a person would recognise.

### Facts are extracted, never invented

Templates turn rows into sentences. No model writes a fact, so no fact can be
hallucinated, and a field that is missing produces no sentence rather than a
guess. A user with no history gets nothing, not a generic profile.

### It runs backwards as well as forwards

A one-off backfill walks every existing user and writes their history to Walrus.
It is idempotent (a fact's own hash is its key), resumable (a JSON state file
records progress), and paced below the relayer's limits. New facts then flow
from events: a job posted, a job completed, a rating left, a dispute resolved.

### Two limits we designed around, and say so

**There is no per-fact delete, but a whole namespace can be forgotten.** The
relayer is append-only for a single fact, so the UI does not offer a Forget
button that would pretend to remove one remembered sentence. Instead there are
two controls with different scopes, and the page says which is which: a Forget
button per saved preference (the JSONB key, which stops the agent reusing it)
and "Forget everything Gigr remembers about me", which calls the namespace-level
delete memwal 0.2.2 added (MystenLabs/walrus-memory#1061, fixed upstream in
PR #1234) and removes that user's entire memory from Walrus Memory, permanently.
The two are deliberately not one button: a per-fact delete is still impossible,
and a control that implied otherwise would be a lie.

**Recall is per fact.** Each remembered sentence is a blob that must be fetched
and decrypted, so a 34-fact page takes seconds where a 5-fact agent recall does
not. The page has its own longer deadline, caches for five minutes, and names
its failures: busy, slow, unavailable.

## Tatum

Solana reads go through Tatum's gateway by default: `get_account_info` and
`get_latest_blockhash` use `TATUM_SOLANA_RPC_URL` (default
`https://solana-devnet.gateway.tatum.io`) with the key in the `x-api-key`
header, on a short deadline, and fall back exactly once to `SOLANA_RPC_URL`.
Writes never do. `send_transaction` is called on a client built from
`SOLANA_RPC_URL` only, so fund, release and cancel cannot reach the gateway at
all; that split is structural, not a flag check on the write path, which is why
reads can be on by default. Escrow writes are never replayed.

Sui verification is implemented: a read-only `sui_getObject` through Tatum's Sui
JSON-RPC, advisory only, incapable of failing a memory read or write.

The hosted gateway's answers were measured on 27 October 2026 against
`sui-mainnet.gateway.tatum.io`: a request with **no** API key gets `404`, a
request with a rejected key gets `401`, and a JSON request to the gRPC host gets
`415`. So a 404 is an authentication/configuration answer, not a wrong endpoint;
that distinction cost us an hour once. The gateways are enabled per network with
`FEATURE_TATUM_SUI=true`, `TATUM_SUI_NETWORK=mainnet|testnet`,
`TATUM_SUI_RPC_URL=https://sui-mainnet.gateway.tatum.io`, and the matching
`TATUM_API_KEY_MAINNET` or `TATUM_API_KEY_TESTNET`. The app trims surrounding
whitespace from those values, because a newline pasted into a dashboard value
produces exactly the unauthenticated 404 above.

Sui verification is off in production until the deployed key is confirmed. The
Solana Tatum read path is on by default and needs no extra variable: the flag
defaults to true and the URL defaults to the devnet gateway, while writes stay
on `SOLANA_RPC_URL`.

To confirm the deployment:

```bash
cd backend
python scripts/check_tatum_sui.py
python scripts/check_tatum_sui.py 0x<walrus-blob-object-id>
```

The first call proves the key and endpoint; the second proves the exact object
read the app makes, and says whether the object is a Walrus blob.

## Evidence

| | |
|---|---|
| Backend tests | 304 passed, 54 skipped, 0 failed |
| Frontend tests | 84 passed |
| Facts backfilled | 262 across 27 users |
| Bugs filed upstream | #1312 (fixed upstream), #1061 (fixed upstream), #1062 to #1064 (fixed) |

`#1061` (no delete) was fixed upstream in PR #1234 and shipped in memwal 0.2.2,
which is what the namespace forget uses. `#1312` (one idempotency key under a
different namespace answered `500`) was fixed upstream in PR #1320, relayer
v0.1.0; this build's keys stay namespace-scoped, so the two fixes agree.

## What the demo shows

1. The memory page: what Gigr already knows, grouped, from Walrus
2. A voice question from the user
3. The agent panel: `Recalled 5 memories from Walrus`
4. An answer that cites their real history, not a generic response
