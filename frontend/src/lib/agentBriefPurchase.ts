/**
 * agentBriefPurchase.ts - what the purchase endpoint said, and how to label it.
 *
 * The purchase route answers with one of three shapes: the paid-brief body (200),
 * a typed answer that is not a brief (reason, message, payment state and, when it
 * exists, the settlement signature), or nothing readable at all.
 *
 * This module turns any of them into one outcome. The label is derived from the
 * payment state and never from the HTTP status, because the two questions the
 * user has are different: "did I get the brief" and "did my money move". A
 * transfer that exists is never shown as a failure, and a brief is never shown
 * as bought without a signature the backend verified.
 */

import { formatAtomicUsdc } from './x402Challenge'

export type PurchasePaymentState = 'none' | 'unknown' | 'submitted' | 'confirmed'

/** The brief that was bought, as much of it as the payload carries. */
export interface PurchasedBrief {
  jobId: string
  title: string
  jobStatus: string
  postedPrice: number | null
  ratingsCount: number
  ratingsAverage: number | null
  completedJobs: number
  comparableJobs: number
  comparableMin: number | null
  comparableMax: number | null
  comparableAverage: number | null
  disputesTotal: number
  disputesOpen: number
  hasHistory: boolean
  summary: string
  amountAtomic: string | null
  amountUsdc: string | null
  network: string | null
  payTo: string | null
}

export interface PurchasePaid {
  kind: 'paid'
  brief: PurchasedBrief
  signature: string
  alreadyPurchased: boolean
}

export interface PurchaseNotPaid {
  kind: 'failed' | 'pending'
  reason: string
  message: string
  paymentState: PurchasePaymentState
  signature: string | null
  alreadyPurchased: boolean
}

export interface PurchaseNoAnswer {
  kind: 'no_answer'
  message: string
}

export type PurchaseOutcome = PurchasePaid | PurchaseNotPaid | PurchaseNoAnswer

/**
 * The sentence for an answer that could not be read.
 *
 * A request whose answer was lost may still have been handled: the server could
 * have submitted a transfer and died before answering. So this never says
 * nothing was charged, and it names the safe next step.
 */
export const NO_READABLE_ANSWER =
  'We did not get a readable answer from the purchase endpoint. Do not pay again: tap Buy this brief again to check this purchase, and check your wallet activity before trying another one.'

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asCount(value: unknown): number {
  const parsed = asNumber(value)
  return parsed === null ? 0 : Math.max(0, Math.trunc(parsed))
}

function asPaymentState(value: unknown): PurchasePaymentState | null {
  switch (value) {
    case 'none':
    case 'unknown':
    case 'submitted':
    case 'confirmed':
      return value
    default:
      return null
  }
}

/**
 * The brief and the receipt fields of a paid body.
 *
 * Returns null when the payload is missing a fact the panel promises to show: a
 * summary or the job it is about. Printing half of a paid body as if it were
 * complete would be worse than saying the answer could not be read. The
 * signature is not required here because it is not part of the brief: the
 * classifier requires it before it calls the answer paid.
 */
export function parsePurchasedBrief(body: unknown): PurchasedBrief | null {
  const record = asRecord(body)
  if (!record) return null
  const payment = asRecord(record.payment) ?? {}
  const brief = asRecord(record.brief)
  if (!brief) return null

  const jobId = asString(brief.job_id)
  const summary = asString(brief.summary)
  if (!jobId || !summary) return null

  const amountAtomicRaw = payment.amount_atomic
  const amountAtomic =
    typeof amountAtomicRaw === 'number' && Number.isFinite(amountAtomicRaw)
      ? String(Math.trunc(amountAtomicRaw))
      : typeof amountAtomicRaw === 'string'
        ? amountAtomicRaw
        : null

  return {
    jobId,
    title: asString(brief.title) ?? 'Untitled job',
    jobStatus: asString(brief.job_status) ?? 'unknown',
    postedPrice: asNumber(brief.posted_price),
    ratingsCount: asCount(asRecord(brief.ratings)?.count),
    ratingsAverage: asNumber(asRecord(brief.ratings)?.average),
    completedJobs: asCount(brief.completed_jobs),
    comparableJobs: asCount(asRecord(brief.comparable_jobs)?.count),
    comparableMin: asNumber(asRecord(brief.comparable_jobs)?.min_price),
    comparableMax: asNumber(asRecord(brief.comparable_jobs)?.max_price),
    comparableAverage: asNumber(asRecord(brief.comparable_jobs)?.average_price),
    disputesTotal: asCount(asRecord(brief.disputes)?.total),
    disputesOpen: asCount(asRecord(brief.disputes)?.open),
    hasHistory: brief.has_history === true,
    summary,
    amountAtomic,
    amountUsdc: amountAtomic === null ? null : formatAtomicUsdc(amountAtomic, 6),
    network: asString(payment.network),
    payTo: asString(payment.pay_to),
  }
}

