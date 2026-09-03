/**
 * store/currencyStore.ts — the user's chosen DISPLAY currency (persisted).
 *
 * Gigr's canonical price is Naira (NGN) and never changes — jobs are stored and
 * escrowed in ₦. This store only controls how prices are FORMATTED on screen:
 * the user picks a display currency, we fetch NGN exchange rates once, and every
 * price node renders converted via `fmtPrice`. Changing currency reloads the app
 * so the whole UI re-renders consistently with the new setting.
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

function readStoredCode(): CurrencyCode {
  try {
    if (typeof window === 'undefined') return DEFAULT_CURRENCY
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_CURRENCY
    const parsed = JSON.parse(raw) as { state?: { code?: unknown } } | { code?: unknown } | null
    const code = parsed && 'state' in parsed ? (parsed as { state: { code?: unknown } }).state?.code : (parsed as { code?: unknown } | null)?.code
    return CURRENCIES.some((c) => c.code === code) ? (code as CurrencyCode) : DEFAULT_CURRENCY
  } catch {
    return DEFAULT_CURRENCY
  }
}

function writeStoredCode(code: CurrencyCode): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ code }))
  } catch {
    // ignore (private mode etc.)
  }
}

interface CurrencyState {
  code: CurrencyCode
  rates: NgnRates | null
  setCode: (code: CurrencyCode) => void
  loadRates: () => Promise<void>
}

export const useCurrencyStore = create<CurrencyState>((set) => ({
  code: readStoredCode(),
  rates: null,

  setCode: (code) => {
    writeStoredCode(code)
    set({ code })
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
      if (Object.keys(rates).length > 0) set({ rates })
    } catch {
      // Offline / rate service down → keep existing rates; formatting will
      // safely fall back to NGN until a rate is available.
    }
  },
}))

/**
 * Format a Naira amount (number or string) in the user's current display
 * currency. Read synchronously from the store — every renderer calls this, so
 * once the app reloads with the chosen currency every price converts.
 */
export function fmtPrice(ngn: number | string): string {
  const n = typeof ngn === 'string' ? parseFloat(ngn) : ngn
  const { code, rates } = useCurrencyStore.getState()
  const safe = Number.isFinite(n) ? n : 0
  return formatAmount(safe, code, code === 'NGN' ? 1 : rates?.[code])
}

/**
 * Switch the display currency. Fetches fresh rates and reloads so the entire
 * UI re-renders in the new currency. If rates can't be fetched we stay in NGN
 * rather than showing unconverted numbers.
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
 * Called once at boot: if the user previously chose a non-NGN display currency,
 * make sure rates are loaded (then reload so prices convert immediately).
 */
export function initCurrencyDisplay(): void {
  const { code, rates } = useCurrencyStore.getState()
  if (code === 'NGN') return
  if (rates?.[code] != null) return
  useCurrencyStore.getState().loadRates().then(() => {
    const { code: current, rates: r } = useCurrencyStore.getState()
    if (current !== 'NGN' && r?.[current] != null && typeof window !== 'undefined') {
      window.location.reload()
    }
  })
}
