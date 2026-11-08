/**
 * monkeyFigure.ts - the character and the banana for the x402 scene on /ea.
 *
 * The monkey is a cardboard puppet: every part is a flat, hard-angled piece cut
 * from one colour, and the limbs are separate plates joined by brass split pins.
 * There are no gradients and no curves in the silhouettes (the headset is the
 * one exception, it is the only manufactured thing he wears).
 *
 * Depth comes from how paper really stacks:
 *   - draw order: tail, far arm, torso, far leg, near leg, head, near arm
 *   - each piece throws a short hard shadow onto whatever is underneath it
 *   - each cut edge catches or loses the light, depending on which way it faces
 *   - far limbs are cut from a darker sheet
 *
 * Coordinates inside the figure are in units of r, relative to the head center.
 */

export const PURPLE = '#7C3AED'

const PURPLE_DARK = '#5B21B6'
const PURPLE_LIGHT = '#A78BFA'
const FUR = '#A9682B'
const FUR_FAR = '#87501F'
const CREAM = '#F3DBA6'
const CREAM_FAR = '#DDBE86'
const PINK = '#E99A93'
const MOUTH = '#5A1E1E'
const BRASS = '#C79A3B'
const BRASS_LIGHT = '#EBCB78'
/** The line around each piece. Constant, because the pieces do not change with the page theme. */
const INK = '#3A2110'

/** Shadow falls toward the lower right. */
const LX = 0.55
const LY = 0.83

/** Distance from the head center down to the ground, in units of r. */
export const FIGURE_GROUND = 2.45

export type Vec = [number, number]
type Poly = Vec[]
type HandPose = 'open' | 'fist' | 'point' | 'grip'

export interface FigureColors {
  shadow: string
  panelDark: string
}

export interface HandInfo {
  x: number
  y: number
  ang: number
  palmX: number
  palmY: number
}

// ─── Animation state (smoothed between steps) ─────────────────────────────────

export interface SceneAnim {
  /** 0 = barrier down, 1 = barrier fully raised */
  gate: number
  /** 0 = banana on the ground, 1 = banana in the monkey's hand */
  banana: number
  /** hand targets in units of r, relative to the head center */
  near: Vec
  far: Vec
  /** 1 = three quarter view toward the gate, 0 = closer to facing the viewer */
  turn: number
}

interface Pose {
  near: Vec
  far: Vec
  nearHand: HandPose
  farHand: HandPose
  turn: number
}

/** Far hand rests here, tucked behind the seat. */
const GROUND_HAND = FIGURE_GROUND - 0.42

const POSES: readonly Pose[] = [
  // discovery: points at the gate, far hand planted behind
  { near: [1.5, 0.78], far: [-0.62, GROUND_HAND], nearHand: 'point', farHand: 'fist', turn: 1 },
  // 402: both hands up in alarm, looking at the viewer
  { near: [1.3, 0.62], far: [-1.46, 0.14], nearHand: 'open', farHand: 'open', turn: 0.35 },
  // signing: holds the tablet on the knee
  { near: [0.92, 1.2], far: [0.5, 1.26], nearHand: 'open', farHand: 'open', turn: 1 },
  // settling: drumming fingers on the knee
  { near: [0.5, 1.36], far: [-0.62, GROUND_HAND], nearHand: 'open', farHand: 'fist', turn: 1 },
  // verified: reaches for the gate, far fist up
  { near: [1.5, 0.98], far: [-1.44, 0.08], nearHand: 'open', farHand: 'fist', turn: 1 },
  // delivered: holds the banana up, far fist up
  { near: [1.32, 1.16], far: [-1.44, 0.04], nearHand: 'grip', farHand: 'fist', turn: 0.75 },
]

function poseFor(step: number): Pose {
  return POSES[step] ?? POSES[POSES.length - 1]
}

export function createSceneAnim(): SceneAnim {
  const pose = poseFor(0)
  return { gate: 0, banana: 0, near: [...pose.near], far: [...pose.far], turn: pose.turn }
}

export function advanceAnim(a: SceneAnim, step: number, dt: number) {
  const k = (rate: number) => Math.min(1, dt * rate)
  a.gate += ((step >= 4 ? 1 : 0) - a.gate) * k(3.5)
  a.banana += ((step >= 5 ? 1 : 0) - a.banana) * k(2.4)
  const pose = poseFor(step)
  for (let i = 0; i < 2; i++) {
    a.near[i] += (pose.near[i] - a.near[i]) * k(7)
    a.far[i] += (pose.far[i] - a.far[i]) * k(7)
  }
  a.turn += (pose.turn - a.turn) * k(6)
}

// ─── Primitives ───────────────────────────────────────────────────────────────

export function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rad = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.lineTo(x + w - rad, y)
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad)
  ctx.lineTo(x + w, y + h - rad)
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h)
  ctx.lineTo(x + rad, y + h)
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad)
  ctx.lineTo(x, y + rad)
  ctx.quadraticCurveTo(x, y, x + rad, y)
  ctx.closePath()
}

export function blob(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  fill: string,
  ink?: string,
  lw = 2,
  rot = 0,
) {
  ctx.beginPath()
  ctx.ellipse(x, y, Math.max(rx, 0.01), Math.max(ry, 0.01), rot, 0, Math.PI * 2)
  ctx.fillStyle = fill
  ctx.fill()
  if (ink) {
    ctx.lineWidth = lw
    ctx.strokeStyle = ink
    ctx.stroke()
  }
}

function trace(ctx: CanvasRenderingContext2D, poly: Poly) {
  ctx.beginPath()
  poly.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
  ctx.closePath()
}

