import { describe, expect, it } from 'vitest'
import {
  classifyBriefResponse,
  errorDetail,
  formatAtomicUsdc,
  formatQuoteExpiry,
  isJobId,
  parseX402Quote,
  x402ReasonText,
} from './x402Challenge'

const JOB_ID = '123e4567-e89b-12d3-a456-426614174000'

const CHALLENGE = {
  x402Version: 1,
  accepts: [
    {
      scheme: 'exact',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      maxAmountRequired: '10000',
      resource: `https://api.gigr.example/api/v1/agent/brief?job_id=${JOB_ID}`,
      description: 'A factual brief on one Gigr job and its provider recorded history.',
      mimeType: 'application/json',
      payTo: '9xQeWvG816bUx9EPf6j7Y9VCk9U5oP7eK7u3yVd8Yh2S',
      asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      maxTimeoutSeconds: 300,
      extra: {
        nonce: 'quote-nonce-1',
        expiresAt: '2026-10-29T15:05:00+01:00',
        mintDecimals: 6,
        mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      },
    },
  ],
  error: 'payment_missing',
}

describe('formatAtomicUsdc', () => {
  it('converts atomic units with the stated decimals', () => {
    expect(formatAtomicUsdc('10000', 6)).toBe('0.01')
    expect(formatAtomicUsdc('1', 6)).toBe('0.000001')
    expect(formatAtomicUsdc('1000000', 6)).toBe('1')
    expect(formatAtomicUsdc('123456789', 6)).toBe('123.456789')
    expect(formatAtomicUsdc('0', 6)).toBe('0')
  })

  it('keeps the amount exact with string arithmetic', () => {
    // Larger than a float keeps exact: 9007199254740993 atomic units.
    expect(formatAtomicUsdc('9007199254740993', 6)).toBe('9007199254.740993')
  })

  it('honours zero decimals', () => {
    expect(formatAtomicUsdc('10000', 0)).toBe('10000')
  })

  it('refuses to format an amount it cannot read', () => {
    expect(formatAtomicUsdc('1e6', 6)).toBeNull()
    expect(formatAtomicUsdc('-1', 6)).toBeNull()
    expect(formatAtomicUsdc('10.5', 6)).toBeNull()
    expect(formatAtomicUsdc('10000', null)).toBeNull()
    expect(formatAtomicUsdc('10000', 19)).toBeNull()
  })
})

describe('formatQuoteExpiry', () => {
  it('prints an instant as fixed UTC', () => {
    expect(formatQuoteExpiry('2026-10-29T15:05:00Z')).toBe('2026-10-29 15:05:00 UTC')
  })

  it('converts an offset to UTC instead of printing the local clock', () => {
    expect(formatQuoteExpiry('2026-10-29T15:05:00+01:00')).toBe('2026-10-29 14:05:00 UTC')
  })

  it('returns null for a missing or unreadable expiry', () => {
    expect(formatQuoteExpiry(null)).toBeNull()
    expect(formatQuoteExpiry('soon')).toBeNull()
  })
})

describe('x402ReasonText', () => {
  it('explains the reason a fresh request returns', () => {
    expect(x402ReasonText('payment_missing')).toContain('no payment')
  })

  it('explains the refusals a paying agent can meet', () => {
    expect(x402ReasonText('wrong_mint')).toContain('different token')
    expect(x402ReasonText('underpaid')).toContain('less than the quoted amount')
    expect(x402ReasonText('payment_already_used')).toContain('one brief')
  })

  it('names an unknown reason and an absent one instead of staying generic', () => {
    expect(x402ReasonText('brand_new_reason')).toContain('brand_new_reason')
    expect(x402ReasonText(null)).toBe('The endpoint did not state a reason.')
  })
})

