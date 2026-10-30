import { describe, expect, it } from 'vitest'
import {
  JUDGES_BRANDS,
  JUDGES_STATS,
  JUDGE_BRAND_LINKS,
  JUDGE_COPY_LINKS,
  JUDGE_PRODUCT_LINKS,
  JUDGE_UPSTREAM_ISSUES,
  isSafeExternalHref,
  linkSegments,
} from './judgesContent'
import { JUDGES_CHAPTERS } from './judgesChapters'

describe('judges brand marks', () => {
  it('uses a real asset for every brand that has one', () => {
    const marks = JUDGES_BRANDS.filter((brand) => brand.mark !== null)
    expect(marks.map((brand) => brand.name)).toEqual([
      'Walrus Memory',
      'Tatum',
      'Sui',
      'MemWal',
    ])
  })

  it('leaves x402 as type, because no logo asset exists', () => {
    const x402 = JUDGES_BRANDS.find((brand) => brand.name === 'x402')
    expect(x402?.mark).toBeNull()
  })

  it('serves every mark from /brands and never copies an asset path', () => {
    for (const brand of JUDGES_BRANDS) {
      if (!brand.mark) continue
      expect(brand.mark.src.startsWith('/brands/')).toBe(true)
      expect(brand.mark.src.split('/').length).toBe(3)
      expect(brand.mark.src).not.toContain('..')
    }
  })

  it('gives every mark alt text, an intrinsic size and ASCII only', () => {
    for (const brand of JUDGES_BRANDS) {
      if (!brand.mark) continue
      expect(brand.mark.alt.length).toBeGreaterThan(3)
      expect(brand.mark.alt).not.toMatch(/[^\x00-\x7F]/)
      expect(brand.mark.src).not.toMatch(/[^\x00-\x7F]/)
      expect(brand.mark.width).toBeGreaterThan(0)
      expect(brand.mark.height).toBeGreaterThan(0)
    }
  })

  it('keeps the dark artwork on a light surface', () => {
    // Tatum, Sui and MemWal ship dark wordmarks; the chip variants are the
    // white cards that keep them legible on this page.
    for (const brand of JUDGES_BRANDS) {
      if (!brand.mark) continue
      const isChip = brand.mark.chip === true
      expect(isChip || brand.mark.invert === true).toBe(true)
    }
  })
})

describe('judges brand strip', () => {
  it('lists the five target brands in prominence order', () => {
    expect(JUDGES_BRANDS.map((brand) => brand.name)).toEqual([
      'Walrus Memory',
      'Tatum',
      'x402',
      'Sui',
      'MemWal',
    ])
  })

  it('gives every brand a role and a distinct tone', () => {
    for (const brand of JUDGES_BRANDS) {
      expect(brand.role.length).toBeGreaterThan(2)
    }
    expect(new Set(JUDGES_BRANDS.map((brand) => brand.tone)).size).toBe(
      JUDGES_BRANDS.length,
    )
  })

  it('keeps the brand strip ASCII', () => {
    for (const brand of JUDGES_BRANDS) {
      expect(brand.name + ' ' + brand.role).not.toMatch(/[^\x00-\x7F]/)
    }
  })
})

describe('judges brand strip links', () => {
  it('turns each of the five tiles into its own safe https link', () => {
    expect(JUDGES_BRANDS.map((brand) => brand.href)).toEqual([
      'https://walrus.xyz',
      'https://tatum.io',
      'https://x402.org',
      'https://sui.io',
      'https://github.com/MystenLabs/walrus-memory',
    ])
  })

  it('gives every tile a non-empty accessible label and a safe href', () => {
    expect(JUDGES_BRANDS.length).toBe(5)
    for (const brand of JUDGES_BRANDS) {
      expect(brand.name.trim().length).toBeGreaterThan(0)
      expect(brand.role.trim().length).toBeGreaterThan(0)
      expect(brand.href).not.toBe('')
      expect(brand.href.toLowerCase()).not.toContain('javascript:')
      expect(isSafeExternalHref(brand.href)).toBe(true)
    }
  })
})

