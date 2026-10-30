import { describe, expect, it } from 'vitest'
import {
  AGENT_FLOW_DURATION_MS,
  AGENT_FLOW_PAID_BALANCE,
  AGENT_FLOW_PAYMENT_STEP,
  AGENT_FLOW_START_BALANCE,
  AGENT_FLOW_STEPS,
  AGENT_FLOW_STEP_MS,
  agentFlowBalanceAt,
  agentFlowStepAt,
  agentFlowStepStartMs,
  normalizeFlowElapsed,
} from './judgesAgentFlow'

const EXPECTED_TITLES = [
  'Agent sends GET /agent/brief.',
  'Gigr answers 402 Payment Required.',
  'Agent signs the transfer from its own wallet.',
  'Agent re-sends the request with X-PAYMENT.',
  'Gigr verifies the settlement on chain through Tatum.',
  'Gigr returns 200 with the brief.',
]

describe('agent payment flow timeline', () => {
  it('has six beats in the order the graphic plays them', () => {
    expect(AGENT_FLOW_STEPS.map((step) => step.title)).toEqual(EXPECTED_TITLES)
  })

  it('loops every twelve seconds, two seconds per beat', () => {
    expect(AGENT_FLOW_STEP_MS).toBe(2000)
    expect(AGENT_FLOW_STEPS).toHaveLength(6)
    expect(AGENT_FLOW_DURATION_MS).toBe(12000)
    expect(AGENT_FLOW_DURATION_MS).toBe(AGENT_FLOW_STEPS.length * AGENT_FLOW_STEP_MS)
  })

  it('has unique beat ids and a caption for every beat', () => {
    const ids = AGENT_FLOW_STEPS.map((step) => step.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const step of AGENT_FLOW_STEPS) {
      expect(step.caption.trim().length).toBeGreaterThan(20)
    }
  })

  it('states the x402 price and the Tatum check in the right beats', () => {
    expect(AGENT_FLOW_STEPS[1].caption).toContain('0.01 USDC')
    expect(AGENT_FLOW_STEPS[1].caption).toContain('5 min')
    expect(AGENT_FLOW_STEPS[4].title).toContain('Tatum')
    expect(AGENT_FLOW_STEPS[2].title).toContain('signs the transfer')
  })

  it('keeps every visible flow string ASCII', () => {
    for (const step of AGENT_FLOW_STEPS) {
      expect(step.title).not.toMatch(/[^\x00-\x7F]/)
      expect(step.caption).not.toMatch(/[^\x00-\x7F]/)
    }
  })
})

describe('agentFlowStepAt', () => {
  it.each([
    [0, 0],
    [1, 0],
    [1999, 0],
    [2000, 1],
    [3999, 1],
    [4000, 2],
    [5999, 2],
    [6000, 3],
    [7999, 3],
    [8000, 4],
    [9999, 4],
    [10000, 5],
    [11999, 5],
    [12000, 0],
    [12001, 0],
    [24000, 0],
    [26000, 1],
  ])('highlights beat %s at %s ms', (elapsed, expected) => {
    expect(agentFlowStepAt(elapsed)).toBe(expected)
  })

  it('gives every beat its full two second window', () => {
    for (let index = 0; index < AGENT_FLOW_STEPS.length; index += 1) {
      expect(agentFlowStepAt(agentFlowStepStartMs(index))).toBe(index)
      expect(agentFlowStepAt(agentFlowStepStartMs(index) + AGENT_FLOW_STEP_MS - 1)).toBe(index)
    }
  })

  it('never produces a seventh beat anywhere in the loop', () => {
    for (let elapsed = 0; elapsed < AGENT_FLOW_DURATION_MS; elapsed += 250) {
      const step = agentFlowStepAt(elapsed)
      expect(step).toBeGreaterThanOrEqual(0)
      expect(step).toBeLessThan(AGENT_FLOW_STEPS.length)
    }
  })

  it('treats invalid and negative clocks as the start of the loop', () => {
    expect(agentFlowStepAt(-1)).toBe(0)
    expect(agentFlowStepAt(-12000)).toBe(0)
    expect(agentFlowStepAt(Number.NaN)).toBe(0)
    expect(agentFlowStepAt(Number.POSITIVE_INFINITY)).toBe(0)
    expect(agentFlowStepAt(Number.NEGATIVE_INFINITY)).toBe(0)
  })
})

describe('normalizeFlowElapsed', () => {
  it('wraps the loop position', () => {
    expect(normalizeFlowElapsed(0)).toBe(0)
    expect(normalizeFlowElapsed(11999)).toBe(11999)
    expect(normalizeFlowElapsed(12000)).toBe(0)
    expect(normalizeFlowElapsed(12500)).toBe(500)
  })

  it('clamps invalid values to zero', () => {
    expect(normalizeFlowElapsed(-5)).toBe(0)
    expect(normalizeFlowElapsed(Number.NaN)).toBe(0)
  })
})

describe('agentFlowStepStartMs', () => {
  it.each([
    [0, 0],
    [1, 2000],
    [2, 4000],
    [5, 10000],
  ])('starts beat %s at %s ms', (step, expected) => {
    expect(agentFlowStepStartMs(step)).toBe(expected)
  })

  it('clamps out-of-range and fractional beats', () => {
    expect(agentFlowStepStartMs(-1)).toBe(0)
    expect(agentFlowStepStartMs(6)).toBe(10000)
    expect(agentFlowStepStartMs(2.9)).toBe(4000)
    expect(agentFlowStepStartMs(Number.NaN)).toBe(0)
  })
})

describe('agentFlowBalanceAt', () => {
  it('holds 0.42 before the agent signs', () => {
    expect(AGENT_FLOW_START_BALANCE).toBe(0.42)
    expect(agentFlowBalanceAt(0)).toBe(0.42)
    expect(agentFlowBalanceAt(3999)).toBe(0.42)
  })

  it('drops to 0.41 on the signing beat and stays there until the loop restarts', () => {
    expect(AGENT_FLOW_PAID_BALANCE).toBe(0.41)
    expect(AGENT_FLOW_PAYMENT_STEP).toBe(2)
    expect(agentFlowBalanceAt(4000)).toBe(0.41)
    expect(agentFlowBalanceAt(11999)).toBe(0.41)
    expect(agentFlowBalanceAt(12000)).toBe(0.42)
  })

  it('charges exactly once per loop, not once per remaining beat', () => {
    for (let step = 0; step < AGENT_FLOW_STEPS.length; step += 1) {
      const balance = agentFlowBalanceAt(agentFlowStepStartMs(step) + 1000)
      if (step < AGENT_FLOW_PAYMENT_STEP) {
        expect(balance).toBe(AGENT_FLOW_START_BALANCE)
      } else {
        expect(balance).toBe(AGENT_FLOW_PAID_BALANCE)
      }
    }
  })

  it('treats invalid clocks as the unpaid start', () => {
    expect(agentFlowBalanceAt(Number.NaN)).toBe(AGENT_FLOW_START_BALANCE)
    expect(agentFlowBalanceAt(-1)).toBe(AGENT_FLOW_START_BALANCE)
  })
})
