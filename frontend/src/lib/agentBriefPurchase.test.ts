/**
 * agentBriefPurchase.test.ts - the purchase answer, classified honestly.
 *
 * The property under test is the one the user's money depends on: a body that
 * carries a settlement signature is never labelled as a purchase that did not
 * happen, and a body with no signature is never labelled as paid.
 */

import { describe, expect, it } from 'vitest'

import {
  NO_READABLE_ANSWER,
  classifyPurchaseResponse,
  parsePurchasedBrief,
  purchaseHeadline,
  purchaseMayHaveMoved,
  settlementSignature,
} from './agentBriefPurchase'

const SIGNATURE =
  '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW'
const JOB_ID = 'c4d5e6f7-0a1b-4c2d-8e3f-4a5b6c7d8e9f'

function paidBody(overrides: Record<string, unknown> = {}) {
  return {
    status: 'paid',
    already_purchased: false,
    payment: {
      signature: SIGNATURE,
      network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
      mint: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
      amount_atomic: 10000,
      pay_to: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
    },
    brief: {
      job_id: JOB_ID,
      title: 'Fix the leaking kitchen sink',
      job_status: 'open',
      posted_price: 120,
      provider_id: '9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f',
      ratings: { count: 2, average: 4.5, distribution: { 4: 1, 5: 1 } },
      completed_jobs: 3,
      comparable_jobs: { count: 5, min_price: 80, max_price: 200, average_price: 140 },
      disputes: { total: 2, open: 1, resolved: 1 },
      has_history: true,
      summary: 'Provider history: 3 completed jobs, an average rating of 4.50 from 2 ratings.',
    },
    ...overrides,
  }
}

function failureBody(overrides: Record<string, unknown> = {}) {
  return {
    status: 'failed',
    reason: 'insufficient_usdc',
    message: 'Your Gigr wallet holds 0 USDC and this brief costs 0.01 USDC. Add USDC to your wallet and tap Buy this brief again. Nothing was charged.',
    payment_state: 'none',
    signature: null,
    required_atomic: 10000,
    available_atomic: 0,
    ...overrides,
  }
}

describe('classifyPurchaseResponse', () => {
  it('reads a paid body into the brief and the receipt that bought it', () => {
    const outcome = classifyPurchaseResponse(200, paidBody())

    expect(outcome.kind).toBe('paid')
    if (outcome.kind !== 'paid') return
    expect(outcome.signature).toBe(SIGNATURE)
    expect(outcome.alreadyPurchased).toBe(false)
    expect(outcome.brief.jobId).toBe(JOB_ID)
    expect(outcome.brief.title).toBe('Fix the leaking kitchen sink')
    expect(outcome.brief.summary).toContain('3 completed jobs')
    expect(outcome.brief.ratingsCount).toBe(2)
    expect(outcome.brief.ratingsAverage).toBe(4.5)
    expect(outcome.brief.completedJobs).toBe(3)
    expect(outcome.brief.comparableMin).toBe(80)
    expect(outcome.brief.comparableMax).toBe(200)
    expect(outcome.brief.disputesOpen).toBe(1)
    // 10000 atomic units of a six-decimal token is one cent.
    expect(outcome.brief.amountUsdc).toBe('0.01')
    expect(outcome.brief.amountAtomic).toBe('10000')
    expect(outcome.brief.payTo).toBe('9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin')
  })

  it('marks a replayed purchase as already bought', () => {
    const outcome = classifyPurchaseResponse(200, paidBody({ already_purchased: true }))

    expect(outcome.kind).toBe('paid')
    if (outcome.kind !== 'paid') return
    expect(outcome.alreadyPurchased).toBe(true)
    expect(purchaseHeadline(outcome)).toBe('Bought earlier, not charged again')
  })

  it('refuses to call a 200 paid when the receipt is missing', () => {
    // A paid answer without its signature cannot be shown as a purchase: the
    // signature is the only evidence the panel has that money moved.
    const body = paidBody()
    delete (body as Record<string, unknown>).payment

    const outcome = classifyPurchaseResponse(200, body)

    expect(outcome.kind).toBe('no_answer')
    if (outcome.kind !== 'no_answer') return
    expect(outcome.message).toContain('Do not pay again')
    expect(outcome.message).not.toContain('Nothing was charged')
  })

  it('refuses to call a 200 paid when the brief body is unreadable', () => {
    const body = paidBody()
    delete (body as Record<string, unknown>).brief

    expect(classifyPurchaseResponse(200, body).kind).toBe('no_answer')
  })

  it('keeps every named field of a no-USDC refusal', () => {
    const outcome = classifyPurchaseResponse(402, failureBody())

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.reason).toBe('insufficient_usdc')
    expect(outcome.paymentState).toBe('none')
    expect(outcome.signature).toBeNull()
    expect(outcome.message).toContain('holds 0 USDC')
    expect(purchaseHeadline(outcome)).toBe('Not bought')
    expect(purchaseMayHaveMoved(outcome)).toBe(false)
    expect(settlementSignature(outcome)).toBeNull()
  })

  it('keeps the signature of a submitted but unconfirmed transfer', () => {
    const outcome = classifyPurchaseResponse(
      504,
      failureBody({
        status: 'pending',
        reason: 'confirmation_timeout',
        payment_state: 'submitted',
        signature: SIGNATURE,
        message:
          'The transfer has not been confirmed yet. Do not pay again: tap Buy this brief again to check this same transfer. The transfer was submitted and may still confirm; its signature is below.',
      }),
    )

    expect(outcome.kind).toBe('pending')
    if (outcome.kind !== 'pending') return
    expect(outcome.paymentState).toBe('submitted')
    expect(settlementSignature(outcome)).toBe(SIGNATURE)
    expect(purchaseMayHaveMoved(outcome)).toBe(true)
    expect(purchaseHeadline(outcome)).toBe('Transfer submitted, not confirmed yet')
    expect(purchaseHeadline(outcome)).not.toContain('Not bought')
  })

  it('never labels a confirmed but refused transfer as not bought', () => {
    const outcome = classifyPurchaseResponse(
      502,
      failureBody({
        status: 'failed',
        reason: 'wrong_mint',
        payment_state: 'confirmed',
        signature: SIGNATURE,
        message:
          'The transfer moved a different token, not the USDC this brief is priced in. Contact support with the signature below. The transfer is confirmed on the Solana network; its signature is below.',
      }),
    )

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.paymentState).toBe('confirmed')
    expect(purchaseHeadline(outcome)).toBe('Transfer confirmed, brief not released')
    expect(purchaseMayHaveMoved(outcome)).toBe(true)
  })

  it('treats an unreadable body as no answer rather than a failure', () => {
    const outcome = classifyPurchaseResponse(502, '<html>Bad gateway</html>')

    expect(outcome.kind).toBe('no_answer')
    expect(purchaseHeadline(outcome)).toBe('No readable answer')
    // A transfer may exist behind an unreadable answer, so it is not "not bought".
    expect(purchaseMayHaveMoved(outcome)).toBe(true)
  })

  it('refuses a body that claims a failure without a message', () => {
    const outcome = classifyPurchaseResponse(402, {
      status: 'failed',
      reason: 'insufficient_usdc',
      payment_state: 'none',
    })

    expect(outcome.kind).toBe('no_answer')
  })

  it('answers a 401 as a signed-out failure that charged nothing', () => {
    const outcome = classifyPurchaseResponse(401, { detail: 'Invalid token' })

    expect(outcome.kind).toBe('failed')
    if (outcome.kind !== 'failed') return
    expect(outcome.reason).toBe('not_signed_in')
    expect(outcome.paymentState).toBe('none')
    expect(outcome.message).toContain('Sign in again')
    expect(purchaseMayHaveMoved(outcome)).toBe(false)
  })

  it('treats an unknown payment state as unknown, not as no money', () => {
    const outcome = classifyPurchaseResponse(
      503,
      failureBody({ status: 'pending', reason: 'purchase_unavailable', payment_state: undefined }),
    )

    expect(outcome.kind).toBe('pending')
    if (outcome.kind !== 'pending') return
    expect(outcome.paymentState).toBe('unknown')
    expect(purchaseMayHaveMoved(outcome)).toBe(true)
  })
})

