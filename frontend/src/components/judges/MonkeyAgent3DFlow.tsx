/**
 * MonkeyAgent3DFlow.tsx - Animated Canvas Demonstration of x402 Autonomous Machine Payments.
 *
 * Explains how an autonomous AI agent buys a job brief without human login, credit cards,
 * or API keys using Solana micro-payments and HTTP 402:
 * - Monkey AI Agent (Agent Kong) seeks the "Banana Brief" (job spec and coordinates).
 * - Gigr responds with HTTP 402 Payment Required: 0.01 USDC on Solana.
 * - Agent signs the transaction autonomously using its in-app Solana wallet.
 * - On-chain validation unlocks the gate and delivers the Banana Brief.
 *
 * Uses canvas 2D API for expressive cartoon characters with requestAnimationFrame.
 * Conforms strictly to house-standard.md: ZERO unicode emojis.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { advanceAnim, createSceneAnim, drawScene } from './monkeyScene'
import { ChevronLeft, ChevronRight, Cpu, FileCode2, Lock, Pause, Play, RotateCcw, Unlock, Zap } from 'lucide-react'

export interface StepInfo {
  step: number
  badge: string
  title: string
  sub: string
  detail: string
  status: string
  code: string
}

const FLOW_STEPS: readonly StepInfo[] = [
  {
    step: 1,
    badge: '1. The Discovery',
    title: 'Monkey Agent Seeks the Banana Brief',
    sub: 'Autonomous agent scans local area for high-payout gigs.',
    detail:
      'Agent Kong (an autonomous AI worker) finds an active plumbing task on Gigr. To execute the job, it requests the full "Banana Brief" (the exact coordinates, client phone, and repair specifications).',
    status: 'GET /api/v1/jobs/banana-brief-94',
    code: 'Client: Autonomous AI Agent\nCredential: None (No email, no Google OAuth, no API key)',
  },
  {
    step: 2,
    badge: '2. The Paywall',
    title: 'HTTP 402: Payment Required (0.01 USDC)',
    sub: 'Server halts access and returns on-chain payment challenge.',
    detail:
      'Gigr protects the job brief behind the x402 standard. The server returns HTTP 402 with an on-chain payment challenge: send 0.01 USDC to the Gigr Solana settlement treasury.',
    status: 'HTTP 402 Payment Required',
    code: 'X-Payment-Chain: solana-devnet\nX-Payment-Amount: 0.01 USDC\nX-Payment-Address: GigrEscrow11111111111111111111111111111',
  },
  {
    step: 3,
    badge: '3. Machine Signature',
    title: 'Agent Signs 0.01 USDC Micro-Payment',
    sub: 'Agent signs transaction autonomously using its Solana key.',
    detail:
      'No human popups or password prompts. The agent reads the 402 challenge header, prepares a 0.01 USDC SPL transfer, and signs it cryptographically using its embedded Solana keypair.',
    status: 'Autonomous Key Signing',
    code: 'Keypair: in-app Ed25519 Solana Key\nPayload: Transfer 10,000 atomic units USDC (0.01 USDC)\nTime: 12ms',
  },
  {
    step: 4,
    badge: '4. Solana Settlement',
    title: 'On-Chain Confirmation in 400ms',
    sub: 'Micro-payment settles on Solana with sub-second finality.',
    detail:
      'The transaction broadcasts to Solana. Within 400ms, the transaction is finalized on-chain with minimal gas fees ($0.0002), creating an immutable cryptographic receipt.',
    status: 'Solana Finalized (Slot #312948)',
    code: 'Signature: 4vKz...8mNx\nSettlement: Solana Devnet/Mainnet\nGas: 5,000 lamports ($0.0002)',
  },
  {
    step: 5,
    badge: '5. Signature Verification',
    title: 'Gigr Verifies Signature and Opens Gate',
    sub: 'Server verifies signature without database accounts.',
    detail:
      'Agent retries the GET request with the Solana transaction signature in the Authorization header. Gigr verifies the signature directly against Solana RPC. The gate unlocks instantly.',
    status: 'Verification Passed (200 OK)',
    code: 'Authorization: x402 solana:4vKz...8mNx\nValidator: Gigr Signature Verifier\nResult: Signature Verified and Unspent',
  },
  {
    step: 6,
    badge: '6. Banana Brief Delivered',
    title: 'Agent Receives Coordinates and Starts Gig',
    sub: 'Payment was the credential. The machine gets to work.',
    detail:
      'The Banana Brief unlocks! The autonomous agent receives the decrypted GPS coordinates, customer notes, and milestone escrow contract address. The machine executes the job autonomously.',
    status: '200 OK - Payload Delivered',
    code: 'Banana Brief Payload:\n{\n  "job_id": "banana-brief-94",\n  "coordinates": [6.5244, 3.3792],\n  "escrow_pda": "GigrEscrowAnchorPDA...",\n  "bounty": "45.00 USDC"\n}',
  },
]

// ─── Component ────────────────────────────────────────────────────────────────

export default function MonkeyAgent3DFlow() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [isPlaying, setIsPlaying] = useState(true)
  const [isLightCanvas, setIsLightCanvas] = useState(false)
  const currentStepRef = useRef(0)
  const animRef = useRef(createSceneAnim())
  currentStepRef.current = currentStep

  // Detect parent light mode by checking CSS variable
  useEffect(() => {
    const checkLight = () => {
      const page = document.querySelector('.ea-page')
      if (page) {
        setIsLightCanvas(page.classList.contains('is-light'))
      }
    }
    checkLight()
    // Poll cheaply every 300ms for toggle changes
    const id = setInterval(checkLight, 300)
    return () => clearInterval(id)
  }, [])

  // Step navigation
  const nextStep = useCallback(() => {
    setCurrentStep((prev) => (prev + 1) % FLOW_STEPS.length)
  }, [])
  const prevStep = useCallback(() => {
    setCurrentStep((prev) => (prev - 1 + FLOW_STEPS.length) % FLOW_STEPS.length)
  }, [])
  const selectStep = useCallback((index: number) => {
    setCurrentStep(index)
  }, [])
  const togglePlay = useCallback(() => {
    setIsPlaying((prev) => !prev)
  }, [])
  const resetFlow = useCallback(() => {
    setCurrentStep(0)
  }, [])

  // Auto-advance
  useEffect(() => {
    if (!isPlaying) return
    const timer = setInterval(() => {
      setCurrentStep((prev) => (prev + 1) % FLOW_STEPS.length)
    }, 4500)
    return () => clearInterval(timer)
  }, [isPlaying])

  // Canvas 2D animation loop
  useEffect(() => {
    const canvas = canvasRef.current
    const container = containerRef.current
    if (!canvas || !container) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    let animId: number
    let startTime: number | null = null
    let lastT = 0

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const W = container.clientWidth || 600
      const H = 320
      canvas.width = W * dpr
      canvas.height = H * dpr
      canvas.style.width = `${W}px`
      canvas.style.height = `${H}px`
      ctx.scale(dpr, dpr)
    }

    resize()
    window.addEventListener('resize', resize)

    const loop = (now: number) => {
      animId = requestAnimationFrame(loop)
      if (startTime === null) startTime = now
      const t = (now - startTime) / 1000
      const dt = Math.min(0.1, Math.max(0, t - lastT))
      lastT = t
      advanceAnim(animRef.current, currentStepRef.current, dt)

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const W = canvas.width / dpr
      const H = canvas.height / dpr

      ctx.save()
      drawScene(ctx, W, H, t, currentStepRef.current, isLightCanvas, animRef.current)
      ctx.restore()
    }

    animId = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(animId)
      window.removeEventListener('resize', resize)
    }
  }, [isLightCanvas])

  const currentInfo = FLOW_STEPS[currentStep] || FLOW_STEPS[0]

  return (
    <section className="ea-monkey-stage" aria-labelledby="monkey-stage-title">
      <div className="ea-monkey-head">
        <div className="ea-monkey-tag-strip">
          <span className="ea-monkey-pill">
            <Cpu size={13} aria-hidden="true" />
            Machine-to-Machine Commerce
          </span>
          <span className="ea-monkey-pill ea-monkey-pill-contrast">
            <Zap size={13} aria-hidden="true" />
            x402 Protocol on Solana
          </span>
        </div>

        <h2 id="monkey-stage-title" className="ea-monkey-title">
          How an Autonomous Agent Buys a Job Brief
        </h2>
        <p className="ea-monkey-lede">
          Zero logins. Zero API keys. The payment signature is the access credential.
        </p>
      </div>

      {/* Canvas Stage */}
      <div className="ea-canvas-wrap" ref={containerRef}>
        <canvas ref={canvasRef} className="ea-cartoon-canvas" />

        {/* Floating Callout Badges */}
        <div className="ea-stage-callouts" aria-hidden="true">
          <div className="ea-callout ea-callout-left">
            <div className="ea-callout-icon">
              <Cpu size={15} />
            </div>
            <div>
              <span className="ea-callout-name">Agent Kong</span>
              <span className="ea-callout-role">Autonomous AI Worker</span>
            </div>
          </div>

          <div className="ea-callout ea-callout-center">
            <div className="ea-callout-icon">
              {currentStep <= 3 ? <Lock size={15} /> : <Unlock size={15} />}
            </div>
            <div>
              <span className="ea-callout-name">
                {currentStep <= 3 ? 'HTTP 402 Paywall' : 'Gate Unlocked'}
              </span>
              <span className="ea-callout-role">0.01 USDC on Solana</span>
            </div>
          </div>

          <div className="ea-callout ea-callout-right">
            <div className="ea-callout-icon">
              <FileCode2 size={15} />
            </div>
            <div>
              <span className="ea-callout-name">Banana Brief</span>
              <span className="ea-callout-role">Encrypted Job &amp; GPS Specs</span>
            </div>
          </div>
        </div>
      </div>

      {/* Narrative Step Card */}
      <div className="ea-narrative-card">
        <div className="ea-narrative-top">
          <div className="ea-narrative-meta">
            <span className="ea-step-badge">{currentInfo.badge}</span>
            <span className="ea-step-count">
              Step {currentStep + 1} of {FLOW_STEPS.length}
            </span>
          </div>

          <div className="ea-step-controls">
            <button
              type="button"
              className="ea-step-btn"
              onClick={prevStep}
              aria-label="Previous step"
            >
              <ChevronLeft size={16} aria-hidden="true" />
            </button>

            <button
              type="button"
              className="ea-step-btn"
              onClick={togglePlay}
              aria-label={isPlaying ? 'Pause demonstration' : 'Play demonstration'}
            >
              {isPlaying ? (
                <Pause size={14} aria-hidden="true" />
              ) : (
                <Play size={14} aria-hidden="true" />
              )}
            </button>

            <button
              type="button"
              className="ea-step-btn"
              onClick={resetFlow}
              aria-label="Replay demonstration"
            >
              <RotateCcw size={14} aria-hidden="true" />
            </button>

            <button
              type="button"
              className="ea-step-btn"
              onClick={nextStep}
              aria-label="Next step"
            >
              <ChevronRight size={16} aria-hidden="true" />
            </button>
          </div>
        </div>

        <h3 className="ea-narrative-title">{currentInfo.title}</h3>
        <p className="ea-narrative-sub">{currentInfo.sub}</p>
        <p className="ea-narrative-detail">{currentInfo.detail}</p>

        {/* Terminal */}
        <div className="ea-terminal-box">
          <div className="ea-terminal-head">
            <span className="ea-terminal-dot" />
            <span className="ea-terminal-dot" />
            <span className="ea-terminal-dot" />
            <span className="ea-terminal-title">{currentInfo.status}</span>
          </div>
          <pre className="ea-terminal-code">
            <code>{currentInfo.code}</code>
          </pre>
        </div>

        {/* Step Pills */}
        <div className="ea-step-pills" role="tablist" aria-label="Demonstration steps">
          {FLOW_STEPS.map((s, idx) => {
            const isActive = idx === currentStep
            const isDone = idx < currentStep
            return (
              <button
                key={s.step}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={`ea-step-pill${isActive ? ' is-active' : ''}${isDone ? ' is-done' : ''}`}
                onClick={() => selectStep(idx)}
              >
                <span className="ea-pill-num">{s.step}</span>
                <span className="ea-pill-text">{s.title.split(' ')[0]}</span>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}
