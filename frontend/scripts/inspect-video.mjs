// Frame-grab a local video using Chrome (Playwright's ffmpeg build cannot decode
// H.264, but the browser can). Writes PNGs into recordings/frames/.
import { createRequire } from 'module'
import path from 'path'
import fs from 'fs'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_CORE || '/home/ksschkw/kss/chinonye/node_modules/playwright-core')

const file = path.resolve(process.argv[2] || 'recordings/user-demo.mp4')
const outDir = path.resolve('recordings/frames')
fs.rmSync(outDir, { recursive: true, force: true })
fs.mkdirSync(outDir, { recursive: true })

const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 420, height: 900 } })
await page.setContent(`<body style="margin:0;background:#000"><video id="v" src="file://${file}" style="width:100vw;height:100vh;object-fit:contain"></video></body>`)

const meta = await page.evaluate(() => new Promise((res) => {
  const v = document.getElementById('v')
  if (v.readyState >= 1) return res({ d: v.duration, w: v.videoWidth, h: v.videoHeight })
  v.onloadedmetadata = () => res({ d: v.duration, w: v.videoWidth, h: v.videoHeight })
}))
console.log('duration(s):', meta.d?.toFixed(2), '| size:', meta.w + 'x' + meta.h)

const count = Math.min(12, Math.max(4, Math.round(meta.d / 4)))
for (let i = 0; i < count; i++) {
  const t = (meta.d * i) / count + 0.4
  await page.evaluate((tt) => new Promise((res) => {
    const v = document.getElementById('v')
    v.onseeked = () => res()
    v.currentTime = tt
  }), t)
  const name = `t${String(Math.round(t)).padStart(3, '0')}.png`
  await page.screenshot({ path: path.join(outDir, name) })
  console.log('frame', name)
}
await browser.close()
