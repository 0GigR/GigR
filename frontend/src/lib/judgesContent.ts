/**
 * judgesContent.ts - copy and links that must stay exact on /judges.
 *
 * Keeping the brand strip, the stat row and the grouped links in one place
 * means the page cannot drift from the claims a judge is checking, and the
 * tests can assert the required wording and order without rendering React.
 */

export type JudgeBrandTone = 'blue' | 'amber' | 'violet' | 'sky' | 'cyan'

export interface JudgeBrand {
  name: string
  role: string
  tone: JudgeBrandTone
}

/** Order of prominence: Walrus Memory, Tatum, x402, Sui, MemWal. */
export const JUDGES_BRANDS: readonly JudgeBrand[] = [
  { name: 'Walrus Memory', role: 'Walrus storage', tone: 'blue' },
  { name: 'Tatum', role: 'Chain reads', tone: 'amber' },
  { name: 'x402', role: 'Agent payments', tone: 'violet' },
  { name: 'Sui', role: 'Walrus chain', tone: 'sky' },
  { name: 'MemWal', role: 'Memory SDK', tone: 'cyan' },
]

export interface JudgeStat {
  value: string
  label: string
  /** The sentence the row must read; `value + ' ' + label`. */
  phrase: string
}

export const JUDGES_STATS: readonly JudgeStat[] = [
  {
    value: 'three',
    label: 'Tatum integrations across two chains',
    phrase: 'three Tatum integrations across two chains',
  },
  {
    value: 'Walrus Memory',
    label: 'with a namespace per user',
    phrase: 'Walrus Memory with a namespace per user',
  },
  {
    value: 'five',
    label: "upstream issues filed against Mysten's SDK and all closed",
    phrase: "five upstream issues filed against Mysten's SDK and all closed",
  },
  {
    value: 'x402',
    label: 'one payment one brief',
    phrase: 'x402 one payment one brief',
  },
]

export interface JudgeLink {
  label: string
  note: string
  href: string
}

/** Brand groups first, in the order the brief asks for them. */
export const JUDGE_BRAND_LINKS: readonly (JudgeLink & { tone: JudgeBrandTone })[] = [
  {
    label: 'Walrus Memory SDK',
    note: 'Mysten Labs memory SDK',
    href: 'https://github.com/MystenLabs/walrus-memory',
    tone: 'blue',
  },
  {
    label: 'Tatum',
    note: 'Multi-chain data API',
    href: 'https://tatum.io',
    tone: 'amber',
  },
  {
    label: 'Sui',
    note: 'The chain Walrus lives on',
    href: 'https://sui.io',
    tone: 'sky',
  },
  {
    label: 'x402',
    note: 'Agent payment protocol',
    href: 'https://x402.org',
    tone: 'violet',
  },
]

export const JUDGE_PRODUCT_LINKS: readonly JudgeLink[] = [
  { label: 'Application', note: 'The live product', href: 'https://gigrr.vercel.app' },
  {
    label: 'Demo video',
    note: 'The hackathon submission',
    href: 'https://youtu.be/HM9IAKpiks0',
  },
  {
    label: 'Full Gigr walkthrough',
    note: 'A longer product demo',
    href: 'https://youtu.be/i21snLQ9OlM',
  },
  { label: 'Source', note: 'The whole repository', href: 'https://github.com/0GigR/GigR' },
]
