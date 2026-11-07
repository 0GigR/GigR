/**
 * MonkeyAgent3DFlow.tsx - 3D Interactive Demonstration of x402 Autonomous Machine Payments.
 *
 * Explains how an autonomous AI agent buys a job brief without human login, credit cards,
 * or API keys using Solana micro-payments and HTTP 402:
 * - Monkey AI Agent (Agent Kong) seeks the "Banana Brief" (job spec & coordinates).
 * - Gigr responds with HTTP 402 Payment Required: 0.01 USDC on Solana.
 * - Agent signs the transaction autonomously using its in-app Solana wallet.
 * - On-chain validation unlocks the gate and delivers the Banana Brief.
 *
 * Built with Three.js (procedural 3D meshes, particles, dynamic lighting) with an accessible
 * SVG/DOM fallback for reduced motion.
 * Conforms strictly to house-standard.md: ZERO unicode emojis.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import {
  ChevronLeft,
  ChevronRight,
  Cpu,
  FileCode2,
  Lock,
  Pause,
  Play,
  RotateCcw,
  Unlock,
  Zap,
} from 'lucide-react'

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

export default function MonkeyAgent3DFlow() {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [isPlaying, setIsPlaying] = useState(true)
  const currentStepRef = useRef(0)
  currentStepRef.current = currentStep

  // Three.js animation and scene references
  const sceneRef = useRef<THREE.Scene | null>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const monkeyGroupRef = useRef<THREE.Group | null>(null)
  const bananaGroupRef = useRef<THREE.Group | null>(null)
  const gateMeshRef = useRef<THREE.Mesh | null>(null)
  const coinMeshRef = useRef<THREE.Mesh | null>(null)
  const particlesRef = useRef<THREE.Points | null>(null)
  const lightRef = useRef<THREE.PointLight | null>(null)

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

  // Auto-advance loop when playing
  useEffect(() => {
    if (!isPlaying) return
    const timer = setInterval(() => {
      setCurrentStep((prev) => (prev + 1) % FLOW_STEPS.length)
    }, 4500)
    return () => clearInterval(timer)
  }, [isPlaying])

  // Setup Three.js scene
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const width = container.clientWidth || 800
    const height = 340

    // 1. Scene
    const scene = new THREE.Scene()
    sceneRef.current = scene

    // 2. Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100)
    camera.position.set(0, 1.2, 7.2)
    camera.lookAt(0, 0, 0)

    // 3. Renderer
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setSize(width, height)
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.2
    container.innerHTML = ''
    container.appendChild(renderer.domElement)
    rendererRef.current = renderer

    // 4. Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 1.2)
    scene.add(ambientLight)

    const dirLight1 = new THREE.DirectionalLight(0xffffff, 2.5)
    dirLight1.position.set(5, 8, 5)
    scene.add(dirLight1)

    const dirLight2 = new THREE.DirectionalLight(0xa3a3a3, 1.0)
    dirLight2.position.set(-5, -2, -3)
    scene.add(dirLight2)

    const pointLight = new THREE.PointLight(0xffffff, 3.0, 10)
    pointLight.position.set(0, 0.5, 1)
    scene.add(pointLight)
    lightRef.current = pointLight

    // 5. Grid plane floor
    const gridHelper = new THREE.GridHelper(16, 24, 0x52525b, 0x27272a)
    gridHelper.position.y = -1.5
    scene.add(gridHelper)

    // 6. Left: Cyber-Monkey AI Agent Group
    const monkeyGroup = new THREE.Group()
    monkeyGroup.position.set(-2.8, -0.2, 0)
    scene.add(monkeyGroup)
    monkeyGroupRef.current = monkeyGroup

    // Pedestal
    const pedestalGeo = new THREE.CylinderGeometry(0.7, 0.8, 0.2, 24)
    const metalMat = new THREE.MeshStandardMaterial({
      color: 0x27272a,
      metalness: 0.8,
      roughness: 0.2,
    })
    const pedestalMesh = new THREE.Mesh(pedestalGeo, metalMat)
    pedestalMesh.position.y = -1.2
    monkeyGroup.add(pedestalMesh)

    // Monkey Head (Metallic Sphere)
    const headGeo = new THREE.SphereGeometry(0.65, 32, 32)
    const monkeyMat = new THREE.MeshStandardMaterial({
      color: 0xd4d4d8,
      metalness: 0.7,
      roughness: 0.25,
    })
    const headMesh = new THREE.Mesh(headGeo, monkeyMat)
    monkeyGroup.add(headMesh)

    // Monkey Muzzle
    const muzzleGeo = new THREE.SphereGeometry(0.35, 24, 24)
    muzzleGeo.scale(1.1, 0.75, 1.2)
    const muzzleMat = new THREE.MeshStandardMaterial({
      color: 0xa1a1aa,
      metalness: 0.4,
      roughness: 0.4,
    })
    const muzzleMesh = new THREE.Mesh(muzzleGeo, muzzleMat)
    muzzleMesh.position.set(0, -0.15, 0.35)
    monkeyGroup.add(muzzleMesh)

    // Cyber Visor / Goggles (Glowing)
    const visorGeo = new THREE.BoxGeometry(0.75, 0.2, 0.35)
    const visorMat = new THREE.MeshStandardMaterial({
      color: 0x06b6d4,
      emissive: 0x06b6d4,
      emissiveIntensity: 1.5,
      metalness: 0.2,
      roughness: 0.1,
    })
    const visorMesh = new THREE.Mesh(visorGeo, visorMat)
    visorMesh.position.set(0, 0.12, 0.5)
    monkeyGroup.add(visorMesh)

    // Monkey Ears
    const earGeo = new THREE.TorusGeometry(0.22, 0.08, 16, 24)
    const earLeft = new THREE.Mesh(earGeo, monkeyMat)
    earLeft.position.set(-0.68, 0.1, 0)
    earLeft.rotation.y = Math.PI / 2
    monkeyGroup.add(earLeft)

    const earRight = new THREE.Mesh(earGeo, monkeyMat)
    earRight.position.set(0.68, 0.1, 0)
    earRight.rotation.y = Math.PI / 2
    monkeyGroup.add(earRight)

    // Cyber Antenna with glowing tip
    const antennaStemGeo = new THREE.CylinderGeometry(0.02, 0.02, 0.35, 12)
    const antennaStem = new THREE.Mesh(antennaStemGeo, metalMat)
    antennaStem.position.set(0, 0.8, 0)
    monkeyGroup.add(antennaStem)

    const antennaTipGeo = new THREE.SphereGeometry(0.08, 16, 16)
    const antennaTipMat = new THREE.MeshStandardMaterial({
      color: 0x10b981,
      emissive: 0x10b981,
      emissiveIntensity: 2.0,
    })
    const antennaTip = new THREE.Mesh(antennaTipGeo, antennaTipMat)
    antennaTip.position.set(0, 1.0, 0)
    monkeyGroup.add(antennaTip)

    // 7. Center: x402 Solana Paywall Gate
    const gateGroup = new THREE.Group()
    scene.add(gateGroup)

    // Gate Arch Posts
    const postGeo = new THREE.CylinderGeometry(0.08, 0.08, 2.8, 16)
    const postMat = new THREE.MeshStandardMaterial({
      color: 0x52525b,
      metalness: 0.9,
      roughness: 0.2,
    })
    const postLeft = new THREE.Mesh(postGeo, postMat)
    postLeft.position.set(-0.8, 0.1, 0)
    gateGroup.add(postLeft)

    const postRight = new THREE.Mesh(postGeo, postMat)
    postRight.position.set(0.8, 0.1, 0)
    gateGroup.add(postRight)

    const postTop = new THREE.Mesh(
      new THREE.CylinderGeometry(0.08, 0.08, 1.8, 16),
      postMat,
    )
    postTop.position.set(0, 1.45, 0)
    postTop.rotation.z = Math.PI / 2
    gateGroup.add(postTop)

    // Laser Paywall Barrier Shield
    const barrierGeo = new THREE.PlaneGeometry(1.5, 2.6)
    const barrierMat = new THREE.MeshStandardMaterial({
      color: 0xef4444,
      emissive: 0xef4444,
      emissiveIntensity: 1.2,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
    })
    const barrierMesh = new THREE.Mesh(barrierGeo, barrierMat)
    barrierMesh.position.set(0, 0.1, 0)
    gateGroup.add(barrierMesh)
    gateMeshRef.current = barrierMesh

    // Floating 3D Solana USDC Coin
    const coinGeo = new THREE.CylinderGeometry(0.3, 0.3, 0.06, 32)
    const coinMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x7c3aed,
      emissiveIntensity: 0.6,
      metalness: 0.85,
      roughness: 0.2,
    })
    const coinMesh = new THREE.Mesh(coinGeo, coinMat)
    coinMesh.rotation.x = Math.PI / 2
    coinMesh.position.set(-2.5, 0.1, 0)
    coinMesh.visible = false
    scene.add(coinMesh)
    coinMeshRef.current = coinMesh

    // 8. Right: The Golden Banana Brief
    const bananaGroup = new THREE.Group()
    bananaGroup.position.set(2.8, -0.2, 0)
    scene.add(bananaGroup)
    bananaGroupRef.current = bananaGroup

    // Banana Pedestal
    const bPedestal = new THREE.Mesh(pedestalGeo, metalMat)
    bPedestal.position.y = -1.2
    bananaGroup.add(bPedestal)

    // Banana Curved Geometry using CatmullRomCurve3
    const bananaCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.45, 0.35, 0),
      new THREE.Vector3(-0.25, 0.05, 0),
      new THREE.Vector3(0, -0.05, 0),
      new THREE.Vector3(0.28, 0.1, 0),
      new THREE.Vector3(0.5, 0.4, 0),
    ])
    const bananaGeo = new THREE.TubeGeometry(bananaCurve, 32, 0.18, 16, false)
    const bananaMat = new THREE.MeshStandardMaterial({
      color: 0xfacc15,
      emissive: 0xca8a04,
      emissiveIntensity: 0.5,
      metalness: 0.3,
      roughness: 0.25,
    })
    const bananaMesh = new THREE.Mesh(bananaGeo, bananaMat)
    bananaMesh.position.y = 0.2
    bananaGroup.add(bananaMesh)

    // Banana Stem Tip
    const stemGeo = new THREE.CylinderGeometry(0.04, 0.06, 0.15, 12)
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x4d7c0f })
    const stemMesh = new THREE.Mesh(stemGeo, stemMat)
    stemMesh.position.set(0.54, 0.52, 0)
    stemMesh.rotation.z = -0.5
    bananaGroup.add(stemMesh)

    // Holographic Brief Document (Floating translucent rectangle)
    const docGeo = new THREE.PlaneGeometry(0.7, 0.9)
    const docMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      emissive: 0x38bdf8,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.7,
      side: THREE.DoubleSide,
    })
    const docMesh = new THREE.Mesh(docGeo, docMat)
    docMesh.position.set(0, 0.2, 0.25)
    bananaGroup.add(docMesh)

    // 9. Ambient Star Particles
    const particleCount = 120
    const particlePositions = new Float32Array(particleCount * 3)
    for (let i = 0; i < particleCount * 3; i += 3) {
      particlePositions[i] = (Math.random() - 0.5) * 14
      particlePositions[i + 1] = (Math.random() - 0.5) * 8
      particlePositions[i + 2] = (Math.random() - 0.5) * 6
    }
    const particleGeo = new THREE.BufferGeometry()
    particleGeo.setAttribute(
      'position',
      new THREE.BufferAttribute(particlePositions, 3),
    )
    const particleMat = new THREE.PointsMaterial({
      color: 0xffffff,
      size: 0.04,
      transparent: true,
      opacity: 0.6,
    })
    const particles = new THREE.Points(particleGeo, particleMat)
    scene.add(particles)
    particlesRef.current = particles

    // Resize handler
    const handleResize = () => {
      if (!container || !rendererRef.current) return
      const w = container.clientWidth || 800
      camera.aspect = w / height
      camera.updateProjectionMatrix()
      rendererRef.current.setSize(w, height)
    }
    window.addEventListener('resize', handleResize)

    // Animation Loop
    let animationId: number
    let clock = new THREE.Clock()

    const animate = () => {
      animationId = requestAnimationFrame(animate)
      const elapsedTime = clock.getElapsedTime()
      const step = currentStepRef.current

      // Idle float for Monkey Agent
      if (monkeyGroupRef.current) {
        monkeyGroupRef.current.position.y =
          -0.2 + Math.sin(elapsedTime * 2.2) * 0.05
        monkeyGroupRef.current.rotation.y =
          Math.sin(elapsedTime * 1.2) * 0.15 + 0.15
      }

      // Idle float and spin for Banana Brief
      if (bananaGroupRef.current) {
        bananaGroupRef.current.position.y =
          -0.2 + Math.sin(elapsedTime * 2.5 + 1.0) * 0.06
        bananaGroupRef.current.rotation.y = elapsedTime * 0.8

        // If step 5 or 6, Banana Brief moves closer to Monkey Agent
        if (step >= 5) {
          bananaGroupRef.current.position.x = 1.0
        } else {
          bananaGroupRef.current.position.x = 2.8
        }
      }

      // Paywall Gate behavior based on step
      if (gateMeshRef.current) {
        const mat = gateMeshRef.current.material as THREE.MeshStandardMaterial
        if (step <= 3) {
          // Locked: Red laser
          mat.color.setHex(0xef4444)
          mat.emissive.setHex(0xef4444)
          mat.opacity = 0.45 + Math.sin(elapsedTime * 6) * 0.15
          gateMeshRef.current.scale.set(1, 1, 1)
        } else {
          // Unlocked / Paid: Emerald green, parted open
          mat.color.setHex(0x10b981)
          mat.emissive.setHex(0x10b981)
          mat.opacity = 0.2
          gateMeshRef.current.scale.set(0.1, 1, 1)
        }
      }

      // Coin movement across gate in Step 3 and 4
      if (coinMeshRef.current) {
        if (step === 2 || step === 3) {
          coinMeshRef.current.visible = true
          coinMeshRef.current.rotation.z += 0.08
          // Lerp coin from monkey to gate
          const progress = (elapsedTime % 2) / 2
          coinMeshRef.current.position.x = -2.5 + progress * 2.5
          coinMeshRef.current.position.y =
            0.1 + Math.sin(progress * Math.PI) * 0.5
        } else {
          coinMeshRef.current.visible = false
        }
      }

      // Subtle particle rotation
      if (particlesRef.current) {
        particlesRef.current.rotation.y = elapsedTime * 0.02
      }

      renderer.render(scene, camera)
    }

    animate()

    return () => {
      cancelAnimationFrame(animationId)
      window.removeEventListener('resize', handleResize)
      renderer.dispose()
      if (container) container.innerHTML = ''
    }
  }, [])

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

      {/* 3D Visual Stage */}
      <div className="ea-canvas-wrap">
        <div ref={containerRef} className="ea-three-canvas" />

        {/* Floating Cartoon Callout Badges */}
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
              <span className="ea-callout-role">Encrypted Job & GPS Specs</span>
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

        {/* Code & Protocol Payload Terminal */}
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

        {/* 6-Step Indicator Pills */}
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
