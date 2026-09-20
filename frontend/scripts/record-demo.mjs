/**
 * Record a mobile walkthrough of Gigr and report any runtime errors.
 *
 * Uses the playwright-core already present on this machine (no install) and the
 * cached Chromium + ffmpeg. Drives the real app at a phone viewport, with
 * geolocation set so the map centres somewhere real.
 *
 *   node scripts/record-demo.mjs
 *
 * Output: frontend/recordings/<name>.webm  (Playwright writes webm; convert with
 * the bundled ffmpeg if you need mp4).
 */
import { createRequire } from 'module'
import path from 'path'
import fs from 'fs'

const require = createRequire(import.meta.url)
const PLAYWRIGHT_CORE =
  process.env.PLAYWRIGHT_CORE ||
  '/home/ksschkw/kss/chinonye/node_modules/playwright-core'

const BASE = process.env.DEMO_BASE_URL || 'http://127.0.0.1:5173'
const EMAIL = process.env.DEMO_EMAIL || 'demo@gigr.dev'
const PASSWORD = process.env.DEMO_PASSWORD || 'DemoPass!123'
const LAT = Number(process.env.DEMO_LAT || 5.3903354)
const LNG = Number(process.env.DEMO_LNG || 7.000361)

const OUT_DIR = path.resolve('recordings')
fs.mkdirSync(OUT_DIR, { recursive: true })

const { chromium } = require(PLAYWRIGHT_CORE)

const problems = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    geolocation: { latitude: LAT, longitude: LNG },
    permissions: ['geolocation'],
    recordVideo: { dir: OUT_DIR, size: { width: 390, height: 844 } },
  })

  const page = await context.newPage()

  // Everything the page complains about, with a component stack when React
  // supplies one. This is the point of the exercise: a real report.
  page.on('pageerror', (err) => {
    problems.push({ kind: 'pageerror', message: err.message, stack: (err.stack || '').split('\n').slice(0, 6).join('\n') })
  })
  page.on('console', (msg) => {
    if (msg.type() === 'error') problems.push({ kind: 'console', message: msg.text().slice(0, 400) })
  })

  const step = async (name, fn) => {
    process.stdout.write(`  - ${name}\n`)
    try {
      await fn()
    } catch (err) {
      problems.push({ kind: 'step', message: `${name}: ${err.message}` })
    }
  }

  console.log(`Opening ${BASE}`)
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await sleep(1500)

  await step('log in', async () => {
    // Auth is a modal opened from the landing page, not a /login route.
    await page.goto(BASE, { waitUntil: 'domcontentloaded' })
    await sleep(2500)
    await page.getByRole('button', { name: /^sign in$/i }).first().click()
    const dialog = page.locator('[role="dialog"]').first()
    await dialog.waitFor({ state: 'visible', timeout: 20000 })
    await dialog.locator('input[type="email"]').first().fill(EMAIL)
    await dialog.locator('input[type="password"]').first().fill(PASSWORD)
    await dialog.getByRole('button', { name: /sign in|log in/i }).first().click()
    await page.waitForURL(/dashboard/, { timeout: 30000 })
    await sleep(3000)
    console.log('    signed in as', EMAIL)
  })

  await step('dashboard home', async () => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
    await sleep(2000)
    await page.mouse.wheel(0, 400)
    await sleep(800)
    await page.mouse.wheel(0, -400)
    await sleep(500)
  })

  await step('jobs list + filters', async () => {
    await page.goto(`${BASE}/dashboard/jobs`, { waitUntil: 'domcontentloaded' })
    await sleep(2500)
    const filters = page.getByRole('button', { name: /filters/i }).first()
    if (await filters.count()) {
      await filters.click()
      await sleep(1200)
      await filters.click()
      await sleep(400)
    }
  })

  await step('JOBS MAP (the crash report)', async () => {
    await page.getByRole('tab', { name: /map/i }).first().click()
    await sleep(4000)
    // poking the map is what the report described
    const box = await page.locator('.leaflet-container').first().boundingBox()
    if (box) {
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.4)
      await sleep(1500)
      await page.mouse.click(box.x + box.width * 0.35, box.y + box.height * 0.6)
      await sleep(1500)
    }
  })

  await step('services list', async () => {
    await page.goto(`${BASE}/dashboard/services`, { waitUntil: 'domcontentloaded' })
    await sleep(2500)
  })

  await step('SERVICES MAP + chips + heat', async () => {
    await page.getByRole('button', { name: /^map$/i }).first().click()
    await sleep(3500)
    const jobs = page.getByRole('button', { name: /^jobs \d+/i }).first()
    if (await jobs.count()) { await jobs.click(); await sleep(1800) }
    const all = page.getByRole('button', { name: /^all \d+/i }).first()
    if (await all.count()) { await all.click(); await sleep(1200) }
    const heat = page.getByRole('button', { name: /^heat$/i }).first()
    if (await heat.count()) { await heat.click(); await sleep(2500) }
    const box = await page.locator('.leaflet-container').first().boundingBox()
    if (box) { await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5); await sleep(1500) }
  })

  await step('service detail (radius + route)', async () => {
    const card = page.locator('a[href*="/dashboard/services/"]').first()
    if (await card.count()) {
      await card.click()
      await sleep(3500)
    }
  })

  await step('agent panel + a real command', async () => {
    await page.goto(`${BASE}/dashboard`, { waitUntil: 'domcontentloaded' })
    await sleep(2000)
    await page.locator('#agent-bell-btn').first().click()
    await sleep(1500)
    const input = page.getByPlaceholder(/ask me anything/i).first()
    if (await input.count()) {
      await input.fill('find someone that does woodworks near me')
      await input.press('Enter')
      await sleep(7000)
    }
  })

  await step('ai settings + autonomy', async () => {
    await page.goto(`${BASE}/dashboard/ai-settings`, { waitUntil: 'domcontentloaded' })
    await sleep(2500)
    await page.mouse.wheel(0, 300)
    await sleep(1200)
    await page.mouse.wheel(0, -300)
    await sleep(800)
  })

  await step('profile + scroll (sticky nav)', async () => {
    await page.goto(`${BASE}/dashboard/profile`, { waitUntil: 'domcontentloaded' })
    await sleep(2000)
    await page.mouse.wheel(0, 500)
    await sleep(1000)
  })

  const video = page.video()
  await context.close()
  await browser.close()

  if (video) {
    const saved = await video.path()
    console.log(`\nVideo written to: ${saved}`)
  }

  console.log(`\n=== runtime problems: ${problems.length} ===`)
  for (const p of problems) {
    console.log(`\n[${p.kind}] ${p.message}`)
    if (p.stack) console.log(p.stack)
  }
}

main().catch((err) => {
  console.error('recorder failed:', err)
  process.exit(1)
})
