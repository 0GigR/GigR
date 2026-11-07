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

// ─── Canvas drawing helpers ───────────────────────────────────────────────────

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.lineTo(x + w - r, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + r)
  ctx.lineTo(x + w, y + h - r)
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h)
  ctx.lineTo(x + r, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - r)
  ctx.lineTo(x, y + r)
  ctx.quadraticCurveTo(x, y, x + r, y)
  ctx.closePath()
}

/** Draw the cartoon monkey face at center cx, cy with given radius */
function drawMonkey(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  t: number, // time for animation
  step: number,
  isLight: boolean,
) {
  const browFur = '#8B5E3C'
  const faceFur = '#C4813C'
  const muzzleColor = '#F0C98E'
  const eyeWhite = '#FFFFFF'
  const eyePupil = '#1A1A1A'
  const eyeHighlight = '#FFFFFF'
  const techBlue = '#38BDF8'
  const techGreen = '#10B981'

  // Shadow / glow ring behind monkey
  const isExcited = step >= 2 && step <= 3
  const isSuccess = step >= 4
  const glowColor = isSuccess ? techGreen : isExcited ? '#EF4444' : techBlue

  ctx.save()
  ctx.shadowColor = glowColor
  ctx.shadowBlur = 20
  ctx.beginPath()
  ctx.arc(cx, cy, r + 4, 0, Math.PI * 2)
  ctx.strokeStyle = glowColor
  ctx.lineWidth = 2.5
  ctx.globalAlpha = 0.55 + 0.2 * Math.sin(t * 3)
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.shadowBlur = 0
  ctx.restore()

  // Ears (behind head)
  const earLX = cx - r * 0.88
  const earRX = cx + r * 0.88
  const earY = cy - r * 0.1

  for (const ex of [earLX, earRX]) {
    // outer ear
    ctx.beginPath()
    ctx.arc(ex, earY, r * 0.28, 0, Math.PI * 2)
    ctx.fillStyle = browFur
    ctx.fill()
    // inner ear
    ctx.beginPath()
    ctx.arc(ex, earY, r * 0.15, 0, Math.PI * 2)
    ctx.fillStyle = muzzleColor
    ctx.fill()
  }

  // Head
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = browFur
  ctx.fill()

  // Face patch (lighter center)
  ctx.beginPath()
  ctx.ellipse(cx, cy + r * 0.08, r * 0.72, r * 0.78, 0, 0, Math.PI * 2)
  ctx.fillStyle = faceFur
  ctx.fill()

  // Forehead fur tuft
  ctx.beginPath()
  ctx.arc(cx, cy - r * 0.78, r * 0.22, 0, Math.PI)
  ctx.fillStyle = browFur
  ctx.fill()

  // Cyber goggles / visor bar
  const visorY = cy - r * 0.2
  roundRect(ctx, cx - r * 0.65, visorY - r * 0.14, r * 1.3, r * 0.3, r * 0.1)
  const visorGrad = ctx.createLinearGradient(cx - r * 0.65, visorY, cx + r * 0.65, visorY)
  visorGrad.addColorStop(0, techBlue)
  visorGrad.addColorStop(1, '#7C3AED')
  ctx.fillStyle = visorGrad
  ctx.fill()
  // Visor shine
  ctx.beginPath()
  roundRect(ctx, cx - r * 0.6, visorY - r * 0.1, r * 1.2, r * 0.1, r * 0.05)
  ctx.fillStyle = 'rgba(255,255,255,0.3)'
  ctx.fill()

  // Eyes (peeking above visor) - two white circles
  const eyeY = cy - r * 0.3
  const eyeOffX = r * 0.3
  for (const sign of [-1, 1]) {
    const ex = cx + sign * eyeOffX
    // White sclera
    ctx.beginPath()
    ctx.arc(ex, eyeY, r * 0.17, 0, Math.PI * 2)
    ctx.fillStyle = eyeWhite
    ctx.fill()
    // Pupil - moves slightly with time
    const pupilDX = sign * r * 0.04 + Math.sin(t * 1.5) * r * 0.04
    const pupilDY = -r * 0.02 + Math.cos(t * 1.2) * r * 0.03
    ctx.beginPath()
    ctx.arc(ex + pupilDX, eyeY + pupilDY, r * 0.09, 0, Math.PI * 2)
    ctx.fillStyle = eyePupil
    ctx.fill()
    // Eye highlight
    ctx.beginPath()
    ctx.arc(ex + pupilDX - r * 0.03, eyeY + pupilDY - r * 0.03, r * 0.03, 0, Math.PI * 2)
    ctx.fillStyle = eyeHighlight
    ctx.fill()
  }

  // Muzzle / snout area
  ctx.beginPath()
  ctx.ellipse(cx, cy + r * 0.35, r * 0.42, r * 0.3, 0, 0, Math.PI * 2)
  ctx.fillStyle = muzzleColor
  ctx.fill()

  // Nostrils
  for (const sign of [-1, 1]) {
    ctx.beginPath()
    ctx.arc(cx + sign * r * 0.1, cy + r * 0.3, r * 0.055, 0, Math.PI * 2)
    ctx.fillStyle = browFur
    ctx.fill()
  }

  // Mouth - smile in success, neutral otherwise, worried in step 2
  const mouthY = cy + r * 0.52
  ctx.beginPath()
  if (step >= 5) {
    // Big happy grin
    ctx.arc(cx, mouthY - r * 0.1, r * 0.28, 0.1 * Math.PI, 0.9 * Math.PI)
  } else if (step === 2) {
    // Worried O
    ctx.arc(cx, mouthY, r * 0.1, 0, Math.PI * 2)
  } else {
    // Neutral slight smile
    ctx.arc(cx, mouthY - r * 0.05, r * 0.22, 0.15 * Math.PI, 0.85 * Math.PI)
  }
  ctx.strokeStyle = browFur
  ctx.lineWidth = 2.5
  ctx.stroke()

  // CPU badge on forehead
  const badgeSize = r * 0.3
  const badgeX = cx - badgeSize / 2
  const badgeY = cy - r * 0.72 - badgeSize / 2
  roundRect(ctx, badgeX, badgeY, badgeSize, badgeSize, 4)
  ctx.fillStyle = '#141416'
  ctx.fill()
  ctx.strokeStyle = techBlue
  ctx.lineWidth = 1.5
  ctx.stroke()
  // CPU grid lines
  ctx.strokeStyle = techBlue
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.7
  for (let i = 1; i <= 2; i++) {
    const seg = badgeSize / 3
    ctx.beginPath()
    ctx.moveTo(badgeX + seg * i, badgeY + 2)
    ctx.lineTo(badgeX + seg * i, badgeY + badgeSize - 2)
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(badgeX + 2, badgeY + seg * i)
    ctx.lineTo(badgeX + badgeSize - 2, badgeY + seg * i)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  // Antenna on top
  const antennaBaseX = cx + r * 0.15
  const antennaBaseY = cy - r
  ctx.beginPath()
  ctx.moveTo(antennaBaseX, antennaBaseY)
  ctx.lineTo(antennaBaseX + r * 0.08, antennaBaseY - r * 0.45)
  ctx.strokeStyle = '#71717A'
  ctx.lineWidth = 2
  ctx.stroke()
  // Antenna tip glow
  const tipX = antennaBaseX + r * 0.08
  const tipY = antennaBaseY - r * 0.45
  ctx.beginPath()
  ctx.arc(tipX, tipY, r * 0.07, 0, Math.PI * 2)
  const pulseAlpha = 0.6 + 0.4 * Math.sin(t * 5)
  ctx.fillStyle = isSuccess ? techGreen : techBlue
  ctx.globalAlpha = pulseAlpha
  ctx.fill()
  ctx.globalAlpha = 1

  // Label below
  ctx.font = `bold ${Math.round(r * 0.3)}px -apple-system, sans-serif`
  ctx.fillStyle = isLight ? '#3F3F46' : '#A1A1AA'
  ctx.textAlign = 'center'
  ctx.fillText('Agent Kong', cx, cy + r + r * 0.45)
  ctx.font = `${Math.round(r * 0.23)}px -apple-system, sans-serif`
  ctx.fillStyle = isLight ? '#71717A' : '#71717A'
  ctx.fillText('AI Worker', cx, cy + r + r * 0.75)
}

/** Draw the x402 paywall gate at center cx, cy */
function drawGate(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  w: number,
  h: number,
  t: number,
  step: number,
  isLight: boolean,
) {
  const isLocked = step <= 2
  const isTransacting = step === 3 || step === 4
  const isOpen = step >= 5

  const baseColor = isOpen ? '#10B981' : isLocked ? '#EF4444' : '#F59E0B'
  const pulseMag = 0.08
  const pulse = 1 + pulseMag * Math.sin(t * (isTransacting ? 8 : 3))

  // Gate pillars
  const pillarW = w * 0.1
  const pillarH = h * 0.82
  const pillarY = cy - pillarH / 2

  // Left pillar
  const leftPillarX = cx - w / 2
  const rightPillarX = cx + w / 2 - pillarW

  for (const px of [leftPillarX, rightPillarX]) {
    // Pillar body
    roundRect(ctx, px, pillarY, pillarW, pillarH, 5)
    ctx.fillStyle = isLight ? '#E4E4E7' : '#27272A'
    ctx.fill()
    ctx.strokeStyle = isLight ? '#D4D4D8' : '#3F3F46'
    ctx.lineWidth = 1
    ctx.stroke()

    // Glowing accent strip on each pillar
    ctx.save()
    ctx.shadowColor = baseColor
    ctx.shadowBlur = 10
    roundRect(ctx, px + pillarW * 0.3, pillarY + 8, pillarW * 0.4, pillarH - 16, 2)
    ctx.fillStyle = baseColor
    ctx.globalAlpha = 0.7 + 0.3 * Math.sin(t * 3)
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.restore()
  }

  // Top bar connecting pillars
  const barY = cy - pillarH / 2 - 8
  roundRect(ctx, leftPillarX, barY, w, 14, 5)
  ctx.fillStyle = isLight ? '#E4E4E7' : '#27272A'
  ctx.fill()

  // Gate barrier shield / laser field
  if (!isOpen) {
    const shieldX = leftPillarX + pillarW
    const shieldW = w - pillarW * 2
    const shieldY = pillarY + 2
    const shieldH = pillarH - 4

    // Gradient energy field
    const shieldGrad = ctx.createLinearGradient(shieldX, shieldY, shieldX, shieldY + shieldH)
    shieldGrad.addColorStop(0, `${baseColor}00`)
    shieldGrad.addColorStop(0.2, `${baseColor}99`)
    shieldGrad.addColorStop(0.5, `${baseColor}CC`)
    shieldGrad.addColorStop(0.8, `${baseColor}99`)
    shieldGrad.addColorStop(1, `${baseColor}00`)

    ctx.save()
    ctx.globalAlpha = 0.5 * pulse
    ctx.shadowColor = baseColor
    ctx.shadowBlur = 20
    roundRect(ctx, shieldX, shieldY, shieldW, shieldH, 4)
    ctx.fillStyle = shieldGrad
    ctx.fill()
    ctx.restore()

    // Scanline stripes
    ctx.save()
    ctx.globalAlpha = 0.18 + 0.08 * Math.sin(t * 6)
    for (let i = 0; i < shieldH; i += 10) {
      ctx.fillStyle = baseColor
      ctx.fillRect(shieldX, shieldY + i, shieldW, 4)
    }
    ctx.restore()
  } else {
    // Open gate - show green checkmark glow
    ctx.save()
    ctx.shadowColor = '#10B981'
    ctx.shadowBlur = 30
    ctx.font = `bold ${Math.round(h * 0.35)}px -apple-system, sans-serif`
    ctx.fillStyle = '#10B981'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.globalAlpha = 0.9 + 0.1 * Math.sin(t * 2)
    ctx.fillText('OK', cx, cy)
    ctx.restore()
    ctx.textBaseline = 'alphabetic'
  }

  // Gate label badge at top
  const labelText = isOpen ? 'UNLOCKED' : isTransacting ? 'VERIFYING' : 'HTTP 402'
  const labelBg = isOpen ? '#10B981' : isTransacting ? '#F59E0B' : '#EF4444'
  const lw = 76
  const lh = 22
  const lx = cx - lw / 2
  const ly = barY - lh - 6

  roundRect(ctx, lx, ly, lw, lh, 6)
  ctx.fillStyle = labelBg
  ctx.fill()
  ctx.font = `bold 11px -apple-system, monospace`
  ctx.fillStyle = '#FFFFFF'
  ctx.textAlign = 'center'
  ctx.fillText(labelText, cx, ly + 15)

  // Lock / unlock icon hint
  const iconY = cy + pillarH / 2 + 16
  ctx.font = `12px -apple-system, sans-serif`
  ctx.fillStyle = isOpen ? '#10B981' : '#EF4444'
  ctx.textAlign = 'center'
  ctx.fillText(isOpen ? 'Gate Open' : 'Locked', cx, iconY)

  // Amount pill below gate
  ctx.font = `bold 11px ui-monospace, monospace`
  ctx.fillStyle = isLight ? '#52525B' : '#A1A1AA'
  ctx.textAlign = 'center'
  ctx.fillText('0.01 USDC on Solana', cx, iconY + 18)
}

/** Draw the banana (job brief) at cx, cy */
function drawBanana(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  t: number,
  step: number,
  isLight: boolean,
) {
  const isUnlocked = step >= 5
  const glowColor = isUnlocked ? '#10B981' : '#FACC15'

  // Glow ring
  ctx.save()
  ctx.shadowColor = glowColor
  ctx.shadowBlur = isUnlocked ? 30 : 16
  ctx.beginPath()
  ctx.arc(cx, cy, r + 4, 0, Math.PI * 2)
  ctx.strokeStyle = glowColor
  ctx.lineWidth = 2
  ctx.globalAlpha = 0.5 + 0.25 * Math.sin(t * 2.5)
  ctx.stroke()
  ctx.globalAlpha = 1
  ctx.restore()

  // Banana body - curved tube drawn with bezier
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate(-0.3)

  const bLen = r * 1.1
  const bThick = r * 0.32

  // Shadow
  ctx.beginPath()
  ctx.moveTo(-bLen, bThick * 0.3)
  ctx.quadraticCurveTo(0, bThick * 1.4, bLen, bThick * 0.3)
  ctx.quadraticCurveTo(bLen, -bThick * 0.5, 0, -bThick * 0.6)
  ctx.quadraticCurveTo(-bLen, -bThick * 0.5, -bLen, bThick * 0.3)
  ctx.closePath()
  ctx.fillStyle = 'rgba(0,0,0,0.12)'
  ctx.fill()

  // Banana yellow gradient
  const bananaGrad = ctx.createLinearGradient(-bLen, -bThick, bLen, bThick)
  bananaGrad.addColorStop(0, '#FDE68A')
  bananaGrad.addColorStop(0.4, '#FBBF24')
  bananaGrad.addColorStop(1, '#D97706')

  ctx.beginPath()
  ctx.moveTo(-bLen, 0)
  ctx.quadraticCurveTo(0, bThick * 1.1, bLen, 0)
  ctx.quadraticCurveTo(bLen, -bThick, 0, -bThick * 0.5)
  ctx.quadraticCurveTo(-bLen, -bThick, -bLen, 0)
  ctx.closePath()
  ctx.fillStyle = bananaGrad
  ctx.fill()

  // Highlight streak on top of banana
  ctx.beginPath()
  ctx.moveTo(-bLen * 0.7, -bThick * 0.1)
  ctx.quadraticCurveTo(0, bThick * 0.3, bLen * 0.7, -bThick * 0.1)
  ctx.strokeStyle = 'rgba(255,255,255,0.45)'
  ctx.lineWidth = bThick * 0.3
  ctx.lineCap = 'round'
  ctx.stroke()

  // Stem tip (green)
  ctx.beginPath()
  ctx.arc(bLen, 0, bThick * 0.35, 0, Math.PI * 2)
  ctx.fillStyle = '#4D7C0F'
  ctx.fill()

  ctx.restore()

  // If unlocked - show document overlay
  if (isUnlocked) {
    const docW = r * 0.9
    const docH = r * 1.1
    const docX = cx - docW / 2 + r * 0.5
    const docY = cy - docH / 2 - r * 0.2

    ctx.save()
    ctx.shadowColor = '#10B981'
    ctx.shadowBlur = 20
    roundRect(ctx, docX, docY, docW, docH, 6)
    ctx.fillStyle = isLight ? '#F0FDF4' : '#052E16'
    ctx.fill()
    ctx.strokeStyle = '#10B981'
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.restore()

    // Doc lines
    ctx.fillStyle = isLight ? '#166534' : '#86EFAC'
    ctx.font = `bold 9px ui-monospace, monospace`
    ctx.textAlign = 'left'
    const lines = ['job_id: B-94', 'lat: 6.5244', 'lng: 3.3792', 'USDC: 45.00']
    lines.forEach((line, i) => {
      ctx.fillText(line, docX + 7, docY + 16 + i * 14)
    })
  }

  // Brief label
  ctx.font = `bold ${Math.round(r * 0.3)}px -apple-system, sans-serif`
  ctx.fillStyle = isLight ? '#3F3F46' : '#A1A1AA'
  ctx.textAlign = 'center'
  ctx.fillText('Banana Brief', cx, cy + r + r * 0.45)
  ctx.font = `${Math.round(r * 0.23)}px -apple-system, sans-serif`
  ctx.fillStyle = '#71717A'
  ctx.fillText('Encrypted Job Spec', cx, cy + r + r * 0.75)
}

/** Draw an animated coin traveling from monkey to gate */
function drawCoin(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  toX: number,
  baseY: number,
  t: number,
  step: number,
) {
  if (step < 2 || step > 4) return

  const count = step === 4 ? 3 : 2
  for (let i = 0; i < count; i++) {
    const offset = (i / count) * 2
    const progress = ((t * 0.6 + offset) % 1 + 1) % 1
    const x = fromX + (toX - fromX) * progress
    const y = baseY - 32 * Math.sin(progress * Math.PI)
    const scale = 0.7 + 0.3 * Math.sin(progress * Math.PI)

    ctx.save()
    ctx.translate(x, y)
    ctx.scale(scale, scale)

    // Coin body
    ctx.beginPath()
    ctx.arc(0, 0, 12, 0, Math.PI * 2)
    const coinGrad = ctx.createRadialGradient(-3, -3, 1, 0, 0, 12)
    coinGrad.addColorStop(0, '#FBBF24')
    coinGrad.addColorStop(0.6, '#D97706')
    coinGrad.addColorStop(1, '#92400E')
    ctx.fillStyle = coinGrad
    ctx.fill()

    // Coin edge
    ctx.strokeStyle = '#F59E0B'
    ctx.lineWidth = 1.5
    ctx.stroke()

    // S symbol for USDC
    ctx.font = 'bold 11px -apple-system, sans-serif'
    ctx.fillStyle = '#FEFCE8'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('$', 0, 0)
    ctx.textBaseline = 'alphabetic'

    ctx.restore()
  }
}

/** Draw a speech bubble */
function drawBubble(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  text: string[],
  isLight: boolean,
  tailSide: 'left' | 'right' = 'left',
) {
  const padding = 10
  const lineH = 16
  const bubbleW = 148
  const bubbleH = text.length * lineH + padding * 2
  const bx = tailSide === 'right' ? cx - bubbleW - 10 : cx + 10
  const by = cy - bubbleH / 2

  roundRect(ctx, bx, by, bubbleW, bubbleH, 8)
  ctx.fillStyle = isLight ? '#1C1C1E' : '#FFFFFF'
  ctx.fill()

  // Tail
  ctx.beginPath()
  if (tailSide === 'left') {
    ctx.moveTo(bx, by + bubbleH / 2 - 6)
    ctx.lineTo(cx + 8, by + bubbleH / 2)
    ctx.lineTo(bx, by + bubbleH / 2 + 6)
  } else {
    ctx.moveTo(bx + bubbleW, by + bubbleH / 2 - 6)
    ctx.lineTo(cx - 8, by + bubbleH / 2)
    ctx.lineTo(bx + bubbleW, by + bubbleH / 2 + 6)
  }
  ctx.closePath()
  ctx.fillStyle = isLight ? '#1C1C1E' : '#FFFFFF'
  ctx.fill()

  // Text
  ctx.font = `600 11px ui-monospace, monospace`
  ctx.fillStyle = isLight ? '#FFFFFF' : '#000000'
  ctx.textAlign = 'left'
  text.forEach((line, i) => {
    ctx.fillText(line, bx + padding, by + padding + lineH * (i + 0.72))
  })
}

/** Decide what speech bubble text the monkey shows */
function monkeyBubbleText(step: number): string[] {
  switch (step) {
    case 0: return ['GET /banana-brief-94', 'Looking for work...']
    case 1: return ['GET /banana-brief-94', 'Requesting job brief']
    case 2: return ['HTTP 402 Received!', 'Need to pay 0.01 USDC']
    case 3: return ['Signing tx...', 'Ed25519 key ready']
    case 4: return ['Tx broadcast!', 'Waiting 400ms...']
    case 5: return ['Signature verified!', 'Sending retry GET']
    default: return ['Got the brief!', 'Starting gig now']
  }
}

/** Full scene draw function called each animation frame */
function drawScene(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  t: number,
  step: number,
  isLight: boolean,
) {
  // Background
  ctx.clearRect(0, 0, W, H)
  const bgColor = isLight ? '#FAFAFA' : '#0A0A0A'
  ctx.fillStyle = bgColor
  ctx.fillRect(0, 0, W, H)

  // Subtle dot grid
  ctx.fillStyle = isLight ? 'rgba(0,0,0,0.055)' : 'rgba(255,255,255,0.045)'
  const gridSpacing = 28
  for (let gx = 0; gx < W; gx += gridSpacing) {
    for (let gy = 0; gy < H; gy += gridSpacing) {
      ctx.beginPath()
      ctx.arc(gx, gy, 1, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // ── Layout calculations ───────────────────────────────────────────────────────
  const monkeyR = Math.min(H * 0.22, W * 0.11, 56)
  const margin = monkeyR * 1.2
  const usableW = W - margin * 2

  // Monkey position (left side)
  const monkeyX = margin + monkeyR * 0.5
  const monkeyY = H * 0.42

  // Gate position (center)
  const gateW = Math.min(usableW * 0.22, 110)
  const gateH = H * 0.52
  const gateCX = W * 0.5

  // Banana position moves towards monkey if unlocked
  const bananaR = monkeyR * 0.88
  const bananaTargetX = step >= 5 ? W * 0.68 : W - margin - bananaR * 0.5
  const bananaX = bananaTargetX
  const bananaY = H * 0.42

  // If step >= 5, banana drifts toward monkey
  const finalBananaX = step >= 5 ? monkeyX + monkeyR * 2.5 : bananaX

  // Connecting ground line
  const lineY = H * 0.72
  ctx.beginPath()
  ctx.moveTo(monkeyX, lineY)
  ctx.lineTo(finalBananaX > bananaX ? bananaX : finalBananaX, lineY)
  ctx.strokeStyle = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)'
  ctx.lineWidth = 1
  ctx.setLineDash([6, 6])
  ctx.stroke()
  ctx.setLineDash([])

  // Arrow line from monkey toward gate when step >= 1
  if (step >= 1 && step < 5) {
    const arrowStartX = monkeyX + monkeyR + 12
    const arrowEndX = gateCX - gateW / 2 - 12

    ctx.beginPath()
    ctx.moveTo(arrowStartX, monkeyY)
    ctx.lineTo(arrowEndX, monkeyY)
    ctx.strokeStyle = step <= 2 ? '#EF4444' : '#10B981'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    ctx.stroke()
    ctx.setLineDash([])

    // Arrowhead
    ctx.beginPath()
    ctx.moveTo(arrowEndX, monkeyY)
    ctx.lineTo(arrowEndX - 10, monkeyY - 5)
    ctx.lineTo(arrowEndX - 10, monkeyY + 5)
    ctx.closePath()
    ctx.fillStyle = step <= 2 ? '#EF4444' : '#10B981'
    ctx.fill()
  }

  // After gate opens, draw arrow from gate to banana
  if (step >= 5) {
    const arrowStartX = gateCX + gateW / 2 + 12
    const arrowEndX = finalBananaX - bananaR - 10

    ctx.beginPath()
    ctx.moveTo(arrowStartX, monkeyY)
    ctx.lineTo(arrowEndX, monkeyY)
    ctx.strokeStyle = '#10B981'
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    ctx.stroke()
    ctx.setLineDash([])

    ctx.beginPath()
    ctx.moveTo(arrowEndX, monkeyY)
    ctx.lineTo(arrowEndX - 10, monkeyY - 5)
    ctx.lineTo(arrowEndX - 10, monkeyY + 5)
    ctx.closePath()
    ctx.fillStyle = '#10B981'
    ctx.fill()
  }

  // Monkey float offset
  const floatY = Math.sin(t * 2.2) * 5
  const monkeyDrawY = monkeyY + floatY

  // Banana float offset
  const bananaFloatY = Math.sin(t * 2.5 + 1.0) * 4
  const bananaDrawY = bananaY + bananaFloatY

  // Draw coins in transit
  drawCoin(ctx, monkeyX + monkeyR, gateCX - gateW / 2, monkeyY, t, step)

  // Draw gate
  drawGate(ctx, gateCX, H * 0.44, gateW, gateH, t, step, isLight)

  // Draw banana
  drawBanana(ctx, finalBananaX, bananaDrawY, bananaR, t, step, isLight)

  // Draw monkey
  drawMonkey(ctx, monkeyX, monkeyDrawY, monkeyR, t, step, isLight)

  // Speech bubble from monkey
  const bubbleLines = monkeyBubbleText(step)
  drawBubble(ctx, monkeyX + monkeyR, monkeyDrawY - monkeyR * 0.5, bubbleLines, isLight, 'left')
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function MonkeyAgent3DFlow() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const [currentStep, setCurrentStep] = useState(0)
  const [isPlaying, setIsPlaying] = useState(true)
  const [isLightCanvas, setIsLightCanvas] = useState(false)
  const currentStepRef = useRef(0)
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

      const dpr = Math.min(window.devicePixelRatio || 1, 2)
      const W = canvas.width / dpr
      const H = canvas.height / dpr

      ctx.save()
      drawScene(ctx, W, H, t, currentStepRef.current, isLightCanvas)
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
