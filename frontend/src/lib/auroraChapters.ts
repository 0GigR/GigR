/**
 * auroraChapters.ts - Single source of truth for the /ea judge briefing demo.
 *
 * Conforms strictly to house-standard.md:
 * - Pure TypeScript mapping, zero DOM/React coupling
 * - Covered by unit tests for chapter boundary lookups and time formatting
 * - Zero emojis anywhere in strings or comments
 */

export const AURORA_VIDEO_DURATION_SECONDS = 294

export type AuroraChapterId =
  | 'intro'
  | 'onboarding'
  | 'aurora-escrow'
  | 'anchor-funding'
  | 'escrow-release'
  | 'cnft'
  | 'x402'
  | 'aurora-wallet'

export interface AuroraChapter {
  id: AuroraChapterId
  title: string
  tag: string | null
  start: number
  lines: readonly string[]
}

export const AURORA_CHAPTERS: readonly AuroraChapter[] = [
  {
    id: 'intro',
    title: 'Intro & Problem Statement',
    tag: 'Overview',
    start: 0,
    lines: [
      'Across emerging markets and Africa, millions of informal artisans, builders, and gig workers lose money every week to payment fraud and delayed payouts.',
      'Even worse, their professional reputation is locked inside closed Web2 platforms.',
      'Traditional Web3 solutions fail them because seed phrases, browser extensions, and gas fees create massive onboarding friction.',
      'This is Gigr: a hyper-local neighborhood services marketplace built on Solana that feels just like a Web2 consumer app.',
    ],
  },
  {
    id: 'onboarding',
    title: 'Solana & App Overview',
    tag: 'Solana Consumer',
    start: 35,
    lines: [
      'Every user onboards in 3 seconds: they sign in with Google, and Gigr provisions an in-app Solana keypair automatically behind the scenes.',
      'Users never manage a seed phrase or pay network gas—the platform covers all Solana fees.',
      'On the neighborhood map, clients discover nearby plumbers, tutors, and electricians filtered by verified distance and on-chain trust scores.',
      'Jobs are structured with milestone escrows so neither party bears all the financial risk.',
    ],
  },
  {
    id: 'aurora-escrow',
    title: 'Aurora Integration (Any-Chain Escrow)',
    tag: 'Aurora Intents',
    start: 74,
    lines: [
      'When an employer funds a milestone, they do not need Solana USDC or SOL beforehand.',
      'With our Aurora Intents integration, powered by NEAR 1Click, clients can pay from 38+ blockchains.',
      'Employers can deposit USDC stablecoins or native blockchain assets like Base ETH, Arbitrum USDC, Bitcoin, or Sui.',
      'Gigr requests an intent quote from the 1Click RFQ solver network, which returns a persistent deposit address.',
      'Solvers detect the deposit, execute the cross-chain swap, and route exact USDC directly into Gigr’s Solana milestone escrow with zero bridge friction.',
    ],
  },
  {
    id: 'anchor-funding',
    title: 'Anchor Escrow Program Funding',
    tag: 'Anchor Smart Contract',
    start: 116,
    lines: [
      'Clients who already hold in-app balances can fund milestones directly from their wallet with one tap.',
      'Funds are locked non-custodially inside Solana Program Derived Address (PDA) escrow vaults via our Anchor program.',
      'Milestone balances remain secured on-chain until the client reviews and approves the deliverable.',
      'The demonstration transitions to the service provider wallet to verify live release.',
    ],
  },
  {
    id: 'escrow-release',
    title: 'Milestone Release & Payout',
    tag: 'Solana Settlement',
    start: 140,
    lines: [
      'The service provider dashboard displays their pending milestone escrow and live wallet balance.',
      'Escrow funds are held non-custodially inside Solana PDAs governed by the deployed Anchor program.',
      'Once the client approves the completed work, the Anchor contract releases the USDC directly to the worker’s Associated Token Account on Solana.',
      'Approving the milestone triggers immediate on-chain settlement, and the worker’s balance updates in real time.',
    ],
  },
  {
    id: 'cnft',
    title: 'cNFT Reputation & Vouches',
    tag: 'cNFT Reputation',
    start: 223,
    lines: [
      'Simultaneously, Gigr mints a compressed NFT (cNFT) to the provider’s Solana wallet on completed jobs via Bubblegum.',
      'Every completed milestone creates an immutable, on-chain Vouch credential.',
      'This reputation is portable, decentralized, and belongs to the worker forever across any platform.',
    ],
  },
  {
    id: 'x402',
    title: 'x402 Autonomous Agent Payments',
    tag: 'x402 on Solana',
    start: 243,
    lines: [
      'Gigr turns job intelligence into a machine-payable resource using x402 over Solana.',
      'Autonomous AI agents scouting for local talent call our API and receive a standard HTTP 402 Payment Required challenge.',
      'The agent settles a micro-payment of 0.01 USDC on Solana immediately and supplies the transaction signature.',
      'The endpoint verifies the signature on-chain and unlocks the candidate brief without subscriptions, accounts, or credit cards.',
    ],
  },
  {
    id: 'aurora-wallet',
    title: 'Aurora In-App Wallet Funding',
    tag: 'Intents Deposits',
    start: 280,
    lines: [
      'Aurora Intents also powers in-app wallet funding directly from any external blockchain.',
      'Users can fund via Solana Devnet or generate an Aurora 1Click deposit address across 38+ chains.',
      'Solvers detect the transfer and credit the user’s Solana USDC balance automatically.',
    ],
  },
]

export function formatChapterTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(safe / 60)
  const remaining = safe % 60
  return `${minutes}:${remaining.toString().padStart(2, '0')}`
}

export function chapterIndexAt(
  seconds: number,
  chapters: readonly AuroraChapter[] = AURORA_CHAPTERS,
): number {
  if (chapters.length === 0) return 0
  const safe = Math.max(0, seconds)
  let best = 0
  for (let i = 0; i < chapters.length; i++) {
    if (safe >= chapters[i].start) {
      best = i
    } else {
      break
    }
  }
  return best
}