describe('judges stat row', () => {
  it('reads the required facts in the required words', () => {
    expect(JUDGES_STATS.map((stat) => stat.phrase)).toEqual([
      'three Tatum integrations across two chains',
      'Walrus Memory with a namespace per user',
      "five upstream issues filed against Mysten's SDK and all closed",
      'x402 one payment one brief',
    ])
  })

  it('builds every phrase from its value and label', () => {
    for (const stat of JUDGES_STATS) {
      expect(`${stat.value} ${stat.label}`).toBe(stat.phrase)
    }
  })

  it('keeps the stat row ASCII', () => {
    for (const stat of JUDGES_STATS) {
      expect(stat.phrase).not.toMatch(/[^\x00-\x7F]/)
    }
  })
})

describe('judges grouped links', () => {
  it('puts the brand links in the briefed order', () => {
    expect(JUDGE_BRAND_LINKS.map((link) => link.label)).toEqual([
      'Walrus Memory SDK',
      'Tatum',
      'Sui',
      'x402',
    ])
  })

  it('puts the app, both videos and the source after the brands', () => {
    expect(JUDGE_PRODUCT_LINKS.map((link) => link.label)).toEqual([
      'Application',
      'Demo video',
      'Full Gigr walkthrough',
      'Source',
    ])
    expect(JUDGE_PRODUCT_LINKS.map((link) => link.href)).toEqual([
      'https://gigrr.vercel.app',
      'https://youtu.be/HM9IAKpiks0',
      'https://youtu.be/i21snLQ9OlM',
      'https://github.com/0GigR/GigR',
    ])
  })

  it('links every group over https', () => {
    const links = [...JUDGE_BRAND_LINKS, ...JUDGE_PRODUCT_LINKS]
    for (const link of links) {
      expect(link.href.startsWith('https://')).toBe(true)
      expect(link.href).not.toContain('localhost')
    }
  })
})