function polyline(ctx: CanvasRenderingContext2D, line: Poly, color: string, width: number) {
  ctx.beginPath()
  line.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
  ctx.strokeStyle = color
  ctx.lineWidth = width
  ctx.stroke()
}

/**
 * One cut piece of card. It throws a short shadow on what is below it, is filled
 * with a single colour, and each edge is lit or shaded by the way it faces.
 * `rot` is the rotation the caller has applied to the canvas, so the light stays
 * in the same place when a piece is turned.
 */
function piece(
  ctx: CanvasRenderingContext2D,
  poly: Poly,
  fill: string,
  lw: number,
  lift: number,
  rot = 0,
) {
  const lx = LX * Math.cos(rot) + LY * Math.sin(rot)
  const ly = -LX * Math.sin(rot) + LY * Math.cos(rot)
  ctx.save()
  ctx.lineJoin = 'miter'
  ctx.miterLimit = 3
  ctx.lineCap = 'butt'
  if (lift > 0) {
    for (const [k, alpha] of [
      [1.5, 0.13],
      [0.85, 0.26],
    ] as const) {
      ctx.save()
      ctx.translate(lx * lift * k, ly * lift * k)
      trace(ctx, poly)
      ctx.fillStyle = `rgba(40,18,4,${alpha})`
      ctx.fill()
      ctx.restore()
    }
  }
  trace(ctx, poly)
  ctx.fillStyle = fill
  ctx.fill()
  if (lw > 0) {
    cutEdges(ctx, poly, lw, lx, ly)
    trace(ctx, poly)
    ctx.strokeStyle = INK
    ctx.lineWidth = lw
    ctx.stroke()
  }
  ctx.restore()
}

/** The thickness of the board: a lit line on edges facing the light, a dark one on the others. */
function cutEdges(ctx: CanvasRenderingContext2D, poly: Poly, lw: number, lx: number, ly: number) {
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]
    const [bx, by] = poly[(i + 1) % poly.length]
    area += ax * by - bx * ay
  }
  const winding = area > 0 ? 1 : -1
  ctx.lineWidth = lw * 1.1
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i]
    const [bx, by] = poly[(i + 1) % poly.length]
    const len = Math.hypot(bx - ax, by - ay)
    if (len < lw * 3) continue
    const nx = ((by - ay) / len) * winding
    const ny = (-(bx - ax) / len) * winding
    const toLight = -(nx * lx + ny * ly)
    if (Math.abs(toLight) < 0.3) continue
    const inset = lw * 1.05
    const tx = ((bx - ax) / len) * lw * 1.2
    const ty = ((by - ay) / len) * lw * 1.2
    ctx.beginPath()
    ctx.moveTo(ax - nx * inset + tx, ay - ny * inset + ty)
    ctx.lineTo(bx - nx * inset - tx, by - ny * inset - ty)
    ctx.strokeStyle = toLight > 0 ? 'rgba(255,244,220,0.42)' : 'rgba(45,20,4,0.3)'
    ctx.stroke()
  }
}

/** A brass split pin, the fastener at each joint. */
function pin(ctx: CanvasRenderingContext2D, x: number, y: number, R: number, slot: number) {
  ctx.save()
  blob(ctx, x + R * 0.28, y + R * 0.42, R, R, 'rgba(40,18,4,0.32)')
  blob(ctx, x, y, R, R, BRASS, INK, Math.max(0.8, R * 0.2))
  ctx.beginPath()
  ctx.arc(x, y, R * 0.66, Math.PI * 1.05, Math.PI * 1.6)
  ctx.strokeStyle = BRASS_LIGHT
  ctx.lineWidth = R * 0.26
  ctx.lineCap = 'butt'
  ctx.stroke()
  const dx = Math.cos(slot) * R * 0.66
  const dy = Math.sin(slot) * R * 0.66
  ctx.beginPath()
  ctx.moveTo(x - dx, y - dy)
  ctx.lineTo(x + dx, y + dy)
  ctx.strokeStyle = INK
  ctx.lineWidth = Math.max(0.8, R * 0.3)
  ctx.stroke()
  ctx.restore()
}

/** Polygon scaled by r and moved to an origin. */
function place(points: readonly (readonly [number, number])[], r: number, ox = 0, oy = 0): Poly {
  return points.map(([x, y]) => [ox + x * r, oy + y * r])
}

/** A regular polygon with a little unevenness, so no cut looks machine made. */
function ngon(cx: number, cy: number, rx: number, ry: number, sides: number, turn = 0): Poly {
  const out: Poly = []
  for (let i = 0; i < sides; i++) {
    const a = turn + (i / sides) * Math.PI * 2
    const wobble = 1 + 0.05 * Math.sin(i * 2.7 + sides)
    out.push([cx + Math.cos(a) * rx * wobble, cy + Math.sin(a) * ry * wobble])
  }
  return out
}

/** A limb plate from one joint to the next: faceted ends, widest around the middle. */
function plate(a: Vec, b: Vec, ha: number, hm: number, hb: number): Poly {
  const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 0.001
  const c = (b[0] - a[0]) / L
  const s = (b[1] - a[1]) / L
  const local: Poly = [
    [-ha * 0.95, -ha * 0.42],
    [-ha * 0.42, -ha],
    [L * 0.46, -hm],
    [L + hb * 0.42, -hb],
    [L + hb * 0.95, -hb * 0.42],
    [L + hb * 0.95, hb * 0.42],
    [L + hb * 0.42, hb],
    [L * 0.54, hm],
    [-ha * 0.42, ha],
    [-ha * 0.95, ha * 0.42],
  ]
  return local.map(([u, v]) => [a[0] + u * c - v * s, a[1] + u * s + v * c])
}

