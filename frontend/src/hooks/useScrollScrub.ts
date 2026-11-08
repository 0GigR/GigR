/**
 * useScrollScrub.ts - ties CSS to the scroll position on the briefing pages.
 *
 * Writes one custom property per matched element and leaves what it means to
 * the stylesheet. It is not a scroll-driven CSS animation because Firefox does
 * not ship those. Each element should match one rule.
 *
 * When disabled nothing is written, and every use in CSS falls back to the
 * element's designed position, which is how reduced motion is honoured.
 */

import { useEffect } from 'react'
import type { RefObject } from 'react'
import { SCRUB_PROPERTY, scrubAmount } from '@/lib/scrollScrub'
import type { ScrubRule } from '@/lib/scrollScrub'

interface Target {
  element: HTMLElement
  rule: ScrubRule
  property: string
  index: number
  top: number
  written: number
  moving: boolean
}

// offsetTop ignores transforms, so a piece mid-flight cannot move its own range
function documentTop(element: HTMLElement): number {
  let top = 0
  let node: HTMLElement | null = element
  while (node) {
    top += node.offsetTop
    node = node.offsetParent as HTMLElement | null
  }
  return top
}

/** `rules` must be a stable reference; declare them outside the component. */
export function useScrollScrub(
  rootRef: RefObject<HTMLElement | null>,
  rules: readonly ScrubRule[],
  enabled: boolean,
): void {
  useEffect(() => {
    const root = rootRef.current
    if (!root || !enabled) return

    let targets: Target[] = []
    let viewportHeight = 0
    let maxScroll = 0
    let shown = window.scrollY
    let frame = 0
    let last = 0

    const clear = () => {
      for (const target of targets) {
        target.element.style.removeProperty(target.property)
        target.element.style.removeProperty('will-change')
      }
    }

    const measure = () => {
      clear()
      viewportHeight = window.innerHeight
      maxScroll = Math.max(0, document.documentElement.scrollHeight - viewportHeight)
      targets = rules.flatMap((rule) =>
        Array.from(root.querySelectorAll<HTMLElement>(rule.selector)).map((element, index) => ({
          element,
          rule,
          property: SCRUB_PROPERTY[rule.kind ?? 'enter'],
          index,
          top: documentTop(element),
          written: Number.NaN,
          moving: false,
        })),
      )
    }

    const paint = (y: number) => {
      for (const target of targets) {
        const value = scrubAmount(target.rule, target.index, y, target.top, viewportHeight, maxScroll)
        // Small steps are skipped, but the end stops must always land exactly
        const atEnd = value === 0 || value === 1
        if (value === target.written || (!atEnd && Math.abs(value - target.written) < 0.001)) continue
        target.written = value
        target.element.style.setProperty(target.property, value.toFixed(3))
        // Promoted only while moving: many of these pieces carry a filter
        const moving = value > 0 && value < 1
        if (moving !== target.moving) {
          target.moving = moving
          target.element.style.willChange = moving ? 'translate, rotate, scale' : ''
        }
      }
    }

    const tick = (now: number) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0.016
      last = now
      const goal = window.scrollY
      shown += (goal - shown) * Math.min(1, dt * 12)
      if (Math.abs(goal - shown) < 0.4) shown = goal
      paint(shown)
      if (shown === goal) {
        frame = 0
        last = 0
      } else {
        frame = requestAnimationFrame(tick)
      }
    }

    const wake = () => {
      if (!frame) frame = requestAnimationFrame(tick)
    }

    const remeasure = () => {
      measure()
      paint(shown)
      wake()
    }

    remeasure()
    window.addEventListener('scroll', wake, { passive: true })
    window.addEventListener('resize', remeasure)
    // The video controls and chapter copy change the page height after mount
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(remeasure)
    observer?.observe(root)

    return () => {
      if (frame) cancelAnimationFrame(frame)
      window.removeEventListener('scroll', wake)
      window.removeEventListener('resize', remeasure)
      observer?.disconnect()
      clear()
    }
  }, [rootRef, rules, enabled])
}
