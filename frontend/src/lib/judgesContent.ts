/**
 * judgesContent.ts - copy and links that must stay exact on /judges.
 *
 * Keeping the brand strip, the stat row and the grouped links in one place
 * means the page cannot drift from the claims a judge is checking, and the
 * tests can assert the required wording and order without rendering React.
 */

import type { JudgesChapterId } from './judgesChapters'

export type JudgeBrandTone = 'blue' | 'amber' | 'violet' | 'sky' | 'cyan'

export interface JudgeBrandMark {
  /** Served straight out of public/brands; never copied anywhere else. */
  src: string
  alt: string
  /** Intrinsic pixel size, kept so the browser reserves the right box. */
  width: number
  height: number
  /** Dark artwork shipped on its supplied white chip, so it stays legible. */
  chip?: boolean
  /** A dark mark on transparent, flipped to white for the dark page. */
  invert?: boolean
}

export interface JudgeBrand {
  name: string
  role: string
  tone: JudgeBrandTone
  /** Where the tile goes: the brand's own public site or upstream repository. */
  href: string
  /**
   * The real mark, or null when no asset exists. x402 has no logo, and the
   * page sets it as type rather than inventing one.
   */
  mark: JudgeBrandMark | null
}

/**
 * Order of prominence: Walrus Memory, Tatum, x402, Sui, MemWal.
 *
 * Tile destinations: the Walrus tile carries the Walrus mark and the storage
 * role, so it opens the Walrus network; the MemWal tile is the memory SDK and
 * opens the upstream walrus-memory repository that it ships from.
 */
export const JUDGES_BRANDS: readonly JudgeBrand[] = [
  {
    name: 'Walrus Memory',
    role: 'Walrus storage',
    tone: 'blue',
    href: 'https://walrus.xyz',
    mark: {
      src: '/brands/walrus.ico',
      alt: 'Walrus Memory logo',
      width: 64,
      height: 64,
      invert: true,
    },
  },
  {
    name: 'Tatum',
    role: 'Chain reads',
    tone: 'amber',
    href: 'https://tatum.io',
    mark: {
      src: '/brands/tatum-chip.png',
      alt: 'Tatum logo',
      width: 788,
      height: 452,
      chip: true,
    },
  },
  {
    name: 'x402',
    role: 'Agent payments',
    tone: 'violet',
    href: 'https://x402.org',
    mark: null,
  },
  {
    name: 'Sui',
    role: 'Walrus chain',
    tone: 'sky',
    href: 'https://sui.io',
    mark: {
      src: '/brands/sui-chip.png',
      alt: 'Sui logo',
      width: 306,
      height: 184,
      chip: true,
    },
  },
  {
    name: 'MemWal',
    role: 'Memory SDK',
    tone: 'cyan',
    href: 'https://github.com/MystenLabs/walrus-memory',
    mark: {
      src: '/brands/memwal-chip.png',
      alt: 'MemWal logo',
      width: 772,
      height: 452,
      chip: true,
    },
  },
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

/**
 * A link inside a chapter's copy.
 *
 * `chapter` and `line` place it; `label` is the exact substring of that line
 * that becomes the anchor, so the anchor text is always visible copy rather
 * than a bare URL. A sentence can hold more than one link (the x402 line does).
 */
export interface JudgeCopyLink {
  chapter: JudgesChapterId
  line: number
  label: string
  href: string
}

/**
 * Only the claims a reader can actually check are linked. The Walrus delete
 * claim points at the recovery test, the Tatum claims at the Sui migration
 * notes and the exact blob, and the x402 claims at the protocol, the network
 * support matrix and the status code definition.
 */
export const JUDGE_COPY_LINKS: readonly JudgeCopyLink[] = [
  {
    chapter: 'memory',
    line: 5,
    label: 'the recovery test',
    href: 'https://github.com/0GigR/GigR/blob/main/backend/tests/unit/test_memory_reconcile.py',
  },
  {
    chapter: 'tatum',
    line: 2,
    label: 'Sui has deprecated JSON-RPC',
    href: 'https://docs.sui.io/develop/accessing-data/json-rpc-migration',
  },
  {
    chapter: 'tatum',
    line: 2,
    label: 'the blob we verified',
    href: 'https://suivision.xyz/object/0x0000003c64bf4bda578d911acb4f93f470a89f66d9fd8993fdb032cf007b1c93',
  },
  {
    chapter: 'x402',
    line: 1,
    label: 'HTTP 402',
    href: 'https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/402',
  },
  {
    chapter: 'x402',
    line: 6,
    label: 'x402',
    href: 'https://x402.org',
  },
  {
    chapter: 'x402',
    line: 6,
    label: 'does not support Sui',
    href: 'https://raw.githubusercontent.com/coinbase/x402/main/docs/core-concepts/network-and-token-support.mdx',
  },
]

export interface JudgeIssue {
  number: number
  /** The issue title, and the anchor text of the row. */
  label: string
  /** The follow-up a judge would otherwise have to dig out of the thread. */
  note: string | null
  href: string
}

/** The five upstream issues, all closed; the notes say where each fix landed. */
export const JUDGE_UPSTREAM_ISSUES: readonly JudgeIssue[] = [
  {
    number: 1061,
    label: 'Python SDK has no forget or delete method',
    note: 'shipped as forget in memwal 0.2.2',
    href: 'https://github.com/MystenLabs/walrus-memory/issues/1061',
  },
  {
    number: 1062,
    label: 'recall() cannot pass scoring weights',
    note: null,
    href: 'https://github.com/MystenLabs/walrus-memory/issues/1062',
  },
  {
    number: 1063,
    label: 'recall() drops the created_at and score fields',
    note: null,
    href: 'https://github.com/MystenLabs/walrus-memory/issues/1063',
  },
  {
    number: 1064,
    label: 'Python SDK defaults server_url to localhost',
    note: null,
    href: 'https://github.com/MystenLabs/walrus-memory/issues/1064',
  },
  {
    number: 1312,
    label: 'idempotency key reused across namespaces returns a 500',
    note: 'fixed in relayer 0.1.0',
    href: 'https://github.com/MystenLabs/walrus-memory/issues/1312',
  },
]

/** A piece of a chapter line: plain text, or the text of an external link. */
export interface JudgeTextSegment {
  text: string
  href?: string
}

/**
 * Splits `line` at the labels in `links`, in the order they appear.
 *
 * The links are matched by their exact label so a typo in the copy cannot
 * silently turn a claim into plain text: the tests assert every label is
 * present in the line it is placed on. Overlapping matches are left as text
 * instead of producing nested anchors.
 */
export function linkSegments(
  line: string,
  links: readonly Pick<JudgeCopyLink, 'label' | 'href'>[],
): readonly JudgeTextSegment[] {
  const matches = links
    .map((link) => ({ link, at: line.indexOf(link.label) }))
    .filter((match) => match.at >= 0)
    .sort((a, b) => a.at - b.at)

  if (matches.length === 0) return [{ text: line }]

  const segments: JudgeTextSegment[] = []
  let cursor = 0
  for (const { link, at } of matches) {
    if (at < cursor) continue
    if (at > cursor) segments.push({ text: line.slice(cursor, at) })
    segments.push({ text: link.label, href: link.href })
    cursor = at + link.label.length
  }
  if (cursor < line.length) segments.push({ text: line.slice(cursor) })
  return segments
}

/** A link is safe to render only when it is an absolute https URL. */
export function isSafeExternalHref(href: string): boolean {
  return /^https:\/\/[^\s]+$/.test(href) && !href.toLowerCase().startsWith('javascript:')
}
