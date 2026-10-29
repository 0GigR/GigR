/**
 * useAgentBrief.test.ts - the paid-brief request must ask, not buy.
 *
 * The wrapper is the only place the panel touches the endpoint, so the calls it
 * makes are pinned here: the GET path and job id, a timeout above the recall
 * budget, every status classified instead of thrown, and no payment header. A
 * 402 is the expected answer, not a failure.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getMock } = vi.hoisted(() => ({ getMock: vi.fn() }))

vi.mock('@/lib/api', () => ({
  default: { get: getMock },
}))

import {
  BRIEF_REQUEST_TIMEOUT_MS,
  fetchAgentBriefJobs,
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

describe('fetchAgentBriefJobs', () => {
  it('reads the caller client and provider jobs and deduplicates them', async () => {
    getMock
      .mockResolvedValueOnce({
        data: [
          { id: 'job-a', title: 'Fix sink', status: 'open' },
          { id: 'job-b', title: 'Move sofa', status: 'assigned' },
        ],
      })
      .mockResolvedValueOnce({
        data: [
          { id: 'job-b', title: 'Move sofa (provider copy)', status: 'assigned' },
          { id: 'job-c', title: 'Build shelf', status: 'completed' },
        ],
      })

    const jobs = await fetchAgentBriefJobs()

    expect(getMock).toHaveBeenCalledTimes(2)
    expect(getMock.mock.calls[0][0]).toBe('/jobs/')
    expect(getMock.mock.calls[0][1].params).toEqual({ my: 'client', limit: 20 })
    expect(getMock.mock.calls[1][1].params).toEqual({ my: 'provider', limit: 20 })
    expect(jobs.map((job) => job.id)).toEqual(['job-a', 'job-b', 'job-c'])
    expect(jobs[1].title).toBe('Move sofa')
  })

  it('skips rows without an id and names a blank title', async () => {
    getMock
      .mockResolvedValueOnce({
        data: [{ id: 'job-a', title: '   ', status: 'open' }, null, { title: 'No id' }, { id: 7 }],
      })
      .mockResolvedValueOnce({ data: [] })

    const jobs = await fetchAgentBriefJobs()
    expect(jobs).toEqual([{ id: 'job-a', title: 'Untitled job', status: 'open' }])
  })

  it('keeps the jobs it could read when one side fails', async () => {
    getMock
      .mockRejectedValueOnce(new Error('provider list failed'))
      .mockResolvedValueOnce({ data: [{ id: 'job-c', title: 'Build shelf', status: 'open' }] })

    const jobs = await fetchAgentBriefJobs()
    expect(jobs).toEqual([{ id: 'job-c', title: 'Build shelf', status: 'open' }])
  })
})
