import { describe, it, expect } from 'vitest'
import { normalizePhoneNumber, formatPhoneDisplay, isValidPhoneNumber } from './phone'

describe('phone normalization', () => {
  it('normalizes Nigerian phone number formats to E.164 +2349019549999', () => {
    const inputs = [
      '+2349019549999',
      '2349019549999',
      '09019549999',
      '9019549999',
      '+234 901 954 9999',
      '+23409019549999',
      '090-1954-9999',
      '(234) 901 954 9999',
    ]

    for (const input of inputs) {
      expect(normalizePhoneNumber(input)).toBe('+2349019549999')
    }
  })

  it('normalizes other 11-digit local Nigerian numbers', () => {
    expect(normalizePhoneNumber('08031234567')).toBe('+2348031234567')
    expect(normalizePhoneNumber('8031234567')).toBe('+2348031234567')
    expect(normalizePhoneNumber('07011223344')).toBe('+2347011223344')
  })

  it('normalizes international numbers', () => {
    expect(normalizePhoneNumber('+1 (555) 234-5678')).toBe('+15552345678')
    expect(normalizePhoneNumber('+44 7911 123456')).toBe('+447911123456')
  })

  it('formats display strings cleanly', () => {
    expect(formatPhoneDisplay('+2349019549999')).toBe('+234 901 954 9999')
    expect(formatPhoneDisplay('09019549999')).toBe('+234 901 954 9999')
  })

  it('validates phone number strings accurately', () => {
    expect(isValidPhoneNumber('09019549999')).toBe(true)
    expect(isValidPhoneNumber('+2349019549999')).toBe(true)
    expect(isValidPhoneNumber('')).toBe(true) // optional
    expect(isValidPhoneNumber('123')).toBe(false)
  })
})
