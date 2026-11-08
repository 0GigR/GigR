import { describe, expect, it } from 'vitest'
import { scrubAmount } from './scrollScrub'

const VIEWPORT = 1000
const MAX_SCROLL = 5000

describe('scrubAmount', () => {
  const enter = { selector: '.x', from: 0.9, to: 0.5 }

  it('holds an entering element at full displacement before its range', () => {
    expect(scrubAmount(enter, 0, 1000, 2000, VIEWPORT, MAX_SCROLL)).toBe(1)
  })

  it('moves it part way inside the range and eases toward rest', () => {
    // Range is scroll 1100 to 1500, so 1300 is halfway through it
    expect(scrubAmount(enter, 0, 1300, 2000, VIEWPORT, MAX_SCROLL)).toBeCloseTo(0.25)
  })

  it('leaves it at rest once the range has passed', () => {
    expect(scrubAmount(enter, 0, 1500, 2000, VIEWPORT, MAX_SCROLL)).toBe(0)
    expect(scrubAmount(enter, 0, 4000, 2000, VIEWPORT, MAX_SCROLL)).toBe(0)
  })

  it('reverses when scrolling back up', () => {
    const down = scrubAmount(enter, 0, 1300, 2000, VIEWPORT, MAX_SCROLL)
    scrubAmount(enter, 0, 1500, 2000, VIEWPORT, MAX_SCROLL)
    expect(scrubAmount(enter, 0, 1300, 2000, VIEWPORT, MAX_SCROLL)).toBe(down)
  })

  it('never displaces something already on screen when the page opens', () => {
    expect(scrubAmount(enter, 0, 0, 700, VIEWPORT, MAX_SCROLL)).toBe(0)
  })

  it('finishes at the last scrollable pixel when the finish line is out of reach', () => {
    // Starts at 4800 and would finish at 5200, but the page stops scrolling at 5000
    expect(scrubAmount(enter, 0, 5000, 5700, VIEWPORT, MAX_SCROLL)).toBe(0)
    expect(scrubAmount(enter, 0, 4900, 5700, VIEWPORT, MAX_SCROLL)).toBeGreaterThan(0)
  })

  it('rests an element whose whole range is past the end of the page', () => {
    expect(scrubAmount(enter, 0, 5000, 6000, VIEWPORT, MAX_SCROLL)).toBe(0)
  })

  it('delays later neighbours and repeats the delay along a long list', () => {
    const staggered = { ...enter, stagger: 0.05 }
    const first = scrubAmount(staggered, 0, 1300, 2000, VIEWPORT, MAX_SCROLL)
    const second = scrubAmount(staggered, 1, 1300, 2000, VIEWPORT, MAX_SCROLL)
    const fifth = scrubAmount(staggered, 4, 1300, 2000, VIEWPORT, MAX_SCROLL)
    expect(second).toBeGreaterThan(first)
    expect(fifth).toBe(first)
  })

  it('runs exit from 0 at the top of the page to 1 once scrolled away', () => {
    const exit = { selector: '.x', kind: 'exit' as const, from: 0.1, to: -0.4 }
    expect(scrubAmount(exit, 0, 0, 50, VIEWPORT, MAX_SCROLL)).toBe(0)
    expect(scrubAmount(exit, 0, 225, 50, VIEWPORT, MAX_SCROLL)).toBeCloseTo(0.5)
    expect(scrubAmount(exit, 0, 2000, 50, VIEWPORT, MAX_SCROLL)).toBe(1)
  })

  it('reports whole-page progress and copes with a page that cannot scroll', () => {
    const page = { selector: '.x', kind: 'page' as const }
    expect(scrubAmount(page, 0, 2500, 0, VIEWPORT, MAX_SCROLL)).toBe(0.5)
    expect(scrubAmount(page, 0, 0, 0, VIEWPORT, 0)).toBe(0)
  })
})
