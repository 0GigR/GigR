/**
 * x402Challenge.ts - what the paid-brief endpoint actually said, and in what
 * words the Agent payments panel can say it back.
 *
 * The endpoint answers with one of three things: the x402 402 challenge (the
 * normal answer to an unpaid request), a 404 while the feature is off, or an
 * error. This module classifies that answer and reads the challenge into
 * display fields. It is deliberately unable to produce a purchase: there is no
 * outcome kind for "payment succeeded", and a 2xx is treated as unexpected
 * rather than as something this panel bought.
 */

export interface X402Quote {
  scheme: string
  network: string
  asset: string
  /** The amount exactly as the endpoint quoted it, in atomic units. */
  amountAtomic: string
  /** The amount in whole USDC, or null when the endpoint did not state decimals. */
  amountUsdc: string | null
  decimals: number | null
  payTo: string
  resource: string | null
  expiresAtIso: string | null
  expiresAtLabel: string | null
  reason: string | null
  reasonText: string
  nonce: string | null
  maxTimeoutSeconds: number | null
}

export type BriefOutcome =
  | { kind: 'quote'; quote: X402Quote }
  | { kind: 'feature_disabled'; detail: string }
  | { kind: 'job_not_found'; detail: string }
  | { kind: 'unexpected'; detail: string }
  | { kind: 'error'; detail: string }

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

/**
 * A positive atomic amount as a USDC decimal string.
 *
 * String arithmetic, not Number: an atomic amount can be larger than a float
 * can represent exactly, and showing a rounded amount would misquote the price.
 * Returns null rather than guessing when the amount or the decimals are not
 * well formed.
 */
export function formatAtomicUsdc(
  amountAtomic: string | number,
  decimals: number | null,
): string | null {
  const raw = typeof amountAtomic === 'number' ? String(amountAtomic) : amountAtomic
  if (!/^\d+$/.test(raw)) return null
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    return null
  }
  const digits = raw.replace(/^0+(?=\d)/, '')
  if (decimals === 0) return digits
  const padded = digits.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : whole
}

/**
 * The quote's expiry as a fixed UTC string.
 *
 * The backend sends an ISO timestamp with an offset. The panel prints UTC so
 * the value is the same for every reader and every recording, and so nobody
 * mistakes a local clock for the quote's life.
 */
export function formatQuoteExpiry(iso: string | null): string | null {
  if (!iso) return null
  const parsed = new Date(iso)
  if (Number.isNaN(parsed.getTime())) return null
  const stamp = parsed.toISOString().slice(0, 19).replace('T', ' ')
  return `${stamp} UTC`
}

/** The endpoint's named reason in plain language; an unknown reason is named too. */
export function x402ReasonText(reason: string | null): string {
  if (!reason) return 'The endpoint did not state a reason.'
  switch (reason) {
    case 'payment_missing':
      return 'The request carried no payment, so the endpoint answered with its price.'
    case 'invalid_payment_header':
      return 'The X-PAYMENT header could not be read, so the payment was refused.'
    case 'wrong_mint':
      return 'The payment moved a different token, not the USDC mint this brief is priced in.'
    case 'wrong_recipient':
      return 'The payment went to a different address than the one this brief names.'
    case 'underpaid':
      return 'The payment was less than the quoted amount, so the brief was not returned.'
    case 'transaction_failed':
      return 'The settlement transaction failed on Solana, so the brief was not returned.'
    case 'transaction_not_found':
      return 'No settlement transaction with that signature was found on Solana.'
    case 'malformed_transaction':
      return 'The settlement transaction could not be read, so the payment was refused.'
    case 'verification_unavailable':
      return 'The payment could not be checked on chain just now, so the brief was not returned.'
    case 'payment_already_used':
      return 'That payment signature has already bought a brief. One payment buys one brief.'
    default:
      return `The endpoint gave the reason ${reason}.`
  }
}

/**
 * Read one x402 challenge from the 402 body.
 *
 * The accepted option is the first entry of `accepts`, which is the shape an
 * x402 client reads. A body missing a fact the panel promises to show is not
 * guessed at: the panel then reports that the 402 carried no readable
 * challenge, instead of printing half a quote as if it were complete.
 */
export function parseX402Quote(body: unknown): X402Quote | null {
  const record = asRecord(body)
  if (!record) return null
  const accepts = Array.isArray(record.accepts) ? record.accepts : []
  const first = asRecord(accepts[0])
  if (!first) return null

  const scheme = asString(first.scheme)
  const network = asString(first.network)
  const asset = asString(first.asset)
  const payTo = asString(first.payTo)
  const amountAtomic = asString(first.maxAmountRequired)
  if (!scheme || !network || !asset || !payTo || !amountAtomic) return null

  const extra = asRecord(first.extra) ?? {}
  const decimals = asInteger(extra.mintDecimals)
  const expiresAtIso = asString(extra.expiresAt)
  const reason = asString(record.error)

  return {
    scheme,
    network,
    asset,
    amountAtomic,
    amountUsdc: formatAtomicUsdc(amountAtomic, decimals),
    decimals,
    payTo,
    resource: asString(first.resource),
    expiresAtIso,
    expiresAtLabel: formatQuoteExpiry(expiresAtIso),
    reason,
    reasonText: x402ReasonText(reason),
    nonce: asString(extra.nonce),
    maxTimeoutSeconds: asInteger(first.maxTimeoutSeconds),
  }
}

/** The `detail` string of a FastAPI error body, or null when there is none. */
export function errorDetail(body: unknown): string | null {
  const record = asRecord(body)
  if (!record) return null
  const detail = record.detail
  if (typeof detail === 'string') return detail.trim() || null
  if (detail === undefined || detail === null) return null
  try {
    return JSON.stringify(detail)
  } catch {
    return null
  }
}

/**
 * Classify the endpoint's answer.
 *
 * The flag-off 404 and the unknown-job 404 are different sentences to the
 * reader, so they are different outcomes here: the flag-off detail says the
 * briefs are "not offered" by the deployment, and that phrase is the only
 * reliable marker the endpoint gives. Both branches print the backend's own
 * detail, so even a changed wording stays honest.
 */
export function classifyBriefResponse(status: number, body: unknown): BriefOutcome {
  if (status === 402) {
    const quote = parseX402Quote(body)
    if (!quote) {
      return {
        kind: 'error',
        detail: 'The endpoint answered 402, but the body was not a readable x402 challenge.',
      }
    }
    return { kind: 'quote', quote }
  }

  if (status === 404) {
    const detail = errorDetail(body) ?? 'The endpoint answered 404 with no detail.'
    if (/not offered/i.test(detail)) return { kind: 'feature_disabled', detail }
    return { kind: 'job_not_found', detail }
  }

  if (status >= 200 && status < 300) {
    return {
      kind: 'unexpected',
      detail:
        'The endpoint returned content without a payment challenge. This panel does not treat that as a purchase and shows no brief.',
    }
  }

  const detail = errorDetail(body)
  return {
    kind: 'error',
    detail: detail
      ? `The endpoint answered ${status}: ${detail}`
      : `The endpoint answered ${status} with no detail.`,
  }
}

/** A Gigr job id is a UUID; anything else cannot name a job. */
export function isJobId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value.trim(),
  )
}