/** A strip of card that follows a jointed centerline and keeps its corners sharp. */
function strip(points: Poly, widths: number[]): Poly {
  const left: Poly = []
  const right: Poly = []
  const n = points.length
  for (let i = 0; i < n; i++) {
    const p = points[i]
    const prev = points[Math.max(0, i - 1)]
    const next = points[Math.min(n - 1, i + 1)]
    const d1 = Math.hypot(p[0] - prev[0], p[1] - prev[1]) || 1
    const d2 = Math.hypot(next[0] - p[0], next[1] - p[1]) || 1
    const ax = i === 0 ? (next[0] - p[0]) / d2 : (p[0] - prev[0]) / d1
    const ay = i === 0 ? (next[1] - p[1]) / d2 : (p[1] - prev[1]) / d1
    const bx = i === n - 1 ? ax : (next[0] - p[0]) / d2
    const by = i === n - 1 ? ay : (next[1] - p[1]) / d2
    let tx = ax + bx
    let ty = ay + by
    const tl = Math.hypot(tx, ty) || 1
    tx /= tl
    ty /= tl
    const mitre = Math.min(1.35, 1 / Math.max(0.5, tx * ax + ty * ay))
    const h = (widths[i] / 2) * mitre
    left.push([p[0] - ty * h, p[1] + tx * h])
    right.push([p[0] + ty * h, p[1] - tx * h])
  }
  return [...left, ...right.reverse()]
}

function rotateAbout(p: Vec, o: Vec, a: number): Vec {
  const c = Math.cos(a)
  const s = Math.sin(a)
  const dx = p[0] - o[0]
  const dy = p[1] - o[1]
  return [o[0] + dx * c - dy * s, o[1] + dx * s + dy * c]
}

function solveArm(s: Vec, target: Vec, l1: number, l2: number, side: number): { e: Vec; w: Vec } {
  let dx = target[0] - s[0]
  let dy = target[1] - s[1]
  let d = Math.hypot(dx, dy) || 0.001
  const maxD = (l1 + l2) * 0.985
  let w = target
  if (d > maxD) {
    w = [s[0] + (dx * maxD) / d, s[1] + (dy * maxD) / d]
    dx = w[0] - s[0]
    dy = w[1] - s[1]
    d = maxD
  }
  const a = (l1 * l1 - l2 * l2 + d * d) / (2 * d)
  const h = Math.sqrt(Math.max(0, l1 * l1 - a * a))
  const ux = dx / d
  const uy = dy / d
  const c1: Vec = [s[0] + ux * a - uy * h, s[1] + uy * a + ux * h]
  const c2: Vec = [s[0] + ux * a + uy * h, s[1] + uy * a - ux * h]
  // Elbows drop, and swing a little to the outside of the body
  const score = (c: Vec) => c[1] - s[1] + side * (c[0] - s[0]) * 0.25
  return { e: score(c1) >= score(c2) ? c1 : c2, w }
}

// ─── Hands and feet ───────────────────────────────────────────────────────────

/** Hand outlines along the forearm (u) and across it (v, thumb side positive). */
const HAND_OPEN: Poly = [
  [-0.09, -0.1],
  [0.05, -0.14],
  [0.2, -0.14],
  [0.34, -0.15],
  [0.37, -0.09],
  [0.22, -0.055],
  [0.39, -0.045],
  [0.4, 0.02],
  [0.23, 0.035],
  [0.36, 0.06],
  [0.35, 0.13],
  [0.19, 0.125],
  [0.16, 0.17],
  [0.2, 0.27],
  [0.12, 0.29],
  [0.04, 0.16],
  [-0.09, 0.1],
]

const HAND_FIST: Poly = [
  [-0.09, -0.1],
  [0.05, -0.15],
  [0.18, -0.14],
  [0.24, -0.07],
  [0.25, 0.05],
  [0.19, 0.14],
  [0.04, 0.16],
  [-0.09, 0.1],
]

const HAND_POINT: Poly = [
  [-0.09, -0.1],
  [0.05, -0.15],
  [0.2, -0.14],
  [0.5, -0.12],
  [0.53, -0.06],
  [0.5, -0.01],
  [0.24, 0],
  [0.25, 0.06],
  [0.19, 0.14],
  [0.04, 0.16],
  [-0.09, 0.1],
]

function drawHand(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  ang: number,
  r: number,
  lw: number,
  pose: HandPose,
) {
  const c = Math.cos(ang)
  const s = Math.sin(ang)
  const thumb = c < 0 ? -1 : 1
  const map = (points: Poly): Poly =>
    points.map(([u, v]) => {
      const flip = -v * thumb
      return [x + (u * c - flip * s) * r, y + (u * s + flip * c) * r]
    })
  const outline = pose === 'open' ? HAND_OPEN : pose === 'point' ? HAND_POINT : HAND_FIST
  piece(ctx, map(outline), CREAM, lw, r * 0.04)
  if (pose === 'open') return
  // Knuckles and a thumb folded across them
  const knuckles: Poly[] = [
    [
      [0.24, -0.04],
      [0.13, -0.03],
    ],
    [
      [0.245, 0.03],
      [0.13, 0.04],
    ],
  ]
  for (const line of pose === 'point' ? knuckles.slice(1) : knuckles) {
    polyline(ctx, map(line), INK, lw * 0.75)
  }
  piece(
    ctx,
    map([
      [0.0, 0.08],
      [0.14, 0.06],
      [0.19, 0.11],
      [0.08, 0.18],
      [0.0, 0.16],
    ]),
    CREAM,
    lw * 0.8,
    0,
  )
}

