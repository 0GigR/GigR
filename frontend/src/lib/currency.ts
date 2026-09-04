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
  { code: 'INR', symbol: '₹', label: 'Indian Rupee', decimals: 0 },
  { code: 'ZAR', symbol: 'R', label: 'South African Rand', decimals: 0 },
  { code: 'KES', symbol: 'KSh', label: 'Kenyan Shilling', decimals: 0 },
  { code: 'GHS', symbol: 'GH₵', label: 'Ghanaian Cedi', decimals: 0 },
  { code: 'EGP', symbol: 'E£', label: 'Egyptian Pound', decimals: 0 },
  { code: 'CAD', symbol: 'C$', label: 'Canadian Dollar', decimals: 0 },
  { code: 'AUD', symbol: 'A$', label: 'Australian Dollar', decimals: 0 },
  { code: 'AED', symbol: 'AED', label: 'UAE Dirham', decimals: 0 },
  { code: 'SAR', symbol: 'SAR', label: 'Saudi Riyal', decimals: 0 },
  { code: 'JPY', symbol: '¥', label: 'Japanese Yen', decimals: 0 },
  { code: 'CNY', symbol: 'CN¥', label: 'Chinese Yuan', decimals: 0 },
] as const

export type CurrencyCode = (typeof CURRENCIES)[number]['code']

export const DEFAULT_CURRENCY: CurrencyCode = 'NGN'

export function isCurrencyCode(value: unknown): value is CurrencyCode {
  return CURRENCIES.some((c) => c.code === value)
}

export function symbolFor(code: CurrencyCode): string {
  return CURRENCIES.find((c) => c.code === code)?.symbol ?? '₦'
}

/** Rates as open.er-api returns them for base NGN: "1 NGN = X units of <code>".
 *  A Naira amount converts by multiplying by the rate (15000 NGN × 0.000755 USD ≈ $11.30). */
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
  // rate is "units of <code> per 1 NGN" → multiply the Naira amount.
  const converted = amount * rate
  const decimals = meta?.decimals ?? 0
  const formatted = converted.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
  return `${meta?.symbol ?? '$'}${formatted}`
}
