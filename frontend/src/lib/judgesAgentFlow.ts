/**
 * judgesAgentFlow.ts - the timeline behind the agent-payment motion graphic.
 *
 * The graphic loops six beats in twelve seconds. Keeping the timeline and the
 * wallet balance pure makes the two things a viewer can actually catch wrong -
 * the beat that is highlighted and the moment the balance moves - testable
 * without a browser. The component only advances an index; it never reinvents
 * the schedule.
 */

export interface AgentFlowStep {
  id: string
  /** One line stating what happens in this beat. */
  title: string
  /** The detail shown under the graphic. */
  caption: string
}

export const AGENT_FLOW_STEPS: readonly AgentFlowStep[] = [
  {
    id: 'request',
    title: 'Agent sends GET /agent/brief.',
    caption: 'The endpoint is public, so a machine can call it with no key and no session.',
  },
  {
    id: 'challenge',
    title: 'Gigr answers 402 Payment Required.',
    caption: '0.01 USDC, nonce, expires in 5 min.',
  },
  {
    id: 'sign',
    title: 'Agent signs the transfer from its own wallet.',
    caption: 'The key is in the agent wallet. The balance drops from 0.42 to 0.41 USDC.',
  },
  {
    id: 'retry',
    title: 'Agent re-sends the request with X-PAYMENT.',
    caption: 'The signed payment travels with the same request.',
  },
  {
    id: 'verify',
    title: 'Gigr verifies the settlement on chain through Tatum.',
    caption: 'Tatum confirms the transfer before Gigr releases any data.',
  },
  {
    id: 'brief',
    title: 'Gigr returns 200 with the brief.',
    caption: 'One payment, one brief, no account created.',
  },
]

/** How long one beat is highlighted. Six beats make a twelve second loop. */
export const AGENT_FLOW_STEP_MS = 2000
export const AGENT_FLOW_DURATION_MS = AGENT_FLOW_STEPS.length * AGENT_FLOW_STEP_MS

export const AGENT_FLOW_START_BALANCE = 0.42
export const AGENT_FLOW_PAID_BALANCE = 0.41

/** Beat at which the wallet pays (the third beat, zero-based index 2). */
export const AGENT_FLOW_PAYMENT_STEP = 2

/**
 * Loop position for an elapsed time. A negative or non-finite value is the
 * start of the loop, so a bad clock can never produce an invalid beat.
 */
export function normalizeFlowElapsed(elapsedMs: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  return elapsedMs % AGENT_FLOW_DURATION_MS
}

/** Index of the beat highlighted at `elapsedMs`. Always 0 through 5. */
export function agentFlowStepAt(elapsedMs: number): number {
  const step = Math.floor(normalizeFlowElapsed(elapsedMs) / AGENT_FLOW_STEP_MS)
  return Math.min(step, AGENT_FLOW_STEPS.length - 1)
}

/** First millisecond of a beat, clamped to the six real beats. */
export function agentFlowStepStartMs(step: number): number {
  const safe = Number.isFinite(step) ? Math.floor(step) : 0
  const clamped = Math.min(Math.max(safe, 0), AGENT_FLOW_STEPS.length - 1)
  return clamped * AGENT_FLOW_STEP_MS
}

/** Wallet balance shown in the left card: 0.42 until the agent pays, then 0.41. */
export function agentFlowBalanceAt(elapsedMs: number): number {
  return agentFlowStepAt(elapsedMs) >= AGENT_FLOW_PAYMENT_STEP
    ? AGENT_FLOW_PAID_BALANCE
    : AGENT_FLOW_START_BALANCE
}
