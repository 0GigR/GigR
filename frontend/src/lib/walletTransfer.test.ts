/**
 * walletTransfer.test.ts - the sentence shown when an in-app transfer fails.
 *
 * The regression this guards is the wording the profile used to show: for a
 * failure with no response it said "Network request failed. Please check your
 * internet connection.", which is what a browser reports when a server answers a
 * 500 without CORS headers. The fault was ours and the message blamed the
 * network. Every message below must name the step that stopped the transfer and
 * a next step for the sender, and none may carry that phrase.
 */

import { describe, expect, it } from 'vitest'

import { transferFailureMessage } from './walletTransfer'

const BANNED = ['network request failed', 'something went wrong', 'invalid input', 'unknown error']

function httpError(status: number, data: unknown = undefined) {
  return { response: { status, data } }
}

describe('transferFailureMessage', () => {
  it('names a transfer that timed out without claiming nothing was sent', () => {
    const message = transferFailureMessage({
      code: 'ECONNABORTED',
      message: 'timeout of 15000ms exceeded',
    })

    expect(message).toContain('took too long')
    expect(message).toContain('check your wallet activity')
  })

  it('says the transfer may not have been sent when there is no response at all', () => {
    const message = transferFailureMessage(new Error('Network Error'))

    expect(message).toContain('could not reach Gigr')
    expect(message).toContain('wallet activity')
  })

  it('shows the detail the server wrote, because it names the real problem', () => {
    const message = transferFailureMessage(
      httpError(400, {
        detail:
          'Your Gigr wallet has no USDC token account yet, so there is nothing to send. Add USDC to this wallet first, then try again. Nothing left your wallet.',
      }),
    )

    expect(message).toContain('no USDC token account')
  })

  it('flattens a validation error instead of dropping its detail', () => {
    const message = transferFailureMessage(
      httpError(422, { detail: [{ loc: ['body', 'amount'], msg: 'not a number' }] }),
    )

    expect(message).toContain('not a number')
  })

  it('reads a 402 with no detail as not enough USDC', () => {
    expect(transferFailureMessage(httpError(402))).toContain('does not hold enough USDC')
  })

  it('reads a 404 with no detail as an unknown recipient', () => {
    expect(transferFailureMessage(httpError(404))).toContain('could not find that recipient')
  })

  it('reads a 409 with no detail as a transfer already in progress', () => {
    expect(transferFailureMessage(httpError(409))).toContain('already in progress')
  })

  it('reads a 503 with no detail as the transfer not being prepared', () => {
    expect(transferFailureMessage(httpError(503))).toContain('could not prepare this transfer')
  })

  it('reads a 502 with no detail as Solana refusing the transfer', () => {
    expect(transferFailureMessage(httpError(502))).toContain('Solana did not accept')
  })

  it('reads a 401 as an expired session, not as a transfer failure', () => {
    expect(transferFailureMessage(httpError(401))).toContain('session expired')
  })

  it('names a server-side stop without telling the sender to check their internet', () => {
    const message = transferFailureMessage(httpError(500))

    expect(message).toContain('wallet activity')
    expect(message).not.toContain('internet')
  })

  it('never falls back to a banned phrase', () => {
    const failures = [
      new Error('Network Error'),
      { code: 'ETIMEDOUT' },
      httpError(400),
      httpError(401),
      httpError(402),
      httpError(404),
      httpError(409),
      httpError(500),
      httpError(502),
      httpError(503),
    ]

    for (const failure of failures) {
      const message = transferFailureMessage(failure).toLowerCase()
      for (const phrase of BANNED) {
        expect(message).not.toContain(phrase)
      }
    }
  })
})