function drawFoot(ctx: CanvasRenderingContext2D, ankle: Vec, r: number, lw: number, far: boolean) {
  const outline = place(
    [
      [-0.16, 0.08],
      [-0.1, -0.1],
      [0.14, -0.14],
      [0.36, -0.08],
      [0.46, 0.03],
      [0.42, 0.14],
      [-0.1, 0.15],
    ],
    r,
    ankle[0],
    ankle[1],
  )
  piece(ctx, outline, far ? CREAM_FAR : CREAM, lw, r * 0.05)
  for (const k of [0, 1, 2]) {
    const tx = ankle[0] + r * (0.42 - k * 0.09)
    const ty = ankle[1] + r * 0.14
    polyline(
      ctx,
      [
        [tx, ty],
        [tx - r * 0.03, ty - r * 0.1],
      ],
      INK,
      lw * 0.8,
    )
  }
}

// ─── Monkey ───────────────────────────────────────────────────────────────────

const TORSO = [
  [0.18, 0.55],
  [0.24, 0.9],
  [0.46, 1.3],
  [0.54, 1.84],
  [0.34, FIGURE_GROUND],
  [-0.78, FIGURE_GROUND],
  [-1.06, FIGURE_GROUND - 0.3],
  [-1.02, 1.74],
  [-0.74, 1.2],
  [-0.4, 0.92],
  [-0.34, 0.55],
] as const

const BELLY = [
  [0.14, 1.14],
  [0.42, 1.32],
  [0.48, 1.86],
  [0.3, 2.14],
  [0.02, 2.14],
  [-0.14, 1.68],
] as const

const HEAD = [
  [-0.38, -0.82],
  [0.28, -0.86],
  [0.7, -0.58],
  [0.9, -0.12],
  [0.84, 0.36],
  [0.54, 0.72],
  [0.02, 0.84],
  [-0.52, 0.74],
  [-0.84, 0.36],
  [-0.92, -0.14],
  [-0.72, -0.6],
] as const

/** The face mask: two brow lobes with a notch between them, tapering to the jaw. */
const FACE = [
  [0.2, -0.36],
  [0.42, -0.56],
  [0.72, -0.48],
  [0.82, -0.12],
  [0.8, 0.22],
  [0.72, 0.5],
  [0.46, 0.72],
  [0.1, 0.72],
  [-0.16, 0.48],
  [-0.34, 0.2],
  [-0.42, -0.12],
  [-0.36, -0.44],
  [-0.08, -0.54],
] as const

