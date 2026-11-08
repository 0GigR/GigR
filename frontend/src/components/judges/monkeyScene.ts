/**
 * monkeyScene.ts - canvas drawing for the x402 "Agent Kong" demonstration on /ea.
 *
 * Pure drawing code, no React. This file lays out the scene and draws the toll
 * gate, a 3D object of extruded boxes whose boom physically lifts when the
 * payment is verified, plus the coins and the speech bubble. The character and
 * the banana are drawn in monkeyFigure.ts.
 *
 * Step index (0-based) matches FLOW_STEPS in MonkeyAgent3DFlow:
 *   0 discovery, 1 paywall (402), 2 signing, 3 settlement,
 *   4 verification (gate opens), 5 brief delivered (monkey holds the banana).
 *
 * The page theme is monochrome, so outlines, panels and ground follow the
 * light / dark theme. The only chromatic accents are the natural ones (fur,
 * banana), the three gate states, and ONE purple (the headset and the tablet
 * screen) - a single flat shade, never a gradient.
 */

import {
  FIGURE_GROUND,
  advanceAnim,
  bananaBottom,
  blob,
  createSceneAnim,
  drawBanana,
  drawMonkey,
  rr,
  type HandInfo,
  type SceneAnim,
  type Vec,
} from './monkeyFigure'

export { advanceAnim, createSceneAnim }

const RED = '#DC2626'
const AMBER = '#D97706'
const GREEN = '#16A34A'

interface Palette {
  bg: string
  ground: string
  groundLine: string
  dots: string
  ink: string
  panel: string
  panelDark: string
  boxTop: string
  boxSide: string
  paper: string
  text: string
  muted: string
  shadow: string
}

function palette(isLight: boolean): Palette {
  return isLight
    ? {
        bg: '#FAFAFA',
        ground: '#F0F0F2',
        groundLine: '#D4D4D8',
        dots: 'rgba(0,0,0,0.055)',
        ink: '#2B1810',
        panel: '#FFFFFF',
        panelDark: '#E4E4E7',
        boxTop: '#F4F4F5',
        boxSide: '#C9C9CF',
        paper: '#FFFFFF',
        text: '#3F3F46',
        muted: '#71717A',
        shadow: 'rgba(0,0,0,0.13)',
      }
    : {
        bg: '#0A0A0A',
        ground: '#111113',
        groundLine: '#2A2A2E',
        dots: 'rgba(255,255,255,0.045)',
        ink: '#F4E7D6',
        panel: '#1C1C1F',
        panelDark: '#2A2A2E',
        boxTop: '#303035',
        boxSide: '#121214',
        paper: '#F4F4F5',
        text: '#D4D4D8',
        muted: '#8A8A93',
        shadow: 'rgba(0,0,0,0.55)',
      }
}

// ─── Gate ─────────────────────────────────────────────────────────────────────

function drawPadlock(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  open: boolean,
  ink: string,
) {
  const lw = Math.max(1.4, size * 0.09)
  ctx.save()
  ctx.lineCap = 'round'
  ctx.beginPath()
  if (open) {
    ctx.arc(x + size * 0.28, y - size * 0.06, size * 0.27, Math.PI, Math.PI * 2)
    ctx.lineTo(x + size * 0.55, y + size * 0.02)
  } else {
    ctx.arc(x, y, size * 0.27, Math.PI, Math.PI * 2)
    ctx.lineTo(x + size * 0.27, y + size * 0.06)
    ctx.moveTo(x - size * 0.27, y)
    ctx.lineTo(x - size * 0.27, y + size * 0.06)
  }
  ctx.strokeStyle = ink
  ctx.lineWidth = lw * 1.8
  ctx.stroke()
  rr(ctx, x - size * 0.4, y, size * 0.8, size * 0.62, size * 0.12)
  ctx.fillStyle = color
  ctx.fill()
  ctx.strokeStyle = ink
  ctx.lineWidth = lw
  ctx.stroke()
  blob(ctx, x, y + size * 0.27, size * 0.07, size * 0.07, '#FFFFFF')
  ctx.restore()
}

/** The gate is a real extruded object: front faces sit on z = 0, depth runs away up and to the left. */
const OBLIQUE_X = 0.46
const OBLIQUE_Y = 0.36
const PERSPECTIVE = 0.0016

interface GateView {
  cx: number
  ground: number
  h: number
}

