/**
 * scrollScrub.ts - the arithmetic behind scroll-tied motion on the briefing
 * pages. A rule names some elements and the stretch of scrolling that moves
 * them; scrubAmount turns a scroll position into the number CSS animates with.
 * Nothing here touches the DOM, so the edge cases can be tested directly.
 */

export type ScrubKind = 'enter' | 'exit' | 'page'

export interface ScrubRule {
  selector: string
  /** enter: settles as it arrives. exit: leaves as it scrolls away. page: whole document. */
  kind?: ScrubKind
  /** Viewport fraction, from the top, where the element's top edge starts moving. */
  from?: number
  /** Viewport fraction where it finishes. */
  to?: number
  /** Delay per neighbour, in viewport fractions, so items in one row do not move as one. */
  stagger?: number
}

/** The custom property each kind writes. */
export const SCRUB_PROPERTY: Record<ScrubKind, string> = {
  enter: '--rest',
  exit: '--gone',
  page: '--page',
}

// Grids wrap, so the delay repeats rather than growing down a long list
const STAGGER_CYCLE = 4
const DEFAULT_FROM = 0.96
const DEFAULT_TO = 0.68

const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/**
 * The value for one element at one scroll position.
 *
 * enter runs 1 to 0, where 0 is the element's designed position. exit and page
 * run 0 to 1. An element already on screen at the top of the page is at rest,
 * and an element too near the end of the page to reach its finish line finishes
 * at the last scrollable pixel instead, so nothing can be stranded mid-move.
 */
export function scrubAmount(
  rule: ScrubRule,
  index: number,
  scrollY: number,
  elementTop: number,
  viewportHeight: number,
  maxScroll: number,
): number {
  const kind = rule.kind ?? 'enter'
  if (kind === 'page') return maxScroll > 0 ? clamp01(scrollY / maxScroll) : 0

  const delay = (rule.stagger ?? 0) * (index % STAGGER_CYCLE)
  const start = elementTop - viewportHeight * ((rule.from ?? DEFAULT_FROM) - delay)
  const end = Math.min(elementTop - viewportHeight * ((rule.to ?? DEFAULT_TO) - delay), maxScroll)

  if (kind === 'exit') {
    const begin = Math.max(0, start)
    return end > begin ? clamp01((scrollY - begin) / (end - begin)) : 0
  }

  if (start <= 0 || end <= start) return 0
  const remaining = 1 - clamp01((scrollY - start) / (end - start))
  // Squared, so a piece slows as it lands instead of stopping dead
  return remaining * remaining
}