function drawHead(
  ctx: CanvasRenderingContext2D,
  r: number,
  t: number,
  step: number,
  turn: number,
  lw: number,
  gateColor: string,
) {
  const shift = (1 - turn) * -0.2
  const px = (v: number) => (v + shift) * r

  // Headband arcs clear of the crown, then dives behind the far side of the skull
  const band = (inset: number) => {
    ctx.beginPath()
    ctx.moveTo(-r * 0.86, -r * 0.02)
    ctx.bezierCurveTo(-r * (0.9 - inset), -r * (1.26 - inset), r * (0.56 - inset), -r * (1.42 - inset), r * 0.72, -r * 0.34)
  }
  ctx.save()
  ctx.lineCap = 'butt'
  for (const [color, width] of [
    [INK, r * 0.13 + lw * 2],
    [PURPLE, r * 0.13],
  ] as const) {
    band(0)
    ctx.strokeStyle = color
    ctx.lineWidth = width
    ctx.stroke()
  }
  band(-0.03)
  ctx.strokeStyle = PURPLE_LIGHT
  ctx.lineWidth = r * 0.025
  ctx.stroke()
  ctx.restore()

  // Ears sit behind the skull
  piece(ctx, ngon(r * 0.92, r * 0.02, r * 0.22, r * 0.25, 7, 0.3), FUR_FAR, lw, r * 0.03)
  piece(ctx, ngon(r * 0.94, r * 0.03, r * 0.12, r * 0.15, 6, 0.1), PINK, 0, 0)
  piece(ctx, ngon(-r * 1.0, r * 0.06, r * 0.29, r * 0.3, 8, 0.25), FUR, lw, r * 0.04)
  piece(ctx, ngon(-r * 1.03, r * 0.08, r * 0.17, r * 0.18, 6, 0.4), PINK, lw * 0.6, 0)

  piece(ctx, place(HEAD, r), FUR, lw, r * 0.09)

  // Face, with the far lobe widening as he turns toward the viewer
  const facePoly: Poly = FACE.map(([x, y]) => [px(x) + (x > 0.4 ? (1 - turn) * 0.06 * r : 0), y * r])
  piece(ctx, facePoly, CREAM, lw * 0.85, r * 0.04)

  const nearLobe = px(0)
  const farLobe = px(0.5)
  const alarmed = step === 1
  const blink = (t * 0.9) % 4 > 3.85
  const ey = -r * 0.08

  // Solid black eyes with a wedge cut out, and the wedge points where he looks
  const eyes = [
    { x: nearLobe, rx: r * (alarmed ? 0.16 : 0.135) },
    { x: farLobe, rx: r * ((alarmed ? 0.15 : 0.125) + (1 - turn) * 0.01) },
  ]
  let gaze = 0.08 + Math.sin(t * 1.3) * 0.06
  if (step === 1) gaze = -0.4
  if (step === 2) gaze = 1.0
  if (step === 4) gaze = -0.5
  const dart = step === 3 ? Math.sin(t * 5) * r * 0.03 : 0
  if (step === 3) gaze = Math.sin(t * 5) > 0 ? 0 : Math.PI
  for (const eye of eyes) {
    if (blink) {
      polyline(
        ctx,
        [
          [eye.x - eye.rx, ey],
          [eye.x + eye.rx, ey],
        ],
        INK,
        lw * 1.6,
      )
      continue
    }
    const ry = eye.rx * 1.22
    const wedge = alarmed ? 0.32 : 0.46
    ctx.beginPath()
    ctx.moveTo(eye.x + dart, ey)
    ctx.ellipse(eye.x + dart, ey, eye.rx, ry, 0, gaze + wedge, gaze + Math.PI * 2 - wedge)
    ctx.closePath()
    ctx.fillStyle = '#0D0B0A'
    ctx.fill()
  }

  // Brows are thin arched lines, they carry most of the acting
  const brows: Record<number, [number, number]> = {
    0: [-0.43, -0.4],
    1: [-0.53, -0.38],
    2: [-0.47, -0.34],
    3: [-0.49, -0.34],
    4: [-0.42, -0.45],
    5: [-0.47, -0.45],
  }
  const [inner, outer] = brows[step] ?? brows[0]
  const brow = (from: number, to: number) => {
    ctx.beginPath()
    ctx.moveTo(from, r * inner)
    ctx.quadraticCurveTo((from + to) / 2, r * ((inner + outer) / 2 - 0.08), to, r * outer)
    ctx.strokeStyle = INK
    ctx.lineWidth = lw * 1.5
    ctx.lineCap = 'round'
    ctx.stroke()
  }
  brow(nearLobe + r * 0.11, nearLobe - r * 0.16)
  brow(farLobe - r * 0.1, farLobe + r * 0.15)

  // Nose
  const noseX = px(0.45)
  for (const k of [-1, 1]) {
    trace(ctx, [
      [noseX + k * r * 0.025, r * 0.25],
      [noseX + k * r * 0.1, r * 0.27],
      [noseX + k * r * 0.07, r * 0.32],
      [noseX + k * r * 0.025, r * 0.3],
    ])
    ctx.fillStyle = INK
    ctx.fill()
  }

  // Mouth
  const mx = px(0.4)
  const my = r * 0.56
  const mouth = (points: readonly (readonly [number, number])[]) =>
    points.map(([x, y]) => [mx + x * r, my + y * r] as Vec)
  /** The hand drawn mouth line: one soft wave, or a shallow smile when `lift` is positive. */
  const mouthLine = (wave: number, lift: number) => {
    ctx.beginPath()
    ctx.moveTo(mx - r * 0.2, my + r * (0.03 - lift))
    ctx.bezierCurveTo(
      mx - r * 0.1,
      my + r * (-0.07 * wave + lift),
      mx + r * 0.05,
      my + r * (0.1 * wave + lift),
      mx + r * 0.2,
      my + r * (-0.03 - lift),
    )
    ctx.strokeStyle = INK
    ctx.lineWidth = lw * 1.6
    ctx.lineCap = 'round'
    ctx.stroke()
  }
  if (step === 1) {
    const flap = Math.sin(t * 9) * 0.012
    piece(
      ctx,
      mouth([
        [-0.09, -0.08],
        [0.09, -0.08],
        [0.13, 0.03],
        [0.08, 0.17 + flap],
        [-0.08, 0.17 + flap],
        [-0.13, 0.03],
      ]),
      MOUTH,
      lw * 0.9,
      0,
    )
    piece(
      ctx,
      mouth([
        [-0.06, 0.1],
        [0.06, 0.1],
        [0.05, 0.15],
        [-0.05, 0.15],
      ]),
      PINK,
      0,
      0,
    )
  } else if (step === 2) {
    piece(
      ctx,
      mouth([
        [0.06, 0],
        [0.17, 0],
        [0.18, 0.1],
        [0.12, 0.15],
        [0.07, 0.1],
      ]),
      PINK,
      lw * 0.7,
      0,
    )
    polyline(
      ctx,
      mouth([
        [-0.15, 0],
        [0.15, 0],
      ]),
      INK,
      lw * 1.4,
    )
  } else if (step === 3) {
    mouthLine(1, 0)
  } else if (step === 5) {
    piece(
      ctx,
      mouth([
        [-0.18, -0.06],
        [0.18, -0.06],
        [0.14, 0.07],
        [0.04, 0.13],
        [-0.04, 0.13],
        [-0.14, 0.07],
      ]),
      MOUTH,
      lw * 0.9,
      0,
    )
  } else {
    mouthLine(0.25, 0.04)
  }

  // Near ear cup goes on top of the head, then the mic boom along the jaw
  ctx.save()
  ctx.lineCap = 'round'
  polyline(
    ctx,
    [
      [-r * 0.74, r * 0.2],
      [-r * 0.6, r * 0.58],
      [-r * 0.22, r * 0.72],
      [r * 0.0, r * 0.62],
    ],
    INK,
    r * 0.075 + lw * 1.4,
  )
  ctx.lineJoin = 'round'
  polyline(
    ctx,
    [
      [-r * 0.74, r * 0.2],
      [-r * 0.6, r * 0.58],
      [-r * 0.22, r * 0.72],
      [r * 0.0, r * 0.62],
    ],
    PURPLE,
    r * 0.075,
  )
  ctx.restore()
  blob(ctx, -r * 0.84 + r * 0.03, -r * 0.01 + r * 0.05, r * 0.19, r * 0.31, 'rgba(40,18,4,0.26)')
  blob(ctx, -r * 0.78, -r * 0.03, r * 0.19, r * 0.31, PURPLE_DARK, INK, lw)
  blob(ctx, -r * 0.84, -r * 0.03, r * 0.15, r * 0.27, PURPLE, INK, lw * 0.8)
  ctx.beginPath()
  ctx.ellipse(-r * 0.84, -r * 0.03, r * 0.1, r * 0.2, 0, Math.PI * 0.75, Math.PI * 1.45)
  ctx.strokeStyle = PURPLE_LIGHT
  ctx.lineWidth = r * 0.03
  ctx.stroke()
  const led = 0.55 + 0.45 * Math.sin(t * (step === 2 || step === 3 ? 9 : 3))
  ctx.save()
  ctx.globalAlpha = led
  blob(ctx, -r * 0.84, -r * 0.03, r * 0.05, r * 0.05, gateColor)
  ctx.restore()
  blob(ctx, r * 0.0, r * 0.62, r * 0.085, r * 0.075, PURPLE_DARK, INK, lw * 0.85)

  if (step === 2 || step === 3) {
    const k = (t * 1.2) % 1
    const sx = r * 0.86
    const sy = -r * 0.55 + k * r * 0.5
    ctx.save()
    ctx.globalAlpha = 1 - k * 0.8
    piece(
      ctx,
      [
        [sx, sy - r * 0.16],
        [sx + r * 0.1, sy + r * 0.03],
        [sx + r * 0.05, sy + r * 0.11],
        [sx - r * 0.05, sy + r * 0.11],
        [sx - r * 0.1, sy + r * 0.03],
      ],
      '#8CCBEF',
      lw * 0.75,
      0,
    )
    ctx.restore()
  }
}