function project(v: GateView, x: number, y: number, z: number): Vec {
  const k = 1 - z * PERSPECTIVE
  return [v.cx + x * k - z * OBLIQUE_X, v.ground - v.h - (y - v.h) * k - z * OBLIQUE_Y]
}

function gateDepth(w: number): number {
  return Math.max(22, Math.min(w * 0.46, 44))
}

function fillFace(ctx: CanvasRenderingContext2D, face: Vec[], color: string, ink: string, lw: number) {
  ctx.beginPath()
  face.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
  ctx.strokeStyle = ink
  ctx.lineWidth = lw
  ctx.stroke()
}

/** Mixes a #rrggbb colour toward black (negative) or white (positive). */
function tint(hex: string, amount: number): string {
  const target = amount < 0 ? 0 : 255
  const f = Math.abs(amount)
  const channel = (i: number) =>
    Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - f) + target * f)
  return `rgb(${channel(1)},${channel(3)},${channel(5)})`
}

interface Faces {
  front: string
  top: string
  side: string
}

/**
 * Extrudes a convex outline (x right, y up) from z0 back to z1. Only the faces
 * turned toward the camera are drawn, then the front cap on top of them, and
 * the front cap's corners are returned so callers can decorate it. `flutes`
 * rules the side faces with the ribs you see on a cut edge of corrugated board.
 */
function prism(
  ctx: CanvasRenderingContext2D,
  v: GateView,
  outline: Vec[],
  z0: number,
  z1: number,
  faces: Faces,
  ink: string,
  lw: number,
  flutes = 0,
): Vec[] {
  let area = 0
  outline.forEach(([ax, ay], i) => {
    const [bx, by] = outline[(i + 1) % outline.length]
    area += ax * by - bx * ay
  })
  const poly = area > 0 ? outline : [...outline].reverse()

  poly.forEach((a, i) => {
    const b = poly[(i + 1) % poly.length]
    const quad = [
      project(v, a[0], a[1], z0),
      project(v, b[0], b[1], z0),
      project(v, b[0], b[1], z1),
      project(v, a[0], a[1], z1),
    ]
    let shoelace = 0
    quad.forEach(([qx, qy], j) => {
      const [nx, ny] = quad[(j + 1) % 4]
      shoelace += qx * ny - nx * qy
    })
    if (shoelace <= 0) return
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const facesUp = -(b[0] - a[0]) / len > 0.4
    fillFace(ctx, quad, facesUp ? faces.top : faces.side, ink, lw)
    if (flutes > 0) {
      ctx.strokeStyle = ink
      ctx.globalAlpha = 0.28
      ctx.lineWidth = 0.8
      for (let n = 1; n <= flutes; n++) {
        const z = z0 + ((z1 - z0) * n) / (flutes + 1)
        const p = project(v, a[0], a[1], z)
        const q = project(v, b[0], b[1], z)
        ctx.beginPath()
        ctx.moveTo(p[0], p[1])
        ctx.lineTo(q[0], q[1])
        ctx.stroke()
      }
      ctx.globalAlpha = 1
    }
  })

  const front = poly.map(([x, y]) => project(v, x, y, z0))
  fillFace(ctx, front, faces.front, ink, lw)
  return front
}

function box(x0: number, y0: number, x1: number, y1: number): Vec[] {
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ]
}

