#!/usr/bin/env node
/**
 * Bundle-size budget check.
 *
 * Fails the build if the entry chunk OR any of the heavy on-demand chunks
 * (heic2any, leaflet, framer-motion) exceeds its budget, so code splitting
 * can't silently regress. Runs as the last step of `npm run build` — every
 * deploy (Vercel, CI) enforces it.
 *
 * Chunks are identified by a content marker rather than by filename, because
 * rolldown names chunks after their first module and hashes every asset — the
 * marker is stable across renames. For each marker we budget the largest chunk
 * that contains it (the library chunk; small page chunks may also mention the
 * name in code and must not be mistaken for the library).
 *
 * Budgets (KB raw, configurable via env):
 *   ENTRY_BUDGET_KB           default 450   entry chunk
 *   HEIC_BUDGET_KB            default 1600  heic2any (bundles a WASM decoder)
 *   LEAFLET_BUDGET_KB         default 250   react-leaflet + leaflet
 *   FRAMER_MOTION_BUDGET_KB   default 200   framer-motion
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const DIST = new URL('../dist/', import.meta.url)
// `new URL(...).pathname` is not a usable filesystem path on Windows (it begins
// with `/C:/`), so resolve to a real path via fileURLToPath before joining.
const assetsDir = fileURLToPath(new URL('assets/', DIST))

const kB = (n) => Number(n || 0)
const budgets = [
  {
    name: 'entry',
    budgetBytes: kB(process.env.ENTRY_BUDGET_KB || 450) * 1024,
    // The entry is the <script type="module"> src in the built HTML.
    find: () => {
      const html = readFileSync(new URL('index.html', DIST), 'utf8')
      const m = html.match(/<script type="module"[^>]*src="\/([^"]+\.js)"/)
      return m ? m[1].split('/').pop() : null
    },
  },
  {
    name: 'heic2any (image uploads)',
    budgetBytes: kB(process.env.HEIC_BUDGET_KB || 1600) * 1024,
    marker: 'heic2any',
  },
  {
    name: 'leaflet (maps)',
    budgetBytes: kB(process.env.LEAFLET_BUDGET_KB || 250) * 1024,
    marker: 'leaflet',
  },
  {
    name: 'framer-motion (animations)',
    budgetBytes: kB(process.env.FRAMER_MOTION_BUDGET_KB || 200) * 1024,
    marker: 'framer-motion',
  },
]

const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'))
const sizes = files
  .map((f) => {
    const path = join(assetsDir, f)
    const bytes = statSync(path).size
    let content = null
    return {
      name: f,
      bytes,
      // Lazily read content only when a marker needs it.
      get content() {
        if (content === null) content = readFileSync(path, 'utf8')
        return content
      },
    }
  })
  .sort((a, b) => b.bytes - a.bytes)

function findChunk(name) {
  return sizes.find((s) => s.name === name)
}

function findLargestWithMarker(marker) {
  // The library chunk is the largest chunk containing the marker. Page chunks
  // may mention the library name in code but are far smaller.
  let best = null
  for (const s of sizes) {
    if (s.content.includes(marker)) {
      if (!best || s.bytes > best.bytes) best = s
    }
  }
  return best
}

console.log('── Bundle size check ────────────────────────────────')
const failures = []
for (const b of budgets) {
  const chunk = b.marker ? findLargestWithMarker(b.marker) : findChunk(b.find())

  if (!chunk) {
    if (b.marker) {
      // Library not bundled at all (e.g. removed) — that's fine, nothing to budget.
      console.log(`  ${b.name.padEnd(28)} not bundled (ok)`)
      continue
    }
    console.error(`check-bundle-size: entry chunk not found in dist/index.html`)
    process.exit(1)
  }

  const gz = gzipSync(readFileSync(join(assetsDir, chunk.name))).length
  const pct = ((chunk.bytes / b.budgetBytes) * 100).toFixed(0)
  const mark = chunk.bytes > b.budgetBytes ? '✗' : '✓'
  console.log(
    `  ${mark} ${b.name.padEnd(28)} ${(chunk.bytes / 1024).toFixed(1).padStart(7)} KB ` +
      `raw / ${(gz / 1024).toFixed(1).padStart(6)} KB gzip  (budget ${(b.budgetBytes / 1024).toFixed(0)} KB, ${pct}%)`
  )
  if (chunk.bytes > b.budgetBytes) {
    failures.push(`${b.name}: ${(chunk.bytes / 1024).toFixed(1)} KB > ${(b.budgetBytes / 1024).toFixed(0)} KB`)
  }
}

console.log('  largest chunks:')
for (const s of sizes.slice(0, 5)) {
  console.log(`    ${(s.bytes / 1024).toFixed(1).padStart(8)} KB  ${s.name}`)
}
console.log('──────────────────────────────────────────────────────')

if (failures.length > 0) {
  console.error(`\n✗ Bundle budget exceeded:`)
  for (const f of failures) console.error(`  - ${f}`)
  console.error('  Trim deps or split more aggressively.')
  process.exit(1)
}

console.log('✓ All chunks within budget.')
