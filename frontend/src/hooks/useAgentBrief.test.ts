/**
 * useAgentBrief.test.ts - the paid-brief requests, pinned at the boundary.
 *
 * The wrapper is the only place the panel touches the endpoint, so the calls it
 * makes are pinned here: the GET path and job id, a timeout above the recall
 * budget, every status classified instead of thrown, and no payment header. A
 * 402 is the expected answer, not a failure.
 *
 * The purchase call is pinned the same way, plus the one thing that makes it
 * different: its timeout outlasts the server's confirmation window, and a lost
 * answer says "check this purchase again" rather than "failed".
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn(),
  postMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  default: { get: getMock, post: postMock },
}))

import {
  BRIEF_REQUEST_TIMEOUT_MS,
  PURCHASE_REQUEST_TIMEOUT_MS,
  PROVIDER_PAGE_SIZE,
  PROVIDER_REQUEST_TIMEOUT_MS,
  fetchBriefProviders,
  purchaseAgentBrief,
  requestAgentBriefQuote,
} from './useAgentBrief'

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

beforeEach(() => {
  getMock.mockReset()
  postMock.mockReset()
})

describe('requestAgentBriefQuote', () => {
  it('asks for the quote with the job id and accepts a 402 as an answer', async () => {
    getMock.mockResolvedValue({ status: 402, data: CHALLENGE })

    const outcome = await requestAgentBriefQuote(JOB_ID)

    expect(getMock).toHaveBeenCalledTimes(1)
    const [path, options] = getMock.mock.calls[0]
    expect(path).toBe('/agent/brief')
    expect(options.params).toEqual({ job_id: JOB_ID })
    expect(options.timeout).toBe(BRIEF_REQUEST_TIMEOUT_MS)
    expect(options.timeout).toBeGreaterThan(15000)
    // No payment header: this request cannot buy a brief.
    expect(options.headers).toBeUndefined()
    // 402 and 404 are classified, so axios must not throw them away.
    expect(options.validateStatus(402)).toBe(true)
    expect(options.validateStatus(404)).toBe(true)
    expect(options.validateStatus(500)).toBe(true)

    expect(outcome.kind).toBe('quote')
    if (outcome.kind === 'quote') {
      expect(outcome.quote.amountUsdc).toBe('0.01')
      expect(outcome.quote.reason).toBe('payment_missing')
    }
  })

  it('reports the flag-off 404 as a disabled feature, not a missing job', async () => {
    getMock.mockResolvedValue({
      status: 404,
      data: {
        detail: 'Agent briefs are not offered by this deployment. Use the job and rating endpoints instead.',
      },
    })

    const outcome = await requestAgentBriefQuote(JOB_ID)
    expect(outcome.kind).toBe('feature_disabled')
  })

  it('names a timeout instead of reporting a generic failure', async () => {
    getMock.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }))

    const outcome = await requestAgentBriefQuote(JOB_ID)
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.detail).toContain('took too long')
  })

  it('does not throw when the endpoint cannot be reached', async () => {
    getMock.mockRejectedValue(new Error('Network Error'))

    const outcome = await requestAgentBriefQuote(JOB_ID)
    expect(outcome.kind).toBe('error')
    if (outcome.kind === 'error') expect(outcome.detail).toContain('could not reach')
  })
})

describe('fetchBriefProviders', () => {
  const PROVIDER_ROW = {
    provider_id: 'da15e7cb-2103-4d71-904b-2c6cb7616f66',
    name: 'OKAFOR KOSISOCHUKWU',
    category: 'Home Services',
    rating_count: 3,
    rating_average: 4,
    completed_jobs: 3,
    job_id: 'ff099832-29a6-48ad-9d42-02bbdd016010',
    job_title: 'Traditional Private Chef',
    job_price: 5000,
  }

  it('asks the provider index once, for one page, and reads the job each row carries', async () => {
    getMock.mockResolvedValue({ data: { providers: [PROVIDER_ROW] } })

    const providers = await fetchBriefProviders()

    expect(getMock).toHaveBeenCalledTimes(1)
    const [path, options] = getMock.mock.calls[0]
    expect(path).toBe('/agent/brief/providers')
    expect(options.params).toEqual({ limit: PROVIDER_PAGE_SIZE })
    expect(options.timeout).toBe(PROVIDER_REQUEST_TIMEOUT_MS)
    expect(options.timeout).toBeGreaterThanOrEqual(15000)
    // The brief endpoint is still keyed by job, so the row must hand one over.
    expect(providers[0].jobId).toBe(PROVIDER_ROW.job_id)
    expect(providers[0].name).toBe(PROVIDER_ROW.name)
  })

  it('throws when the list cannot be read, so the picker can say so', async () => {
    getMock.mockRejectedValue(new Error('provider index failed'))

    await expect(fetchBriefProviders()).rejects.toThrow('provider index failed')
  })
})

const PAID_BODY = {
  status: 'paid',
  already_purchased: false,
  payment: {
    signature:
      '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW',
    network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
    mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    amount_atomic: 10000,
    pay_to: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
  },
  brief: {
    job_id: '123e4567-e89b-12d3-a456-426614174000',
    title: 'Fix the leaking kitchen sink',
    job_status: 'open',
    posted_price: 120,
    provider_id: null,
    ratings: { count: 0, average: null, distribution: {} },
    completed_jobs: 3,
    comparable_jobs: { count: 0, min_price: null, max_price: null, average_price: null },
    disputes: { total: 0, open: 0, resolved: 0 },
    has_history: true,
    summary: 'Provider history: 3 completed jobs, no ratings, no disputes.',
  },
}

const NO_USDC_BODY = {
  status: 'failed',
  reason: 'insufficient_usdc',
  message:
    'Your Gigr wallet holds 0 USDC and this brief costs 0.01 USDC. Add USDC to your wallet and tap Buy this brief again. Nothing was charged.',
  payment_state: 'none',
  signature: null,
  required_atomic: 10000,
  available_atomic: 0,
}

describe('purchaseAgentBrief', () => {
  it('posts the job id to the purchase route and accepts every status', async () => {
    postMock.mockResolvedValue({ status: 200, data: PAID_BODY })

    const outcome = await purchaseAgentBrief(JOB_ID)

    expect(postMock).toHaveBeenCalledTimes(1)
    const [path, body, options] = postMock.mock.calls[0]
    expect(path).toBe('/agent/brief/purchase')
    expect(body).toBeNull()
    expect(options.params).toEqual({ job_id: JOB_ID })
    // The server waits for a confirmation (up to 30s) before it answers.
    expect(options.timeout).toBe(PURCHASE_REQUEST_TIMEOUT_MS)
    expect(options.timeout).toBeGreaterThan(30000)
    // No X-PAYMENT header and no key: the server signs for the signed-in user.
    expect(options.headers).toBeUndefined()
    // A 402 is "you have no USDC", a typed answer, not a thrown error.
    expect(options.validateStatus(402)).toBe(true)
    expect(options.validateStatus(504)).toBe(true)
    expect(options.validateStatus(500)).toBe(true)

    expect(outcome.kind).toBe('paid')
    if (outcome.kind === 'paid') {
      expect(outcome.brief.summary).toContain('3 completed jobs')
      expect(outcome.signature).toBe(PAID_BODY.payment.signature)
    }
  })

  it('returns the no-USDC refusal as a failure that charged nothing', async () => {
    postMock.mockResolvedValue({ status: 402, data: NO_USDC_BODY })

    const outcome = await purchaseAgentBrief(JOB_ID)

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.reason).toBe('insufficient_usdc')
    expect(outcome.paymentState).toBe('none')
    expect(outcome.signature).toBeNull()
    expect(outcome.message).toContain('holds 0 USDC')
  })

  it('keeps the signature of a submitted transfer on a timeout', async () => {
    postMock.mockResolvedValue({
      status: 504,
      data: {
        status: 'pending',
        reason: 'confirmation_timeout',
        message:
          'The transfer has not been confirmed yet. Do not pay again: tap Buy this brief again to check this same transfer. The transfer was submitted and may still confirm; its signature is below.',
        payment_state: 'submitted',
        signature: PAID_BODY.payment.signature,
      },
    })

    const outcome = await purchaseAgentBrief(JOB_ID)

    expect(outcome.kind).toBe('pending')
    if (outcome.kind !== 'pending') return
    expect(outcome.signature).toBe(PAID_BODY.payment.signature)
    expect(outcome.paymentState).toBe('submitted')
  })

  it('does not call a client timeout a failure', async () => {
    postMock.mockRejectedValue(Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }))

    const outcome = await purchaseAgentBrief(JOB_ID)

    expect(outcome.kind).toBe('no_answer')
    if (outcome.kind !== 'no_answer') return
    expect(outcome.message).toContain('Do not pay again')
    expect(outcome.message).not.toContain('Nothing was charged')
  })

  it('does not call an unreachable endpoint a failure either', async () => {
    postMock.mockRejectedValue(new Error('Network Error'))

    const outcome = await purchaseAgentBrief(JOB_ID)

    expect(outcome.kind).toBe('no_answer')
    if (outcome.kind !== 'no_answer') return
    expect(outcome.message).toContain('check your wallet activity')
  })
})