function drawTail(
  ctx: CanvasRenderingContext2D,
  at: (x: number, y: number) => Vec,
  r: number,
  t: number,
  lw: number,
) {
  const G = FIGURE_GROUND
  const j0 = at(-0.72, G - 0.18)
  const j1 = at(-1.42, G - 0.12)
  const swing = Math.sin(t * 1.9) * 0.05
  const j2 = rotateAbout(at(-2.18, 1.62), j1, swing * 0.5)

  // An octagonal spiral, tightening in 45 degree turns
  const center: Vec = [-1.72, 1.12]
  const coil: Poly = [j2]
  const turns = 12
  for (let k = 0; k <= turns; k++) {
    const a = Math.PI * 0.86 + (k * Math.PI) / 4
    const rho = 0.62 * (1 - (k / turns) * 0.82)
    const p = at(center[0] + Math.cos(a) * rho, center[1] + Math.sin(a) * rho)
    coil.push(rotateAbout(rotateAbout(p, j1, swing * 0.5), j2, swing))
  }
  const widths = coil.map((_, i) => r * (0.24 - 0.14 * (i / (coil.length - 1))))
  piece(ctx, strip(coil, widths), FUR, lw, r * 0.04)
  piece(ctx, plate(j1, j2, r * 0.13, r * 0.13, r * 0.12), FUR, lw, r * 0.04)
  piece(ctx, plate(j0, j1, r * 0.13, r * 0.14, r * 0.13), FUR_FAR, lw, r * 0.04)
  pin(ctx, j1[0], j1[1], r * 0.075, 0.5)
  pin(ctx, j2[0], j2[1], r * 0.07, 1.9)
}

function armGeometry(sh: Vec, target: Vec, r: number, side: number) {
  const { e, w } = solveArm(sh, target, r * 0.8, r * 0.78, side)
  return {
    e,
    w,
    upper: plate(sh, e, r * 0.2, r * 0.22, r * 0.15),
    fore: plate(e, w, r * 0.15, r * 0.16, r * 0.105),
    ang: Math.atan2(w[1] - e[1], w[0] - e[0]),
  }
}

/**
 * Draws the monkey. `held` runs between the near arm and the near hand, so an
 * object passed to it ends up with the fingers closed around it.
 */