function drawGate(
  ctx: CanvasRenderingContext2D,
  cx: number,
  gy: number,
  w: number,
  h: number,
  t: number,
  step: number,
  open: number,
  p: Palette,
  stateColor: string,
) {
  const lw = 1.6
  const ink = p.ink
  const label = step <= 1 ? 'HTTP 402' : step === 2 ? 'AWAITING TX' : step === 3 ? 'SETTLING' : 'UNLOCKED'
  const pw = Math.max(14, w * 0.2)
  const depth = gateDepth(w)
  const ribs = Math.round(depth / 4.5)
  const left = -w / 2
  const right = w / 2 - pw
  const slab = 5
  const beamBottom = h - 22
  // The front of the gate stands on the floor, so its back meets the ground line
  const view: GateView = { cx, ground: gy + 6, h }
  const at = (x: number, y: number, z = 0) => project(view, x, y, z)
  const board: Faces = { front: p.panel, top: p.boxTop, side: p.boxSide }

  ctx.lineCap = 'butt'
  ctx.lineJoin = 'miter'

  // Shadow thrown across the floor, to the right of the slab
  const shade = [
    at(left - 6, 0, -2),
    at(w / 2 + 6, 0, -2),
    at(w / 2 + 30, 0, depth * 0.5),
    at(w / 2 + 10, 0, depth + 4),
  ]
  ctx.beginPath()
  shade.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
  ctx.closePath()
  ctx.fillStyle = p.shadow
  ctx.fill()

  prism(ctx, view, box(left - 6, 0, w / 2 + 6, slab), -3, depth + 4, { front: p.panelDark, top: p.panelDark, side: p.boxSide }, ink, lw)

  // The right pillar is further from the camera, so it goes down first
  const pulse = 0.55 + 0.45 * Math.sin(t * (step === 2 || step === 3 ? 9 : 3))
  for (const px of [right, left]) {
    prism(ctx, view, box(px, slab, px + pw, beamBottom + 2), 0, depth, board, ink, lw, ribs)
    ctx.strokeStyle = p.groundLine
    ctx.lineWidth = 1
    for (let i = 1; i <= 3; i++) {
      const a = at(px + 3, slab + i * (h * 0.13))
      const b = at(px + pw - 3, slab + i * (h * 0.13))
      ctx.beginPath()
      ctx.moveTo(a[0], a[1])
      ctx.lineTo(b[0], b[1])
      ctx.stroke()
    }
    const led = at(px + pw / 2, beamBottom - 10)
    blob(ctx, led[0], led[1], 4.2, 4.2, p.panelDark, ink, 1)
    ctx.save()
    ctx.globalAlpha = pulse
    blob(ctx, led[0], led[1], 2.8, 2.8, stateColor)
    ctx.restore()
  }

  // Left pillar reader screen
  const screen = at(left + 3, beamBottom - 18)
  rr(ctx, screen[0], screen[1], pw - 6, 20, 1)
  ctx.fillStyle = '#0B0B0D'
  ctx.fill()
  ctx.strokeStyle = ink
  ctx.lineWidth = 1.2
  ctx.stroke()
  ctx.fillStyle = stateColor
  ctx.font = `700 ${Math.max(7, pw * 0.36)}px ui-monospace, monospace`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(step <= 1 ? '402' : step <= 3 ? '...' : 'OK', screen[0] + (pw - 6) / 2, screen[1] + 10.5)
  ctx.textBaseline = 'alphabetic'

  // Catch the boom rests in
  const pivotY = h * 0.38
  prism(ctx, view, box(right + 1, pivotY - 8, right + pw - 1, pivotY - 3), -8, 0, { front: p.panelDark, top: p.boxTop, side: p.boxSide }, ink, 1)

  // Boom: mounted on the front of the left pillar, it swings up under the canopy
  const pivotX = left + pw / 2
  const L = right + pw - 3 - pivotX
  const ah = Math.max(8, h * 0.075)
  const angle = open * 1.32
  const ca = Math.cos(angle)
  const sa = Math.sin(angle)
  const onBoom = (lx: number, ly: number): Vec => [pivotX + lx * ca - ly * sa, pivotY + lx * sa + ly * ca]
  const zFront = -8
  const boomFront = prism(
    ctx,
    view,
    [onBoom(-ah * 0.8, -ah / 2), onBoom(L, -ah / 2), onBoom(L, ah / 2), onBoom(-ah * 0.8, ah / 2)],
    zFront,
    -3,
    { front: p.paper, top: p.boxTop, side: p.boxSide },
    ink,
    lw,
  )
  ctx.save()
  ctx.beginPath()
  boomFront.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
  ctx.closePath()
  ctx.clip()
  ctx.fillStyle = stateColor
  const stripe = ah * 1.5
  for (let sx = ah; sx < L + ah; sx += stripe * 2) {
    const q = [
      onBoom(sx, -ah / 2),
      onBoom(sx + stripe, -ah / 2),
      onBoom(sx + stripe + ah, ah / 2),
      onBoom(sx + ah, ah / 2),
    ].map(([x, y]) => project(view, x, y, zFront))
    ctx.beginPath()
    q.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
    ctx.closePath()
    ctx.fill()
  }
  ctx.restore()
  fillFace(ctx, boomFront, 'rgba(0,0,0,0)', ink, lw)

  // Padlock hangs from the boom, stays upright, pops open then fades
  if (open < 0.9) {
    const hang = onBoom(L * 0.5, -ah / 2 - 1)
    const lockAt = project(view, hang[0], hang[1], zFront)
    ctx.save()
    ctx.translate(lockAt[0], lockAt[1])
    ctx.globalAlpha = 1 - open
    ctx.rotate(step <= 1 ? Math.sin(t * 14) * 0.08 * (step === 1 ? 1 : 0) : 0)
    drawPadlock(ctx, 0, 1, Math.max(12, ah * 1.7), stateColor, step >= 3, ink)
    ctx.restore()
  }

  // Axle: a stubby eight-sided peg through the boom
  const peg: Vec[] = []
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.39
    peg.push([pivotX + Math.cos(a) * ah * 0.62, pivotY + Math.sin(a) * ah * 0.62])
  }
  prism(ctx, view, peg, zFront - 6, zFront, board, ink, lw)

  // Canopy across the top. It overhangs the front, so the raised boom tucks behind it
  const canopyFront = zFront - 5
  prism(
    ctx,
    view,
    box(left - 6, beamBottom, w / 2 + 6, h),
    canopyFront,
    depth + 4,
    { front: stateColor, top: tint(stateColor, 0.32), side: tint(stateColor, -0.32) },
    ink,
    lw,
    ribs,
  )
  const fs = Math.min(10.5, (w + 2) / (label.length * 0.64))
  ctx.font = `700 ${fs}px ui-monospace, monospace`
  ctx.fillStyle = '#FFFFFF'
  ctx.textAlign = 'center'
  const labelAt = at(0, beamBottom + 7.5, canopyFront)
  ctx.fillText(label, labelAt[0], labelAt[1])

  // Success badge in the open passage
  if (open > 0.55) {
    const br = Math.min(w * 0.2, 15)
    const [bx, by] = at(0, h * 0.24)
    ctx.save()
    ctx.globalAlpha = Math.min(1, (open - 0.55) / 0.35)
    blob(ctx, bx, by, br, br, GREEN, ink, lw)
    ctx.beginPath()
    ctx.moveTo(bx - br * 0.45, by + br * 0.02)
    ctx.lineTo(bx - br * 0.1, by + br * 0.38)
    ctx.lineTo(bx + br * 0.5, by - br * 0.32)
    ctx.strokeStyle = '#FFFFFF'
    ctx.lineWidth = Math.max(2, br * 0.2)
    ctx.stroke()
    ctx.restore()
  }
}

