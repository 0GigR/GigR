#!/usr/bin/env node
/**
 * Bundle-size budget check.
 *
 * Fails the build if the entry (index-*.js) chunk exceeds the configured
 * budget, so route-level code splitting can't silently regress. Runs as the
 * last step of `npm run build` — every deploy (Vercel etc.) enforces it.
 *
 * Budget is configurable via ENTRY_BUDGET_KB (default 450 KB raw).
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

const DIST = new URL('../dist/', import.meta.url)
const budgetKb = Number(process.env.ENTRY_BUDGET_KB || 450)
const budgetBytes = budgetKb * 1024

const html = readFileSync(new URL('index.html', DIST), 'utf8')

// The entry chunk is the <script type="module"> src in the built HTML.
const entryMatch = html.match(/<script type="module"[^>]*src="\/([^"]+\.js)"/)
if (!entryMatch) {
  console.error('check-bundle-size: could not find the entry <script> in dist/index.html')
  process.exit(1)
}
// src is like "/assets/index-abc123.js" — keep just the filename for comparison.
const entryFile = entryMatch[1].split('/').pop()

const assetsDir = new URL('assets/', DIST)
const files = readdirSync(assetsDir).filter((f) => f.endsWith('.js'))
const sizes = files
  .map((f) => ({ name: f, bytes: statSync(join(assetsDir.pathname, f)).size }))
  .sort((a, b) => b.bytes - a.bytes)

const entry = sizes.find((s) => s.name === entryFile)
if (!entry) {
  console.error(`check-bundle-size: entry chunk "${entryFile}" not found in dist/assets`)
  process.exit(1)
}

const gz = gzipSync(readFileSync(join(assetsDir.pathname, entryFile))).length
const pct = ((entry.bytes / budgetBytes) * 100).toFixed(0)

console.log('── Bundle size check ────────────────────────────────')
console.log(`  entry:   ${(entry.bytes / 1024).toFixed(1)} KB raw / ${(gz / 1024).toFixed(1)} KB gzip`)
console.log(`  budget:  ${budgetKb} KB raw (${pct}% used)`)
console.log('  largest chunks:')
for (const s of sizes.slice(0, 5)) {
  console.log(`    ${(s.bytes / 1024).toFixed(1).padStart(8)} KB  ${s.name}`)
}
console.log('──────────────────────────────────────────────────────')

if (entry.bytes > budgetBytes) {
  console.error(
    `\n✗ Bundle budget exceeded: entry is ${(entry.bytes / 1024).toFixed(1)} KB, ` +
      `budget is ${budgetKb} KB. Trim deps or split more aggressively.`
  )
  process.exit(1)
}

console.log(`✓ Entry chunk within budget (${budgetKb} KB).`)
