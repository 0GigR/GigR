/**
 * phone.ts — Phone number normalization, validation, and display formatting.
 *
 * Normalizes phone numbers to standard E.164 (+234...).
 * Handles Nigerian local variants:
 *   - '+2349019549999'
 *   - '2349019549999'
 *   - '09019549999'
 *   - '9019549999'
 *   - '+234 901 954 9999'
 *   - '+23409019549999'
 * All resolve to '+2349019549999'.
 */

export function normalizePhoneNumber(raw: string): string {
  if (!raw || typeof raw !== 'string') return ''
  const trimmed = raw.trim()
  if (!trimmed) return ''

  const hasPlus = trimmed.startsWith('+')
  let digits = trimmed.replace(/\D/g, '')
  if (!digits) return ''

  // International dialing prefix 00 -> +
  if (digits.startsWith('00')) {
    digits = digits.slice(2)
  }

  // Starts with 234: e.g. 2349019549999 or 23409019549999
  if (digits.startsWith('234')) {
    let local = digits.slice(3)
    if (local.startsWith('0')) {
      local = local.slice(1)
    }
    return `+234${local}`
  }

  // Local Nigerian format starting with 0 (11 digits): e.g. 09019549999
  if (digits.startsWith('0') && digits.length === 11) {
    return `+234${digits.slice(1)}`
  }

  // 10 digits without leading 0: e.g. 9019549999
  if (digits.length === 10 && ['7', '8', '9'].includes(digits[0])) {
    return `+234${digits}`
  }

  // International number with leading plus
  if (hasPlus) {
    return `+${digits}`
  }

  // Standard phone sequence >= 11 digits
  if (digits.length >= 11) {
    return `+${digits}`
  }

  return `+${digits}`
}

/**
 * Format a phone number cleanly for human display:
 * '+2349019549999' -> '+234 901 954 9999'
 */
export function formatPhoneDisplay(raw: string): string {
  const normalized = normalizePhoneNumber(raw)
  if (!normalized) return raw

  if (normalized.startsWith('+234') && normalized.length === 14) {
    const area = normalized.slice(4, 7)
    const part1 = normalized.slice(7, 10)
    const part2 = normalized.slice(10)
    return `+234 ${area} ${part1} ${part2}`
  }

  return normalized
}

/**
 * Check if the input looks like a valid phone number.
 */
export function isValidPhoneNumber(raw: string): boolean {
  if (!raw) return true // Optional field in some places
  const normalized = normalizePhoneNumber(raw)
  // E.164 valid lengths range from 8 to 16 characters including '+'
  return normalized.length >= 8 && normalized.length <= 16
}