export function drawMonkey(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  t: number,
  step: number,
  colors: FigureColors,
  anim: SceneAnim,
  gateColor: string,
  held?: (hand: HandInfo) => void,
): HandInfo {
  const lw = Math.max(1.05, r * 0.028)
  const pose = poseFor(step)
  const at = (x: number, y: number): Vec => [cx + x * r, cy + y * r]
  const G = FIGURE_GROUND
  const pinR = r * 0.075

  // Contact shadow under the seat and feet
  trace(ctx, [
    at(-1.25, G + 0.02),
    at(-0.8, G - 0.08),
    at(1.2, G - 0.08),
    at(1.62, G + 0.03),
    at(1.2, G + 0.13),
    at(-0.8, G + 0.13),
  ])
  ctx.fillStyle = colors.shadow
  ctx.fill()

  drawTail(ctx, at, r, t, lw)

  const wobble = (which: 'near' | 'far'): Vec => {
    if (step === 0 && which === 'near') return [0, Math.sin(t * 3.4) * 0.04]
    if (step === 1) return [Math.sin(t * 15 + (which === 'near' ? 0 : 1.4)) * 0.025, 0]
    if (step === 2) return [0, Math.sin(t * 15 + (which === 'near' ? 0 : Math.PI)) * 0.025]
    if (step === 3 && which === 'near') return [0, Math.abs(Math.sin(t * 8)) * -0.07]
    if ((step === 4 || step === 5) && which === 'far') return [0, Math.sin(t * 7) * 0.09]
    return [0, 0]
  }
  const farW = wobble('far')
  const nearW = wobble('near')

  // Far arm goes first so the torso and the head hide its shoulder
  const far = armGeometry(at(-0.34, 1.02), at(anim.far[0] + farW[0], anim.far[1] + farW[1]), r, -1)
  piece(ctx, far.fore, FUR_FAR, lw, r * 0.04)
  piece(ctx, far.upper, FUR_FAR, lw, r * 0.04)
  drawHand(ctx, far.w[0], far.w[1], far.ang, r, lw, pose.farHand)
  pin(ctx, far.e[0], far.e[1], pinR * 0.9, 1.1)

  // Torso, with the neck as part of the same silhouette, and the cream chest on top
  piece(ctx, place(TORSO, r, cx, cy), FUR, lw, r * 0.05)
  piece(ctx, place(BELLY, r, cx, cy), CREAM, lw * 0.85, r * 0.025)

  // Legs: knees up, the far knee sits further forward
  const farHip = at(0.02, G - 0.32)
  const farKnee = at(0.92, 1.62)
  const farAnkle = at(0.88, G - 0.15)
  piece(ctx, plate(farKnee, farAnkle, r * 0.17, r * 0.18, r * 0.13), FUR_FAR, lw, r * 0.04)
  piece(ctx, plate(farHip, farKnee, r * 0.28, r * 0.28, r * 0.17), FUR_FAR, lw, r * 0.04)
  drawFoot(ctx, farAnkle, r, lw, true)
  pin(ctx, farKnee[0], farKnee[1], pinR * 0.9, 0.3)

  const nearHip = at(-0.26, G - 0.32)
  const nearKnee = at(0.5, 1.56)
  const nearAnkle = at(0.5, G - 0.15)
  piece(ctx, plate(nearKnee, nearAnkle, r * 0.18, r * 0.19, r * 0.13), FUR, lw, r * 0.05)
  piece(ctx, plate(nearHip, nearKnee, r * 0.36, r * 0.36, r * 0.2), FUR, lw, r * 0.07)
  drawFoot(ctx, nearAnkle, r, lw, false)
  pin(ctx, nearKnee[0], nearKnee[1], pinR, 0.7)
  pin(ctx, nearHip[0], nearHip[1], pinR, 2.2)

  // Tablet rests on the knees while signing
  if (step === 2) {
    const rot = -0.22
    ctx.save()
    ctx.translate(cx + r * 0.68, cy + r * 1.12)
    ctx.rotate(rot)
    piece(
      ctx,
      place(
        [
          [-0.33, -0.25],
          [0.34, -0.25],
          [0.38, -0.2],
          [0.38, 0.2],
          [0.33, 0.25],
          [-0.34, 0.25],
          [-0.38, 0.19],
          [-0.38, -0.2],
        ],
        r,
      ),
      colors.panelDark,
      lw,
      r * 0.05,
      rot,
    )
    piece(
      ctx,
      place(
        [
          [-0.31, -0.18],
          [0.31, -0.18],
          [0.31, 0.18],
          [-0.31, 0.18],
        ],
        r,
      ),
      PURPLE,
      lw * 0.7,
      0,
      rot,
    )
    ctx.fillStyle = 'rgba(255,255,255,0.85)'
    const prog = (t * 0.9) % 1
    ctx.fillRect(-r * 0.25, -r * 0.03, r * 0.5 * prog, r * 0.05)
    ctx.restore()
  }

  // Head pivots on the neck
  const breathe = Math.sin(t * 2.2)
  const headCenterY = cy + breathe * r * 0.02
  const tiltBy: Record<number, number> = {
    0: 0.05,
    1: -0.05,
    2: 0.12,
    3: Math.sin(t * 5) * 0.03,
    4: -0.04,
    5: Math.sin(t * 3.2) * 0.05,
  }
  ctx.save()
  ctx.translate(cx, headCenterY + r * 0.72)
  ctx.rotate(tiltBy[step] ?? 0)
  ctx.translate(0, -r * 0.72)
  drawHead(ctx, r, t, step, anim.turn, lw, gateColor)
  ctx.restore()

  // Near arm is the closest thing to the viewer
  const shoulder = at(0.06, 1.04)
  const near = armGeometry(shoulder, at(anim.near[0] + nearW[0], anim.near[1] + nearW[1]), r, 1)
  piece(ctx, near.fore, FUR, lw, r * 0.05)
  piece(ctx, near.upper, FUR, lw, r * 0.07)
  pin(ctx, near.e[0], near.e[1], pinR, 0.9)
  pin(ctx, shoulder[0], shoulder[1], pinR, 2.5)

  const hand: HandInfo = {
    x: near.w[0],
    y: near.w[1],
    ang: near.ang,
    palmX: near.w[0] + Math.cos(near.ang) * r * 0.08,
    palmY: near.w[1] + Math.sin(near.ang) * r * 0.08,
  }
  held?.(hand)
  drawHand(ctx, hand.x, hand.y, hand.ang, r, lw, pose.nearHand)
  return hand
}

// ─── Banana ───────────────────────────────────────────────────────────────────

const BANANA_WIDTH_KEYS = [
  [0, 0.12],
  [0.05, 0.26],
  [0.16, 0.43],
  [0.4, 0.53],
  [0.62, 0.5],
  [0.8, 0.35],
  [0.92, 0.2],
  [1, 0.14],
] as const

/** Where along the banana the knife changes direction. */
const BANANA_CUTS = [0, 2, 7, 13, 19, 25, 31, 36, 40]

function smooth(a: number, b: number, x: number): number {
  const v = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return v * v * (3 - 2 * v)
}

function profile(keys: readonly (readonly [number, number])[], u: number): number {
  for (let i = 0; i < keys.length - 1; i++) {
    const [a, va] = keys[i]
    const [b, vb] = keys[i + 1]
    if (u <= b) return va + (vb - va) * smooth(a, b, u)
  }
  return keys[keys.length - 1][1]
}

interface BananaGeom {
  pts: Poly
  angles: number[]
  widths: number[]
  /** A line along the banana, at a fraction of its width: 0.5 is the top edge, -0.5 the bottom. */
  edge: (f: number, from?: number, to?: number) => Poly
}

