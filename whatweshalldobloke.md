## Task List Update

| # | Status |
|---|--------|
| C1, C2, H1, H2, H4, H5, M1, M5 | Done |
| Dispute/Jury system | Done (auto‑select, notification, voting, withdrawal, admin resolution, courtroom) |
| C3 (duplicate prevention at API level) | Not done |
| M2 (wallet balance auto‑refresh) | Done via 10s polling on Profile page |
| H3 (timestamps on messages and cards) | Partially done (some cards show time, some don't) |
| M3 (services search debounce) | Not done |
| M4 (profile vouches with job context) | Not done |
| L1–L5 (polish) | Not done |
| W1–W2 (onramp & wallet history) | Not done |

The dispute/jury system is complete. What you're seeing now are UI refinements.

---

### 4. DID (Soulbound NFT) vs Vouching — They're Different, and Both Are $0

- **Vouching (cNFTs):** A client mints a compressed NFT to the provider's wallet as proof of a completed job. This is already live via Underdog Protocol. It costs $0 on Devnet and fractions of a cent on Mainnet.
- **Decentralised Identity (Soulbound NFT):** A non‑transferable token that attests "This wallet has passed KYC" or "This wallet is a verified human." Other dApps can query it. You can mint a Soulbound NFT using **Metaplex** or **Civic Pass**. Civic Pass is already in your stack. Minting an SBT costs <0.001 SOL — effectively free.

**Can you afford it?** Yes. The platform wallet already pays all fees. Minting an SBT for verified users would cost a fraction of a cent per user. That's well within a $0 budget for a hackathon.

**Should you swap out vouching for DID?** No. They serve different purposes:
- Vouching = reputation (I did a good job)
- DID = identity (I am a real person)

You should have **both**. Add a Soulbound NFT that gets minted when a user passes Civic verification. That gives you an extra "Solana integration" point for the hackathon.

---

### 5. Additional Solana/AI Integrations for the Hackathon Prizes

You already have:
- Anchor escrow (USDC on Devnet)
- Compressed NFTs for vouching

Extra Solana integrations you can add quickly:
1. **Soulbound NFT for identity** — mint an SBT when Civic Pass is verified. 1 hour of work.
2. **Solana Pay** — let providers generate a payment link that clients can pay via Phantom/Solflare. Not critical for the demo but shows composability.
3. **Programmable Reputation** — your contract could read the provider's vouch count from the cNFT metadata and adjust the escrow fee. A small contract change.

For AI, the quickest win:
- **Dispute summariser** — when a dispute is opened, pass the entire chat log to a free LLM (like Groq or Together AI) and generate a 2‑sentence summary for the jury. Costs $0 (free tiers). This is genuinely useful and shows "AI + Crypto" in a practical way
