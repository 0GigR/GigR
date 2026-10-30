import { describe, expect, it } from 'vitest'
import {
  JUDGES_BRANDS,
  JUDGES_STATS,
  JUDGE_BRAND_LINKS,
  JUDGE_PRODUCT_LINKS,
} from './judgesContent'

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