/**
 * A slim crescent: the bend has to be stronger than the width, or the inner edge
 * goes flat and it reads as a boat. Tapered at both ends, sampled at a handful
 * of cuts so it comes out as straight facets.
 */
function bananaGeom(s: number): BananaGeom {
  const N = 40
  const step = (2.5 * s) / N
  const raw: Poly = []
  const angles: number[] = []
  let x = 0
  let y = 0
  for (let i = 0; i <= N; i++) {
    const u = i / N
    const a = 0.78 - 1.5 * u - 0.25 * smooth(0.75, 1, u)
    raw.push([x, y])
    angles.push(a)
    x += Math.cos(a) * step
    y += Math.sin(a) * step
  }
  const xs = raw.map((p) => p[0])
  const ys = raw.map((p) => p[1])
  const ox = (Math.min(...xs) + Math.max(...xs)) / 2
  const oy = (Math.min(...ys) + Math.max(...ys)) / 2
  const pts = raw.map((p) => [p[0] - ox, p[1] - oy] as Vec)
  const widths = pts.map((_, i) => profile(BANANA_WIDTH_KEYS, i / N) * s)
  const edge = (f: number, from = 0, to = BANANA_CUTS.length - 1): Poly =>
    BANANA_CUTS.slice(from, to + 1).map((i) => [
      pts[i][0] + Math.sin(angles[i]) * widths[i] * f,
      pts[i][1] - Math.cos(angles[i]) * widths[i] * f,
    ])
  return { pts, angles, widths, edge }
}

/** Distance from the banana's center down to its lowest point, when it lies flat. */
export function bananaBottom(s: number): number {
  const { edge } = bananaGeom(s)
  return Math.max(...[...edge(0.5), ...edge(-0.5)].map((p) => p[1]))
}

export function drawBanana(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  s: number,
  rot: number,
) {
  const lw = Math.max(1, s * 0.03)
  const { pts, angles, edge } = bananaGeom(s)
  const N = pts.length - 1
  const band = (a: Poly, b: Poly): Poly => [...a, ...[...b].reverse()]

  ctx.save()
  ctx.translate(x, y)
  ctx.rotate(rot)

  // Stem: a separate strip tucked under the neck, with a flat woody cut
  const end = pts[N]
  const endA = angles[N]
  const stem: Poly = [0, 0.5, 1].map((u) => {
    const a = endA - 0.2 * u
    const d = -s * 0.1 + u * s * 0.44
    return [end[0] + Math.cos(a) * d, end[1] + Math.sin(a) * d]
  })
  piece(ctx, strip(stem, [s * 0.13, s * 0.12, s * 0.17]), '#A8A63A', lw, s * 0.04, rot)
  const tipA = endA - 0.2
  const tipX = stem[2][0]
  const tipY = stem[2][1]
  const nx = -Math.sin(tipA) * s * 0.075
  const ny = Math.cos(tipA) * s * 0.075
  const tx = Math.cos(tipA) * s * 0.035
  const ty = Math.sin(tipA) * s * 0.035
  piece(
    ctx,
    [
      [tipX - nx - tx, tipY - ny - ty],
      [tipX - nx + tx, tipY - ny + ty],
      [tipX + nx + tx, tipY + ny + ty],
      [tipX + nx - tx, tipY + ny - ty],
    ],
    '#4A3A18',
    lw * 0.8,
    0,
    rot,
  )

  // Fruit: the body, then long facets laid along it
  const top = edge(0.5)
  const bottom = edge(-0.5)
  const outline = band(top, bottom)
  piece(ctx, outline, '#FFD233', lw, s * 0.06, rot)
  const last = BANANA_CUTS.length - 1
  piece(ctx, band(edge(0.46, 1, last - 2), edge(0.12, 1, last - 2)), '#FFE36E', 0, 0, rot)
  piece(ctx, band(edge(-0.22, 1, last - 2), edge(-0.46, 1, last - 2)), '#E9AC1B', 0, 0, rot)

  // A hard step of green toward the stem, no fade
  piece(ctx, band(edge(0.48, last - 1, last), edge(-0.48, last - 1, last)), '#C9C544', 0, 0, rot)

  ctx.lineJoin = 'miter'
  polyline(ctx, edge(0.12, 1, last - 1), 'rgba(120,76,0,0.55)', lw * 0.75)
  polyline(ctx, edge(-0.22, 1, last - 1), 'rgba(120,76,0,0.42)', lw * 0.75)

  // Bruises are little cut flecks
  for (const [i, f, d] of [
    [13, -0.26, 0.022],
    [18, -0.3, 0.03],
    [24, -0.27, 0.022],
    [29, -0.22, 0.018],
    [21, 0.02, 0.016],
  ] as const) {
    const cx = pts[i][0] + Math.sin(angles[i]) * s * 0.5 * f
    const cy = pts[i][1] - Math.cos(angles[i]) * s * 0.5 * f
    trace(ctx, ngon(cx, cy, d * s, d * s * 0.7, 4, angles[i] + 0.4))
    ctx.fillStyle = 'rgba(105,65,10,0.6)'
    ctx.fill()
  }

  // Redraw the outer cut so the facets stop cleanly on it
  trace(ctx, outline)
  ctx.strokeStyle = INK
  ctx.lineWidth = lw
  ctx.miterLimit = 3
  ctx.stroke()

  // Blossom end
  const tip = pts[0]
  const a0 = angles[0]
  piece(
    ctx,
    ngon(tip[0] - Math.cos(a0) * s * 0.02, tip[1] - Math.sin(a0) * s * 0.02, s * 0.055, s * 0.07, 6, a0),
    '#3E2C14',
    lw * 0.75,
    0,
    rot,
  )
  ctx.restore()
}
