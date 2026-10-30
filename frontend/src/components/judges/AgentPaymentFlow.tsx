/**
 * AgentPaymentFlow.tsx - the motion graphic that proves the x402 flow is for a
 * machine with no Gigr account.
 *
 * Six beats, twelve seconds, one highlighted at a time. The component only
 * advances an integer beat every two seconds; the travel, the wallet pulse and
 * the Tatum confirmation are CSS animations restarted by the key on each beat.
 * There is no requestAnimationFrame loop and no per-frame React render.
 *
 * The section pauses itself with IntersectionObserver when it is off screen.
 * Under prefers-reduced-motion the animated stage is replaced by the same six
 * beats as a static numbered list.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Cpu, FileText, RotateCcw } from 'lucide-react'
import {
  AGENT_FLOW_DURATION_MS,
  AGENT_FLOW_STEPS,
  AGENT_FLOW_STEP_MS,
  agentFlowBalanceAt,
  agentFlowStepAt,
} from '@/lib/judgesAgentFlow'

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  })

  useEffect(() => {
    if (!window.matchMedia) return
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])

  return reduced
}

interface Packet {
  direction: 'left' | 'right'
  tag: string | null
  document: boolean
}

function packetForStep(step: number): Packet | null {
  if (step === 0) return { direction: 'right', tag: 'GET', document: false }
  if (step === 1) return { direction: 'left', tag: '402', document: false }
  if (step === 3) return { direction: 'right', tag: 'sig', document: false }
  if (step === 5) return { direction: 'left', tag: null, document: true }
  return null
}

export default function AgentPaymentFlow() {
  const sectionRef = useRef<HTMLElement | null>(null)
  const reducedMotion = usePrefersReducedMotion()
  const [isVisible, setIsVisible] = useState(true)
  const [step, setStep] = useState(0)
  const [runId, setRunId] = useState(0)

  useEffect(() => {
    const node = sectionRef.current
    if (!node || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0]
        if (entry) setIsVisible(entry.isIntersecting)
      },
      { threshold: 0.2 },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (reducedMotion || !isVisible) return
    const timer = window.setInterval(() => {
      setStep((current) => agentFlowStepAt((current + 1) * AGENT_FLOW_STEP_MS))
    }, AGENT_FLOW_STEP_MS)
    return () => window.clearInterval(timer)
  }, [reducedMotion, isVisible, runId])

  const replay = useCallback(() => {
    setStep(0)
    setRunId((current) => current + 1)
  }, [])

  const packet = reducedMotion ? null : packetForStep(step)
  const balance = agentFlowBalanceAt(step * AGENT_FLOW_STEP_MS)
  const currentStep = AGENT_FLOW_STEPS[step] ?? AGENT_FLOW_STEPS[0]
  const loopSeconds = AGENT_FLOW_DURATION_MS / 1000
  const httpStatus =
    step === 1 ? '402 Payment Required' : step === 5 ? '200 OK' : 'listening'

  return (
    <section
      ref={sectionRef}
      className={`agent-flow${reducedMotion ? ' is-reduced' : ''}`}
      aria-labelledby="agent-flow-title"
    >
      <header className="agent-flow-head">
        <div className="agent-flow-head-top">
          <p className="agent-flow-kicker">Agent payments, end to end</p>
          <span className="agent-flow-brandtag">x402 / agent payments</span>
        </div>
        <h2 id="agent-flow-title" className="agent-flow-title">
          How an agent with a wallet buys a brief. No account, no login.
        </h2>
        <p className="agent-flow-sub">The endpoint is public. The payment is the credential.</p>
      </header>

      {!reducedMotion && (
        <>
          <div className="agent-flow-stage">
            <div className={`agent-card agent-card-left${step === 2 ? ' is-signing' : ''}`}>
              <div className="agent-card-head">
                <span className="agent-card-name">External agent</span>
                <span className="agent-badge">
                  <span className="agent-badge-dot" aria-hidden="true" />
                  no account
                </span>
              </div>
              <div className="agent-machine" aria-hidden="true">
                <Cpu />
              </div>
              <div className="agent-wallet">
                <span className="agent-wallet-label">own wallet</span>
                <code className="agent-wallet-address">7xKX...9fQ2</code>
                <span className="agent-wallet-balance">
                  <span className="agent-wallet-currency">USDC</span>
                  <span key={`${runId}-${balance}`} className="agent-wallet-amount">
                    {balance.toFixed(2)}
                  </span>
                </span>
                <span
                  className="agent-wallet-delta"
                  data-visible={step === 2 ? 'true' : undefined}
                  aria-hidden="true"
                >
                  -0.01
                </span>
              </div>
              <div
                className="agent-brief-received"
                data-visible={step === 5 ? 'true' : undefined}
              >
                <FileText aria-hidden="true" />
                brief received
              </div>
            </div>

            <div className="agent-lane">
              <div className="agent-lane-line" aria-hidden="true" />
              <div className="agent-lane-tatum" data-active={step === 4 ? 'true' : undefined}>
                <span className="agent-lane-tatum-name">Tatum</span>
                <Check className="agent-lane-tick" aria-hidden="true" />
              </div>
              {packet && (
                <div
                  key={`${runId}-${step}`}
                  className="agent-packet"
                  data-direction={packet.direction}
                  data-document={packet.document ? 'true' : undefined}
                  aria-hidden="true"
                >
                  {packet.tag && <span className="agent-packet-tag">{packet.tag}</span>}
                  {packet.document && <FileText className="agent-packet-doc" />}
                </div>
              )}
            </div>

            <div className="agent-card agent-card-right">
              <div className="agent-card-head">
                <span className="agent-card-name">Gigr</span>
                <span className="agent-public">public endpoint</span>
              </div>
              <img className="agent-gigr-mark" src="/icon.png" alt="" width={44} height={44} />
              <code className="agent-endpoint">GET /api/v1/agent/brief</code>
              <span className={`agent-http${step === 1 ? ' is-402' : ''}${step === 5 ? ' is-200' : ''}`}>
                {httpStatus}
              </span>
            </div>
          </div>

          <div className="agent-flow-progress" aria-hidden="true">
            {AGENT_FLOW_STEPS.map((flowStep, index) => (
              <span
                key={flowStep.id}
                className={`agent-flow-segment${index <= step ? ' is-done' : ''}`}
              />
            ))}
          </div>

          <div className="agent-flow-now">
            <span className="agent-flow-now-index">
              Step {step + 1} of {AGENT_FLOW_STEPS.length}
            </span>
            <span className="agent-flow-now-title">{currentStep.title}</span>
          </div>
        </>
      )}

      {reducedMotion && (
        <p className="agent-flow-static-note">
          <span className="agent-badge">
            <span className="agent-badge-dot" aria-hidden="true" />
            no account
          </span>
          <span>The external agent has its own wallet and never signs in.</span>
        </p>
      )}

      <ol className="agent-flow-beats">
        {AGENT_FLOW_STEPS.map((flowStep, index) => {
          const isCurrent = !reducedMotion && index === step
          return (
            <li
              key={flowStep.id}
              className={`agent-flow-beat${isCurrent ? ' is-current' : ''}`}
              aria-current={isCurrent ? 'step' : undefined}
            >
              <span className="agent-flow-beat-number" aria-hidden="true">
                {index + 1}
              </span>
              <div className="agent-flow-beat-text">
                <p className="agent-flow-beat-title">{flowStep.title}</p>
                <p className="agent-flow-beat-caption">{flowStep.caption}</p>
              </div>
            </li>
          )
        })}
      </ol>

      {!reducedMotion && (
        <div className="agent-flow-controls">
          <span className="agent-flow-loop">
            {loopSeconds} second loop. Paused while off screen.
          </span>
          <button type="button" className="agent-flow-replay" onClick={replay}>
            <RotateCcw aria-hidden="true" />
            Replay
          </button>
        </div>
      )}
    </section>
  )
}
