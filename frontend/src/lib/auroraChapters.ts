/**
 * auroraChapters.ts - Single source of truth for the /ea judge briefing demo.
 *
 * Conforms strictly to house-standard.md:
 * - Pure TypeScript mapping, zero DOM/React coupling
 * - Covered by unit tests for chapter boundary lookups and time formatting
 * - Zero emojis anywhere in strings or comments
 */

export const AURORA_VIDEO_DURATION_SECONDS = 330

export type AuroraChapterId = 'intro' | 'wallet' | 'milestones' | 'resilience'

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
    title: 'The Any-Chain Problem',
    tag: 'Aurora Intents',
    start: 0,
    lines: [
      'Gigr is a hyperlocal services marketplace with milestone escrow on Solana.',
      'Solana provides fast sub-second settlement, but user onboarding was constrained by chain fragmentation.',
      'A user holding capital on Base, Arbitrum, Ethereum, or Bitcoin had to leave the app to bridge and swap.',
      'Aurora Intents powered by NEAR 1Click eliminates this friction at the protocol level.',
      'With a single intent-based deposit flow, users interact from 38+ chains with zero manual bridging.',
    ],
  },
  {
    id: 'wallet',
    title: 'Multi-Chain Wallet Funding',
    tag: 'Intents Deposits',
    start: 60,
    lines: [
      'Inside their Gigr profile, users can fund their Solana wallet from any supported chain.',
      'Selecting Base, Arbitrum, Bitcoin, or Ethereum queries the Aurora 1Click quote engine.',
      'The engine returns a dedicated deposit address and cryptographic quote signature.',
      'A background status monitor tracks deposit detection and settlement in real time.',
      'Funds land directly as Solana Devnet USDC ready for marketplace contracts.',
    ],
  },
  {
    id: 'milestones',
    title: 'Milestone Escrow Settlement',
    tag: 'Intents Connect',
    start: 150,
    lines: [
      'Marketplace jobs are secured by incremental milestone escrows on Solana.',
      'Clients can fund pending milestones directly using external chain assets.',
      'Instead of maintaining a prior Solana USDC balance, the client funds from their preferred chain.',
      'Aurora routes the swap and executes the deposit into the milestone escrow pipeline.',
      'Service providers deliver milestones and receive payouts with zero cross-chain complexity.',
    ],
  },
  {
    id: 'resilience',
    title: 'Resilience & Killswitch',
    tag: 'Architecture & CI',
    start: 240,
    lines: [
      'The backend gateway wraps Aurora 1Click with a resilience circuit breaker and 10-second timeout.',
      'External RPC degradation never blocks or degrades core Gigr marketplace operations.',
      'A master killswitch (FEATURE_AURORA_INTENTS) disables all routes with 404 when turned off.',
      'The frontend flag (VITE_FEATURE_AURORA_INTENTS) cleanly hides all related UI elements.',
      'Automated test suites pass green in CI with zero emojis anywhere in the codebase.',
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