describe('parseX402Quote', () => {
  it('reads the accepted scheme into display fields', () => {
    const quote = parseX402Quote(CHALLENGE)
    expect(quote).not.toBeNull()
    expect(quote).toMatchObject({
      scheme: 'exact',
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      amountAtomic: '10000',
      amountUsdc: '0.01',
      decimals: 6,
      payTo: '9xQeWvG816bUx9EPf6j7Y9VCk9U5oP7eK7u3yVd8Yh2S',
      reason: 'payment_missing',
      nonce: 'quote-nonce-1',
      maxTimeoutSeconds: 300,
    })
    expect(quote?.expiresAtLabel).toBe('2026-10-29 14:05:00 UTC')
    expect(quote?.resource).toContain(`job_id=${JOB_ID}`)
  })

  it('refuses a body without an accepted option or a required fact', () => {
    expect(parseX402Quote({ accepts: [] })).toBeNull()
    expect(parseX402Quote({})).toBeNull()
    expect(parseX402Quote(null)).toBeNull()

    const noPayTo = structuredClone(CHALLENGE) as Record<string, unknown>
    delete (noPayTo.accepts as Record<string, unknown>[])[0].payTo
    expect(parseX402Quote(noPayTo)).toBeNull()

    const noAmount = structuredClone(CHALLENGE) as Record<string, unknown>
    delete (noAmount.accepts as Record<string, unknown>[])[0].maxAmountRequired
    expect(parseX402Quote(noAmount)).toBeNull()
  })

  it('keeps the atomic amount readable when decimals are missing', () => {
    const body = structuredClone(CHALLENGE) as Record<string, unknown>
    const extra = (body.accepts as Record<string, unknown>[])[0].extra as Record<string, unknown>
    delete extra.mintDecimals
    const quote = parseX402Quote(body)
    expect(quote?.amountUsdc).toBeNull()
    expect(quote?.amountAtomic).toBe('10000')
  })
})

describe('classifyBriefResponse', () => {
  it('classifies a 402 with a challenge as a quote', () => {
    const outcome = classifyBriefResponse(402, CHALLENGE)
    expect(outcome.kind).toBe('quote')
    if (outcome.kind === 'quote') expect(outcome.quote.amountUsdc).toBe('0.01')
  })

  it('calls a 402 without a challenge an error, not a quote', () => {
    const outcome = classifyBriefResponse(402, { detail: 'not an x402 body' })
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.detail).toContain('not a readable x402 challenge')
  })

  it('distinguishes the flag-off 404 from an unknown job 404', () => {
    const off = classifyBriefResponse(404, {
      detail: 'Agent briefs are not offered by this deployment. Use the job and rating endpoints instead.',
    })
    expect(off.kind).toBe('feature_disabled')
    if (off.kind === 'feature_disabled') expect(off.detail).toContain('not offered')

    const missing = classifyBriefResponse(404, {
      detail: 'No job has that id. Check job_id against the job you were given and try again.',
    })
    expect(missing.kind).toBe('job_not_found')
    if (missing.kind === 'job_not_found') expect(missing.detail).toContain('No job has that id')
  })

  it('treats content without a challenge as unexpected, never as a purchase', () => {
    const outcome = classifyBriefResponse(200, { status: 'paid', brief: {} })
    expect(outcome.kind).toBe('unexpected')
    if (outcome.kind === 'unexpected') expect(outcome.detail).toContain('does not treat that as a purchase')
  })

  it('keeps the backend detail and the status of other failures', () => {
    const outcome = classifyBriefResponse(503, { detail: 'gateway unavailable' })
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') {
      expect(outcome.detail).toContain('503')
      expect(outcome.detail).toContain('gateway unavailable')
    }

    const bare = classifyBriefResponse(500, null)
    expect(bare.kind).toBe('error')
    if (bare.kind === 'error') expect(bare.detail).toContain('500')
  })
})

describe('errorDetail', () => {
  it('reads a string detail and stringifies a structured one', () => {
    expect(errorDetail({ detail: ' nope ' })).toBe('nope')
    expect(errorDetail({ detail: [{ loc: ['query', 'job_id'] }] })).toContain('job_id')
    expect(errorDetail(null)).toBeNull()
    expect(errorDetail({ detail: '   ' })).toBeNull()
  })
})

describe('isJobId', () => {
  it('accepts a UUID, in either case and with padding', () => {
    expect(isJobId(JOB_ID)).toBe(true)
    expect(isJobId(`  ${JOB_ID.toUpperCase()}  `)).toBe(true)
  })

  it('rejects anything that cannot name a job', () => {
    expect(isJobId('')).toBe(false)
    expect(isJobId('123e4567e89b12d3a456426614174000')).toBe(false)
    expect(isJobId('not-a-uuid')).toBe(false)
  })
})