// ─── Coins, bubble, text ──────────────────────────────────────────────────────

function drawCoins(
  ctx: CanvasRenderingContext2D,
  fromX: number,
  toX: number,
  baseY: number,
  t: number,
  step: number,
  p: Palette,
) {
  if (step < 2 || step > 3) return
  const count = step === 3 ? 3 : 2
  for (let i = 0; i < count; i++) {
    const progress = (((t * 0.6 + i / count) % 1) + 1) % 1
    const x = fromX + (toX - fromX) * progress
    const y = baseY - 30 * Math.sin(progress * Math.PI)
    const sc = 0.72 + 0.28 * Math.sin(progress * Math.PI)
    const squash = Math.abs(Math.cos(t * 6 + i * 1.7)) * 0.65 + 0.35
    ctx.save()
    ctx.translate(x, y)
    ctx.scale(sc, sc)
    blob(ctx, 0, 0, 11 * squash, 11, '#F5B800', p.ink, 1.6)
    blob(ctx, 0, 0, 7 * squash, 7, 'rgba(255,255,255,0.0)', 'rgba(120,70,0,0.45)', 1)
    if (squash > 0.55) {
      ctx.font = '700 10px -apple-system, sans-serif'
      ctx.fillStyle = '#7A4A00'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('$', 0, 0.5)
      ctx.textBaseline = 'alphabetic'
    }
    ctx.restore()
  }
}

function bubbleText(step: number): string[] {
  switch (step) {
    case 0:
      return ['GET /banana-brief-94', 'Looking for work...']
    case 1:
      return ['HTTP 402 Received!', 'Need 0.01 USDC']
    case 2:
      return ['Signing tx...', 'Ed25519 key ready']
    case 3:
      return ['Tx broadcast!', 'Waiting 400ms...']
    case 4:
      return ['Signature verified!', 'Retrying GET...']
    default:
      return ['Got the brief!', 'Starting gig now']
  }
}

