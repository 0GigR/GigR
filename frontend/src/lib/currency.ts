/**
 * currency.ts — display-currency helpers (pure).
 *
 * Gigr stores and settles every price in Nigerian Naira (NGN) — that is the
 * app's canonical currency and never changes. This module lets a user CHOOSE
 * the currency prices are *shown* in (default NGN), converting at the latest
 * exchange rate purely at display time. Nothing stored is ever converted.
 */

export const CURRENCIES = [
  { code: 'NGN', symbol: '₦', label: 'Nigerian Naira', decimals: 0 },
  { code: 'USD', symbol: '$', label: 'US Dollar', decimals: 0 },
  { code: 'GBP', symbol: '£', label: 'British Pound', decimals: 0 },
  { code: 'EUR', symbol: '€', label: 'Euro', decimals: 0 },
] as const

export type CurrencyCode = (typeof CURRENCIES)[number]['code']

export const DEFAULT_CURRENCY: CurrencyCode = 'NGN'

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return CURRENCIES.some((c) => c.code === value)
}

export function symbolFor(code: CurrencyCode): string {
  return CURRENCIES.find((c) => c.code === code)?.symbol ?? '₦'
}

/** Rates expressed as "1 NGN = X units of <code>" (i.e. divide NGN by the rate). */
export type NgnRates = Partial<Record<CurrencyCode, number>>

/**
 * Format a Naira amount in the requested display currency.
 *
 * - NGN → plain Naira with thousands separators.
 * - Other codes → converted via `rate` (1 NGN = `rate` of that currency).
 *   If no rate is available yet it safely falls back to Naira rather than
 *   showing a wrong number.
 */
export function formatAmount(ngn: number, code: CurrencyCode, rate?: number): string {
  const amount = Number(ngn) || 0
  if (code === 'NGN') {
    return `₦${Math.round(amount).toLocaleString()}`
  }
  if (!rate || rate <= 0) {
    return `₦${Math.round(amount).toLocaleString()}`
  }
  const meta = CURRENCIES.find((c) => c.code === code)
  const converted = amount / rate
  const decimals = meta?.decimals ?? 0
  const formatted = converted.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  return `${meta?.symbol ?? '$'}${formatted}`
}