describe('parsePurchasedBrief', () => {
  it('returns null when the summary is missing', () => {
    const body = paidBody()
    delete ((body.brief as Record<string, unknown>).summary)

    expect(parsePurchasedBrief(body)).toBeNull()
  })

  it('names a fallback title and job status instead of printing blanks', () => {
    const body = paidBody()
    delete ((body.brief as Record<string, unknown>).title)
    ;(body.brief as Record<string, unknown>).job_status = null

    const brief = parsePurchasedBrief(body)

    expect(brief?.title).toBe('Untitled job')
    expect(brief?.jobStatus).toBe('unknown')
  })

  it('shows the atomic amount when it cannot be formatted', () => {
    const body = paidBody()
    ;(body.payment as Record<string, unknown>).amount_atomic = 'not-a-number'

    const brief = parsePurchasedBrief(body)

    expect(brief?.amountAtomic).toBe('not-a-number')
    expect(brief?.amountUsdc).toBeNull()
  })
})

describe('the wording of the answer', () => {
  it('never says nothing was charged on an answer with a signature', () => {
    const withSignature = [
      classifyPurchaseResponse(200, paidBody()),
      classifyPurchaseResponse(
        504,
        failureBody({ status: 'pending', reason: 'confirmation_timeout', payment_state: 'submitted', signature: SIGNATURE }),
      ),
      classifyPurchaseResponse(
        502,
        failureBody({ status: 'failed', reason: 'wrong_mint', payment_state: 'confirmed', signature: SIGNATURE }),
      ),
    ]

    for (const outcome of withSignature) {
      const text =
        outcome.kind === 'no_answer' ? outcome.message : purchaseHeadline(outcome)
      expect(text.toLowerCase()).not.toContain('nothing was charged')
    }
  })

  it('keeps the backend sentence as the message for every failure', () => {
    const body = failureBody({
      status: 'failed',
      reason: 'transfer_declined',
      message: 'The Solana network refused this transfer. Nothing was charged.',
    })

    const outcome = classifyPurchaseResponse(502, body)

    expect(outcome.kind === 'failed' && outcome.message).toBe(body.message)
  })

  it('explains an unreadable answer with the safe next step', () => {
    const outcome = classifyPurchaseResponse(500, null)

    expect(outcome.kind).toBe('no_answer')
    if (outcome.kind !== 'no_answer') return
    expect(outcome.message).toContain('Do not pay again')
    expect(outcome.message).toContain('check your wallet activity')
    expect(outcome.message).toBe(NO_READABLE_ANSWER)
  })
})