const BUBBLE_FONT = '700 12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif'
const BUBBLE_PAD_X = 13

function bubbleWidth(ctx: CanvasRenderingContext2D, lines: string[]): number {
  ctx.font = BUBBLE_FONT
  return Math.ceil(Math.max(...lines.map((l) => ctx.measureText(l).width))) + BUBBLE_PAD_X * 2
}

/**
 * Speech bubble: a hand-cut angular outline, white inside, black line, no
 * shadow or fill effects. Its size comes from the measured text, and the tail
 * is one spike in the same closed path so the line never breaks.
 */
function drawBubble(
  ctx: CanvasRenderingContext2D,
  W: number,
  left: number,
  bottom: number,
  lines: string[],
  t: number,
) {
  const padY = 10
  const lineH = 15
  const padX = BUBBLE_PAD_X
  const bw = bubbleWidth(ctx, lines)
  const bh = lines.length * lineH + padY * 2
  const bob = Math.sin(t * 2.1) * 1.2
  const x0 = Math.max(6, Math.min(W - bw - 6, left))
  const y1 = bottom + bob
  const y0 = y1 - bh
  const x1 = x0 + bw
  const cut = Math.min(9, bh * 0.24)

  // Corners are chamfered unevenly so the panel looks cut by hand
  const outline: [number, number][] = [
    [x0 + cut + 3, y0 - 2],
    [x1 - cut - 5, y0 + 1],
    [x1 + 2, y0 + cut],
    [x1 - 1, y1 - cut - 2],
    [x1 - cut - 2, y1 + 2],
    [x0 + 25, y1],
    [x0 - 13, y1 + 15],
    [x0 + 9, y1 - 1],
    [x0 + 2, y1 - 2],
    [x0 - 3, y1 - cut - 3],
    [x0 + 1, y0 + cut + 2],
  ]

  ctx.save()
  ctx.lineJoin = 'round'
  ctx.beginPath()
  outline.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
  ctx.closePath()
  ctx.fillStyle = '#FFFFFF'
  ctx.fill()
  ctx.strokeStyle = '#000000'
  ctx.lineWidth = 2.8
  ctx.stroke()

  ctx.font = BUBBLE_FONT
  ctx.fillStyle = '#000000'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  lines.forEach((line, i) => {
    ctx.fillText(line, x0 + padX, y0 + padY + lineH * (i + 0.5))
  })
  ctx.textBaseline = 'alphabetic'
  ctx.restore()
}

// ─── Scene ────────────────────────────────────────────────────────────────────

