/**
 * usePrefersReducedMotion.ts - the one reduced-motion read for the /judges
 * page. The video uses it to refuse to autoplay; the agent flow uses it to
 * swap its animated stage for a static list. Both must see the same value, so
 * the media query lives here instead of in either component.
 */

import { useEffect, useState } from 'react'

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (!window.matchMedia) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return reduced
}
