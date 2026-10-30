/**
 * walletTransfer.ts - what to tell someone whose in-app transfer did not go through.
 *
 * The profile's send calls POST /users/me/transfer. Before this module the only
 * text for a failure with no response was "Network request failed. Please check
 * your internet connection.", and the backend's raw detail otherwise. That was
 * actively misleading for USDC: the route used to raise a TypeError while it was
 * building the instruction, the framework answered 500 without the CORS headers
 * a browser needs, and axios therefore reported no response at all. The one thing
 * the user was told was to check their internet, when the fault was ours.
 *
 * This maps a failure to a sentence that names the step that stopped it and the
 * next step for the sender. It never claims money moved, or did not move, when it
 * cannot know: a request whose answer was lost may still have been handled.
 */

/** Errors from a browser or axios that never produced an HTTP response. */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

function timedOut(error: unknown): boolean {
  const record = asRecord(error)
  if (!record) return false
  if (record.code === 'ECONNABORTED' || record.code === 'ETIMEDOUT') return true
  return typeof record.message === 'string' && record.message.includes('timeout')
}

function statusOf(error: unknown): number | null {
  const response = asRecord(asRecord(error)?.response)
  const status = response?.status
  return typeof status === 'number' ? status : null
}

/**
 * The detail a FastAPI error body carries, as one sentence.
 *
 * A validation error carries a list instead of a string, so it is flattened
 * rather than dropped: showing nothing would fall back to a guess.
 */
function detailOf(error: unknown): string | null {
  const response = asRecord(asRecord(error)?.response)
  const data = asRecord(response?.data)
  const detail = data?.detail
  if (typeof detail === 'string') return detail.trim() || null
  if (detail === undefined || detail === null) return null
  try {
    return JSON.stringify(detail)
  } catch {
    return null
  }
}

/**
 * The sentence to show for a failed transfer.
 *
 * The server's own detail wins when it sent one: it names the exact step that
 * refused the transfer (no USDC account, Solana refused it, the amount has too
 * many decimals), and it is the only source that can. When there is no detail,
 * the status picks a sentence, and no response at all gets the honest answer: the
 * transfer's outcome is unknown, so check the wallet before retrying.
 */
export function transferFailureMessage(error: unknown): string {
  const status = statusOf(error)

  if (status === null) {
    return timedOut(error)
      ? 'The transfer took too long to answer. Do not send it again yet: check your wallet activity first, then try again if nothing moved.'
      : 'We could not reach Gigr to send this transfer, so it may not have been sent. Check your connection and your wallet activity, then try again.'
  }

  if (status === 401) {
    return 'Your session expired, so the transfer was not sent. Sign in again and resend it.'
  }

  const detail = detailOf(error)
  if (detail) return detail

  if (status === 402) {
    return 'Your Gigr wallet does not hold enough USDC for this transfer. Add USDC to the wallet and try again. Nothing left your wallet.'
  }
  if (status === 404) {
    return 'We could not find that recipient on Gigr or on Solana. Check the username, email or wallet address and try again.'
  }
  if (status === 409) {
    return 'That transfer conflicts with one already in progress. Wait a moment, then check your wallet activity before sending it again.'
  }
  if (status === 503) {
    return 'Gigr could not prepare this transfer just now, so it was not sent. Nothing left your wallet. Try again in a moment.'
  }
  if (status === 502) {
    return 'Solana did not accept this transfer. Check your wallet activity before sending it again.'
  }
  return 'Gigr stopped while preparing this transfer. Check your wallet activity before sending it again, and use SOL if it keeps happening.'
}
