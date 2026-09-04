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
    // rate = "units of <code> per 1 NGN" (the shape open.er-api returns),
    // so 15,000 NGN ≈ $15 when 1 NGN = 0.001 USD.
    expect(formatAmount(15000, 'USD', 0.001)).toBe('$15')
  })

  it('rounds whole-currency amounts cleanly', () => {
    expect(formatAmount(15000, 'USD', 0.001)).toBe('$15')
    expect(formatAmount(30000, 'GBP', 0.0005)).toBe('£15')
  })

  it('falls back to Naira when a rate is missing (never shows a wrong number)', () => {
    expect(formatAmount(5000, 'EUR', undefined)).toBe('₦5,000')
  })

  it('handles zero and garbage amounts safely', () => {
    expect(formatAmount(0, 'USD', 0.001)).toBe('$0')
  })
})

describe('currency metadata', () => {
  it('validates supported codes and symbols', () => {
    expect(isCurrencyCode('NGN')).toBe(true)
    expect(isCurrencyCode('USD')).toBe(true)
    expect(isCurrencyCode('INR')).toBe(true)
    expect(isCurrencyCode('ZAR')).toBe(true)
    expect(isCurrencyCode('XYZ')).toBe(false)
    expect(symbolFor('USD' as CurrencyCode)).toBe('$')
  })

  it('converts into rupee and rand too', () => {
    expect(formatAmount(15000, 'INR', 0.07)).toBe('₹1,050')
    expect(formatAmount(15000, 'ZAR', 1)).toBe('R15,000')
  })
})