/**
 * Read one purchase answer.
 *
 * A 2xx is only "paid" when its body carries both the brief and the settlement
 * signature: a paid answer without its receipt cannot be trusted to be one. A
 * 401 is the one failure the client can assert on its own, because the request
 * never reached the handler.
 */
export function classifyPurchaseResponse(
  status: number,
  body: unknown,
): PurchaseOutcome {
  if (status === 401) {
    return {
      kind: 'failed',
      reason: 'not_signed_in',
      message:
        'Your session has expired, so this brief was not bought. Sign in again and tap Buy this brief.',
      paymentState: 'none',
      signature: null,
      alreadyPurchased: false,
    }
  }

  if (status >= 200 && status < 300) {
    const record = asRecord(body)
    const brief = parsePurchasedBrief(body)
    const signature = asString(asRecord(record?.payment)?.signature)
    if (!brief || !signature) return { kind: 'no_answer', message: NO_READABLE_ANSWER }
    return {
      kind: 'paid',
      brief,
      signature,
      alreadyPurchased: record?.already_purchased === true,
    }
  }

  const record = asRecord(body)
  const reason = asString(record?.reason)
  const message = asString(record?.message)
  const declared = record?.status
  const kind: 'failed' | 'pending' | null =
    declared === 'pending' ? 'pending' : declared === 'failed' ? 'failed' : null
  if (!reason || !message || kind === null) {
    return { kind: 'no_answer', message: NO_READABLE_ANSWER }
  }

  return {
    kind,
    reason,
    message,
    paymentState: asPaymentState(record?.payment_state) ?? 'unknown',
    signature: asString(record?.signature),
    alreadyPurchased: record?.already_purchased === true,
  }
}

/**
 * The short label above the answer.
 *
 * Only this function is allowed to say a purchase failed, and it will not say it
 * when a transfer exists: a confirmed or unknown payment gets its own wording,
 * because the next step for the user is different in each case.
 */
export function purchaseHeadline(outcome: PurchaseOutcome): string {
  if (outcome.kind === 'no_answer') return 'No readable answer'
  if (outcome.kind === 'paid') {
    return outcome.alreadyPurchased ? 'Bought earlier, not charged again' : 'Brief bought'
  }
  if (outcome.kind === 'pending') {
    return outcome.paymentState === 'submitted'
      ? 'Transfer submitted, not confirmed yet'
      : 'Purchase in progress'
  }
  if (outcome.paymentState === 'confirmed') return 'Transfer confirmed, brief not released'
  if (outcome.paymentState === 'unknown') return 'Transfer outcome unknown'
  return 'Not bought'
}

/** The settlement signature to show, or null when nothing was submitted. */
export function settlementSignature(outcome: PurchaseOutcome): string | null {
  if (outcome.kind === 'paid') return outcome.signature
  if (outcome.kind === 'failed' || outcome.kind === 'pending') return outcome.signature
  return null
}

/**
 * Whether money may have moved, whatever the purchase itself did.
 *
 * An answer that could not be read is cautious on purpose: the request may have
 * been handled before its answer was lost.
 */
export function purchaseMayHaveMoved(outcome: PurchaseOutcome): boolean {
  if (outcome.kind === 'paid') return true
  // A request whose answer was lost may have been handled before it was lost.
  if (outcome.kind === 'no_answer') return true
  return outcome.paymentState !== 'none' || outcome.signature !== null
}
