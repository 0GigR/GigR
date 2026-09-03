/**
 * store/currencyStore.ts — the user's chosen DISPLAY currency (persisted).
 *
 * Gigr's canonical price is Naira (NGN) and never changes — jobs are stored and
 * escrowed in ₦. This store only controls how prices are FORMATTED on screen:
 * the user picks a display currency, we cache NGN exchange rates (localStorage),
 * and every price node renders converted via `fmtPrice`.
 *
 * Reload discipline: only `applyDisplayCurrency` reloads (once) to re-render the
 * whole UI in the new currency. Boot (`initCurrencyDisplay`) NEVER reloads — it
 * loads rates in the background so the persisted code + cached rates are already
 * present on the next reload. Without this, a boot-time reload would loop.
 */

import { create } from 'zustand'
import {
  CURRENCIES,
  formatAmount,
  DEFAULT_CURRENCY,
  type CurrencyCode,
  type NgnRates,
} from '@/lib/currency'

const RATES_URL = 'https://open.er-api.com/v6/latest/NGN'
const STORAGE_KEY = 'gigr-display-currency'

interface Persisted {
  code: CurrencyCode
  rates: NgnRates | null
}

function readStored(): Persisted {
  const fallback: Persisted = { code: DEFAULT_CURRENCY, rates: null }
  try {
    if (typeof window === 'undefined') return fallback
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as { code?: unknown; rates?: unknown }
    const code = CURRENCIES.some((c) => c.code === parsed.code)
      ? (parsed.code as CurrencyCode)
      : DEFAULT_CURRENCY
    const rates: NgnRates = {}
    if (parsed.rates && typeof parsed.rates === 'object') {
      for (const c of CURRENCIES) {
        const r = (parsed.rates as Record<string, unknown>)[c.code]
        if (c.code !== 'NGN' && typeof r === 'number' && r > 0) rates[c.code] = r
      }
    }
    return { code, rates: Object.keys(rates).length ? rates : null }
  } catch {
    return fallback
  }
}

function persist(next: Persisted): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // ignore (private mode etc.)
  }
}

const initial = readStored()

interface CurrencyState extends Persisted {
  setCode: (code: CurrencyCode) => void
  loadRates: () => Promise<void>
}

export const useCurrencyStore = create<CurrencyState>((set) => ({
  code: initial.code,
  rates: initial.rates,

  setCode: (code) => {
    set((s) => {
      const next: Persisted = { code, rates: s.rates }
      persist(next)
      return next
    })
  },

  loadRates: async () => {
    try {
      const res = await fetch(RATES_URL)
      const data = await res.json()
      const remote = data?.rates ?? {}
      const rates: NgnRates = {}
      for (const c of CURRENCIES) {
        if (c.code !== 'NGN' && typeof remote[c.code] === 'number') rates[c.code] = remote[c.code]
      }
      if (Object.keys(rates).length === 0) return
      set((s) => {
        const next: Persisted = { code: s.code, rates }
        persist(next)
        return next
      })
    } catch {
      // Offline / rate service down → keep cached rates; formatting falls back
      // to NGN only if there is no cached rate for the chosen currency.
    }
  },
}))

/**
 * Format a Naira amount (number or string) in the user's current display
 * currency. Read synchronously from the store — every renderer calls this.
 */
export function fmtPrice(ngn: number | string): string {
  const n = typeof ngn === 'string' ? parseFloat(ngn) : ngn
  const { code, rates } = useCurrencyStore.getState()
  const safe = Number.isFinite(n) ? n : 0
  return formatAmount(safe, code, code === 'NGN' ? 1 : rates?.[code])
}

/**
 * Switch the display currency. Loads (and caches) fresh rates, then reloads ONCE
 * so the whole UI re-renders in the new currency. If rates can't be fetched we
 * stay in NGN rather than showing unconverted numbers.
 */
export async function applyDisplayCurrency(code: CurrencyCode): Promise<void> {
  useCurrencyStore.getState().setCode(code)
  await useCurrencyStore.getState().loadRates()
  const { rates } = useCurrencyStore.getState()
  if (code !== 'NGN' && rates?.[code] == null) {
    // No rate available — don't show wrong conversions; revert to Naira.
    useCurrencyStore.getState().setCode(DEFAULT_CURRENCY)
  }
  // Reload a beat later so a caller (e.g. a WebMCP tool) can still return its
  // response before the page navigates.
  if (typeof window !== 'undefined') {
    window.setTimeout(() => window.location.reload(), 350)
  }
}

/**
 * Called once at boot. If the user previously chose a non-NGN display currency
 * but the rates are stale/missing (e.g. first run on this device), fetch them in
 * the background. Never reloads here — the cached rates mean the NEXT navigation
 * converts immediately, and only applyDisplayCurrency triggers reloads.
 */
export function initCurrencyDisplay(): void {
  const { code, rates } = useCurrencyStore.getState()
  if (code === 'NGN') return
  if (rates?.[code] != null) return // already convertible from cache
  void useCurrencyStore.getState().loadRates()
}
