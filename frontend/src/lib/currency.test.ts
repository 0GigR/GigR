/**
 * currency.test.ts — pure display-currency formatting rules.
 */
import { describe, expect, it } from 'vitest'
import { formatAmount, isCurrencyCode, symbolFor, type CurrencyCode } from './currency'

describe('formatAmount', () => {
  it('formats NGN with thousands separators and no decimals', () => {
    expect(formatAmount(15000, 'NGN')).toBe('₦15,000')
    expect(formatAmount(8000, 'NGN')).toBe('₦8,000')
  })

  it('converts to the chosen currency using the NGN rate', () => {
    // rate = "1 NGN = rate USD", so 15000 NGN ≈ $10 at 1500
    expect(formatAmount(15000, 'USD', 1500)).toBe('$10')
  })

  it('rounds whole-dollar/whole-currency amounts cleanly', () => {
    expect(formatAmount(15000, 'USD', 1500)).toBe('$10')
    expect(formatAmount(30000, 'GBP', 2000)).toBe('£15')
  })

  it('falls back to Naira when a rate is missing (never shows a wrong number)', () => {
    expect(formatAmount(5000, 'EUR', undefined)).toBe('₦5,000')
  })

  it('handles zero and garbage amounts safely', () => {
    expect(formatAmount(0, 'USD', 1500)).toBe('$0')
  })
})

describe('currency metadata', () => {
  it('validates supported codes and symbols', () => {
    expect(isCurrencyCode('NGN')).toBe(true)
    expect(isCurrencyCode('USD')).toBe(true)
    expect(isCurrencyCode('XYZ')).toBe(false)
    expect(symbolFor('USD' as CurrencyCode)).toBe('$')
  })
})