export function drawScene(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  t: number,
  step: number,
  isLight: boolean,
  anim: SceneAnim,
) {
  const p = palette(isLight)

  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = p.bg
  ctx.fillRect(0, 0, W, H)

  // Dot grid
  ctx.fillStyle = p.dots
  for (let gx = 0; gx < W; gx += 28) {
    for (let gy2 = 0; gy2 < H; gy2 += 28) {
      ctx.beginPath()
      ctx.arc(gx, gy2, 1, 0, Math.PI * 2)
      ctx.fill()
    }
  }

  // Layout
  const groundY = H * 0.8
  const r = Math.min(H * 0.2, W * 0.085, 50)
  const mx = Math.max(r * 2.5, W * 0.12)
  const my = groundY - r * FIGURE_GROUND
  const gateW = Math.min(W * 0.17, 96)
  const gateH = H * 0.44
  // Centred on the stage, under the HTML title. The depth hangs off behind it.
  const gcx = W / 2
  const s = r * 0.95
  const heldSize = r * 0.62
  const restX = Math.min(W - s * 1.5, W * 0.86)
  const restRot = -0.16
  const restY = groundY - bananaBottom(s) + 2
  const heldRot = -Math.PI / 2 + 0.3

  const stateColor = step <= 1 ? RED : step <= 3 ? AMBER : GREEN

  // Ground
  ctx.fillStyle = p.ground
  ctx.fillRect(0, groundY, W, H - groundY)
  ctx.fillStyle = p.groundLine
  ctx.fillRect(0, groundY, W, 1.5)

  // Gate
  drawGate(ctx, gcx, groundY, gateW, gateH, t, step, anim.gate, p, stateColor)

  // Resting banana (leaves the ground when delivered) and the data card it leaves behind
  const e = anim.banana
  const bob = Math.sin(t * 2.4) * 2.5
  if (e < 0.98) {
    blob(ctx, restX, groundY + 2, s * 1.05, 5, p.shadow)
  }
  if (step <= 3) {
    const shake = step <= 1 ? 0 : Math.sin(t * 20) * 0.4
    drawPadlock(ctx, restX + shake, restY - s * 1.05 + bob * 0.4, s * 0.55, RED, false, p.ink)
  }

  if (e > 0.02) {
    const docW = Math.min(s * 2.1, 118)
    const docH = s * 1.35
    const dx = restX - docW / 2
    const dy = groundY - docH - 8 - (1 - e) * 10
    ctx.save()
    ctx.globalAlpha = Math.min(1, e * 1.3)
    rr(ctx, dx, dy, docW, docH, 7)
    ctx.fillStyle = p.panel
    ctx.fill()
    ctx.strokeStyle = p.ink
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.fillStyle = GREEN
    rr(ctx, dx, dy, docW, 7, 3)
    ctx.fill()
    ctx.fillStyle = p.text
    ctx.font = `700 ${Math.max(8, Math.min(9.5, docW / 12))}px ui-monospace, monospace`
    ctx.textAlign = 'left'
    ;['job_id: B-94', 'lat: 6.5244', 'lng: 3.3792', 'USDC: 45.00'].forEach((line, i) => {
      ctx.fillText(line, dx + 8, dy + 20 + i * (docH - 26) / 3.4)
    })
    ctx.restore()
  }

  // On the ground the banana lies behind everything and hops when the gate opens
  if (e < 0.02) {
    const hop = step === 4 ? Math.abs(Math.sin(t * 5)) * 6 : 0
    drawBanana(ctx, restX, restY - hop, s, restRot)
  }

  // Once it arrives it is drawn between the arm and the fingers, so the hand closes on it
  const inHand = e >= 0.92
  const hand = drawMonkey(ctx, mx, my, r, t, step, p, anim, stateColor, (h: HandInfo) => {
    if (inHand) drawBanana(ctx, h.palmX, h.palmY, heldSize, heldRot)
  })

  // In flight it passes in front of the monkey on an arc
  if (e >= 0.02 && !inHand) {
    const k = Math.min(1, e / 0.92)
    const size = s + (heldSize - s) * k
    const bx = restX + (hand.palmX - restX) * k
    const by = restY + (hand.palmY - restY) * k - Math.sin(k * Math.PI) * r * 0.9
    drawBanana(ctx, bx, by, size, restRot + (heldRot - restRot) * k)
  }

  // Coins
  drawCoins(ctx, mx + r * 1.3, gcx - gateW / 2, my + r * 0.9, t, step, p)

  // Speech bubble sits beside the face, under the HTML callouts; if the gate
  // would be in the way it moves up over the barrier instead.
  const lines = bubbleText(step)
  const bubbleLeft = mx + r * 1.32
  const clearsGate =
    bubbleLeft + bubbleWidth(ctx, lines) < gcx - gateW / 2 - 6 - gateDepth(gateW) * OBLIQUE_X
  drawBubble(ctx, W, bubbleLeft, clearsGate ? my - r * 0.24 : Math.min(my - r * 0.24, groundY - gateH - 18), lines, t)

  // Captions under the ground line
  ctx.textAlign = 'center'
  const capY = groundY + 22
  const subY = groundY + 37
  ctx.font = '700 12px -apple-system, sans-serif'
  ctx.fillStyle = p.text
  ctx.fillText('Agent Kong', mx, capY)
  ctx.fillText('Banana Brief', restX, capY)
  ctx.font = '11px -apple-system, sans-serif'
  ctx.fillStyle = p.muted
  ctx.fillText('AI Worker', mx, subY)
  ctx.fillText('Encrypted Job Spec', restX, subY)

  ctx.font = '700 12px -apple-system, sans-serif'
  ctx.fillStyle = step >= 4 ? GREEN : RED
  ctx.fillText(step >= 4 ? 'Gate Open' : 'Locked', gcx, capY)
  ctx.font = '700 10.5px ui-monospace, monospace'
  ctx.fillStyle = p.muted
  ctx.fillText('0.01 USDC on Solana', gcx, subY)
}