describe('judges copy links', () => {
  it('places exactly the six checkable claims in the copy', () => {
    expect(JUDGE_COPY_LINKS).toHaveLength(6)
    expect(JUDGE_COPY_LINKS.map((link) => link.label)).toEqual([
      'the recovery test',
      'Sui has deprecated JSON-RPC',
      'the blob we verified',
      'HTTP 402',
      'x402',
      'does not support Sui',
    ])
  })

  it('gives every copy link a label, a safe url and a real line', () => {
    for (const link of JUDGE_COPY_LINKS) {
      expect(link.label.trim().length).toBeGreaterThan(0)
      expect(link.href).not.toBe('')
      expect(link.href.toLowerCase()).not.toContain('javascript:')
      expect(isSafeExternalHref(link.href)).toBe(true)

      const chapter = JUDGES_CHAPTERS.find((entry) => entry.id === link.chapter)
      expect(chapter, link.label).toBeDefined()
      expect(link.line).toBeGreaterThanOrEqual(0)
      expect(link.line).toBeLessThan(chapter?.lines.length ?? 0)
      expect(chapter?.lines[link.line], link.label).toContain(link.label)
    }
  })

  it('does not put two links on the same label of the same line', () => {
    const keys = JUDGE_COPY_LINKS.map(
      (link) => `${link.chapter}:${link.line}:${link.label}`,
    )
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('never uses a bare url as the anchor text', () => {
    for (const link of JUDGE_COPY_LINKS) {
      expect(link.label).not.toMatch(/^https?:\/\//)
      expect(link.label).not.toMatch(/^www\./)
    }
  })
})

describe('linkSegments', () => {
  it('returns the whole line as one plain segment when nothing matches', () => {
    expect(linkSegments('Plain copy.', [])).toEqual([{ text: 'Plain copy.' }])
    expect(linkSegments('Plain copy.', [{ label: 'missing', href: 'https://x.test' }])).toEqual(
      [{ text: 'Plain copy.' }],
    )
  })

  it('reconstructs the line and marks exactly the anchor text', () => {
    const segments = linkSegments('One HTTP 402 and two.', [
      { label: 'HTTP 402', href: 'https://developer.mozilla.org/402' },
    ])
    expect(segments.map((segment) => segment.text).join('')).toBe('One HTTP 402 and two.')
    expect(segments).toEqual([
      { text: 'One ' },
      { text: 'HTTP 402', href: 'https://developer.mozilla.org/402' },
      { text: ' and two.' },
    ])
  })

  it('keeps two anchors on one line in reading order', () => {
    const segments = linkSegments('x402 does not support Sui, so it settles on Solana.', [
      { label: 'does not support Sui', href: 'https://docs.test/support' },
      { label: 'x402', href: 'https://x402.org' },
    ])
    expect(segments.map((segment) => segment.text).join('')).toBe(
      'x402 does not support Sui, so it settles on Solana.',
    )
    expect(segments.filter((segment) => segment.href)).toEqual([
      { text: 'x402', href: 'https://x402.org' },
      { text: 'does not support Sui', href: 'https://docs.test/support' },
    ])
  })

  it('never nests one link inside another', () => {
    const segments = linkSegments('x402 does not support Sui.', [
      { label: 'x402 does not support Sui', href: 'https://one.test' },
      { label: 'does not support Sui', href: 'https://two.test' },
    ])
    expect(segments.filter((segment) => segment.href)).toHaveLength(1)
    expect(segments.map((segment) => segment.text).join('')).toBe(
      'x402 does not support Sui.',
    )
  })
})

describe('judges upstream issue links', () => {
  it('lists the five closed issues in number order', () => {
    expect(JUDGE_UPSTREAM_ISSUES).toHaveLength(5)
    expect(JUDGE_UPSTREAM_ISSUES.map((issue) => issue.number)).toEqual([
      1061, 1062, 1063, 1064, 1312,
    ])
  })

  it('gives every issue a label, a safe url and an issue url that matches', () => {
    for (const issue of JUDGE_UPSTREAM_ISSUES) {
      expect(issue.label.trim().length).toBeGreaterThan(0)
      expect(issue.href).not.toBe('')
      expect(issue.href.toLowerCase()).not.toContain('javascript:')
      expect(isSafeExternalHref(issue.href)).toBe(true)
      expect(issue.href).toBe(
        `https://github.com/MystenLabs/walrus-memory/issues/${issue.number}`,
      )
    }
  })

  it('records where 1061 and 1312 landed and leaves the rest unannotated', () => {
    const notes = new Map(
      JUDGE_UPSTREAM_ISSUES.map((issue) => [issue.number, issue.note]),
    )
    expect(notes.get(1061)).toBe('shipped as forget in memwal 0.2.2')
    expect(notes.get(1312)).toBe('fixed in relayer 0.1.0')
    expect(notes.get(1062)).toBeNull()
    expect(notes.get(1063)).toBeNull()
    expect(notes.get(1064)).toBeNull()
  })

  it('keeps the issue block ASCII', () => {
    for (const issue of JUDGE_UPSTREAM_ISSUES) {
      const text = issue.label + ' ' + (issue.note ?? '')
      expect([...text].every((char) => char.charCodeAt(0) < 128), issue.label).toBe(true)
    }
  })
})

describe('every link on the judges page', () => {
  it('is counted, labelled and safe, with no empty or script href', () => {
    const links = [
      ...JUDGES_BRANDS.map((brand) => ({ label: brand.name, href: brand.href })),
      ...JUDGE_BRAND_LINKS,
      ...JUDGE_PRODUCT_LINKS,
      ...JUDGE_COPY_LINKS,
      ...JUDGE_UPSTREAM_ISSUES,
    ]
    expect(links).toHaveLength(24)
    for (const link of links) {
      expect(link.label.trim().length).toBeGreaterThan(0)
      expect(link.href).not.toBe('')
      expect(link.href.toLowerCase()).not.toContain('javascript:')
      expect(isSafeExternalHref(link.href), link.label).toBe(true)
    }
  })
})

describe('isSafeExternalHref', () => {
  it('accepts absolute https urls only', () => {
    expect(isSafeExternalHref('https://example.com/a')).toBe(true)
  })

  it('rejects empty, relative, insecure and script urls', () => {
    for (const href of [
      '',
      '/relative',
      'http://example.com',
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      ' https://example.com',
      'https://example.com with space',
    ]) {
      expect(isSafeExternalHref(href), href).toBe(false)
    }
  })
})
