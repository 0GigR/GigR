/**
 * useAgentBrief.ts - the reads the Agent access panel needs, and the purchase.
 *
 * `requestAgentBriefQuote` asks the paid-brief endpoint for its terms and stops
 * there. It never sends an X-PAYMENT header, so it cannot buy anything: the 402
 * challenge is the answer this panel is built around. A 402 or 404 is a normal
 * answer, not an exception, which is why the request accepts every status and
 * classifies the body instead of letting axios throw.
 *
 * `purchaseAgentBrief` is the one call that spends money. The server signs the
 * USDC transfer with the caller's custodial wallet, so no wallet, key or
 * X-PAYMENT header crosses this boundary: the authenticated POST is the whole
 * request. Its timeout is generous because the server waits for a confirmation
 * before it answers, and every status is classified for the same reason as
 * above: a 402 here is "you have no USDC", a typed answer, not an exception.
 *
 * `fetchBriefProviders` lists the providers a brief can be bought about, each
 * with the representative completed job the quote is asked for. It is one
 * request, so the picker cannot show a provider whose job id it has not read
 * yet. A failure is surfaced, not swallowed: the picker then says it could not
 * read the list and points at the job-id field, which still works.
 */

import api from '@/lib/api'
import {
  classifyPurchaseResponse,
  type PurchaseOutcome,
} from '@/lib/agentBriefPurchase'
import { parseBriefProviders, type BriefProvider } from '@/lib/providerPicker'
import { classifyBriefResponse, type BriefOutcome } from '@/lib/x402Challenge'

/** A brief recall does a database read; the shared 15s timeout is close. */
export const BRIEF_REQUEST_TIMEOUT_MS = 20000

/**
 * A purchase waits for a Solana confirmation before it answers, and the server
 * stops waiting after 30 seconds, so the client must outlast that window.
 */
export const PURCHASE_REQUEST_TIMEOUT_MS = 60000

/** The picker asks for one page: a phone cannot use more than this. */
export const PROVIDER_PAGE_SIZE = 50

/** The provider list is one aggregate query, but it is still a database read. */
export const PROVIDER_REQUEST_TIMEOUT_MS = 15000

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ECONNABORTED'
  )
}

/**
 * Ask for a brief's terms. Returns the classified answer, never throws.
 *
 * With no payment attached the endpoint answers 402; with the feature off it
 * answers 404. Both are answered here as outcomes so the panel can say which
 * one happened.
 */
export async function requestAgentBriefQuote(jobId: string): Promise<BriefOutcome> {
  try {
    const response = await api.get('/agent/brief', {
      params: { job_id: jobId },
      timeout: BRIEF_REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    })
    return classifyBriefResponse(response.status, response.data)
  } catch (error) {
    if (isTimeout(error)) {
      return {
        kind: 'error',
        detail: 'The agent brief endpoint took too long to answer. Nothing was charged.',
      }
    }
    return {
      kind: 'error',
      detail: 'We could not reach the agent brief endpoint. Check your connection and try again.',
    }
  }
}

/**
 * Buy one brief from the caller's custodial wallet. Returns the classified
 * answer, never throws.
 *
 * The request carries no payment header and no key: the server signs the USDC
 * transfer for the signed-in user. A timeout is not "failed" here, because the
 * request may have been handled: the message says to check the same purchase
 * again, which the server answers from its own record instead of paying twice.
 */
export async function purchaseAgentBrief(jobId: string): Promise<PurchaseOutcome> {
  try {
    const response = await api.post('/agent/brief/purchase', null, {
      params: { job_id: jobId },
      timeout: PURCHASE_REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    })
    return classifyPurchaseResponse(response.status, response.data)
  } catch (error) {
    if (isTimeout(error)) {
      return {
        kind: 'no_answer',
        message:
          'The purchase took too long to answer. Do not pay again: tap Buy this brief again to check this purchase, and check your wallet activity before trying another one.',
      }
    }
    return {
      kind: 'no_answer',
      message:
        'We could not reach the purchase endpoint. Do not pay again: tap Buy this brief again to check this purchase, and check your wallet activity before trying another one.',
    }
  }
}

/**
 * The providers a brief can be bought about, most completed jobs first.
 *
 * Each row carries its own representative job id, so the picker does not make a
 * second request to find one. A body that is not the documented shape reads as
 * an empty list; a request that fails throws, because "we could not read the
 * list" and "there are no providers" are different sentences to show.
 */
export async function fetchBriefProviders(): Promise<BriefProvider[]> {
  const response = await api.get('/agent/brief/providers', {
    params: { limit: PROVIDER_PAGE_SIZE },
    timeout: PROVIDER_REQUEST_TIMEOUT_MS,
  })
  return parseBriefProviders(response.data)
}
