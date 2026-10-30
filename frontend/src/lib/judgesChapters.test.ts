import { describe, expect, it } from 'vitest'
import {
  JUDGES_CHAPTERS,
  JUDGES_VIDEO_DURATION_SECONDS,
  chapterIndexAt,
  clampSeekTime,
  formatChapterTime,
  type JudgesChapter,
} from './judgesChapters'

const ADVERTISED = [
  { title: 'Intro', start: 0, label: '0:00', tag: null },
  { title: 'Walrus memory', start: 46, label: '0:46', tag: 'Walrus Memory / MemWal' },
  { title: 'Tatum integration', start: 200, label: '3:20', tag: 'Tatum / Sui' },
  { title: 'x402 agent payments', start: 272, label: '4:32', tag: 'x402 / agent payments' },
] as const

// Confirmed length of the submission video: 6:18, 378 seconds. The page uses
// this only as a fallback; the player's own duration replaces it at runtime.
const VIDEO_DURATION_SECONDS = JUDGES_VIDEO_DURATION_SECONDS

const CUSTOM_TIMELINE: readonly JudgesChapter[] = [
  { id: 'intro', title: 'A', tag: null, start: 0, lines: [] },
  { id: 'memory', title: 'B', tag: null, start: 10, lines: [] },
  { id: 'tatum', title: 'C', tag: null, start: 20, lines: [] },
]

describe('judges chapter timeline', () => {
  it('maps each chapter to the exact timestamp shown on the page', () => {
    expect(JUDGES_CHAPTERS.map((chapter) => [chapter.title, chapter.start])).toEqual(
      ADVERTISED.map((chapter) => [chapter.title, chapter.start]),
    )
  })

  it('formats those timestamps as the button labels', () => {
    expect(JUDGES_CHAPTERS.map((chapter) => formatChapterTime(chapter.start))).toEqual(
      ADVERTISED.map((chapter) => chapter.label),
    )
  })

  it('tags each chapter with the brand it is about', () => {
    expect(JUDGES_CHAPTERS.map((chapter) => chapter.tag)).toEqual(
      ADVERTISED.map((chapter) => chapter.tag),
    )
  })

  it('leaves only Intro untagged', () => {
    expect(JUDGES_CHAPTERS[0].tag).toBeNull()
    for (const chapter of JUDGES_CHAPTERS.slice(1)) {
      expect(chapter.tag).not.toBeNull()
      expect(chapter.tag?.length).toBeGreaterThan(0)
    }
  })

  it('keeps the chapters in strict start order', () => {
    for (let index = 1; index < JUDGES_CHAPTERS.length; index += 1) {
      expect(JUDGES_CHAPTERS[index].start).toBeGreaterThan(JUDGES_CHAPTERS[index - 1].start)
    }
  })

  it('starts the final chapter before the video ends', () => {
    const last = JUDGES_CHAPTERS[JUDGES_CHAPTERS.length - 1]
    expect(last.start).toBeLessThan(VIDEO_DURATION_SECONDS)
  })

  it('gives every chapter between five and eight short lines', () => {
    for (const chapter of JUDGES_CHAPTERS) {
      expect(chapter.lines.length).toBeGreaterThanOrEqual(5)
      expect(chapter.lines.length).toBeLessThanOrEqual(8)
      for (const line of chapter.lines) {
        expect(line.trim().length).toBeGreaterThan(20)
      }
    }
  })

  it('keeps every visible chapter string ASCII', () => {
    const visible = JUDGES_CHAPTERS.flatMap((chapter) => [chapter.title, ...chapter.lines])
    for (const text of visible) {
      expect(text).not.toMatch(/[^\x00-\x7F]/)
    }
  })
})

describe('chapterIndexAt', () => {
  it.each([
    [-30, 0],
    [0, 0],
    [45.999, 0],
    [46, 1],
    [199.999, 1],
    [200, 2],
    [271.999, 2],
    [272, 3],
    [377.999, 3],
    [VIDEO_DURATION_SECONDS, 3],
    [Number.MAX_SAFE_INTEGER, 3],
  ])('selects the chapter playing at %s seconds', (seconds, expected) => {
    expect(chapterIndexAt(seconds)).toBe(expected)
  })

  it('covers every second of the video with exactly one chapter', () => {
    for (let second = 0; second < VIDEO_DURATION_SECONDS; second += 1) {
      const expected = second < 46 ? 0 : second < 200 ? 1 : second < 272 ? 2 : 3
      expect(chapterIndexAt(second)).toBe(expected)
    }
  })

  it('never invents a fifth chapter after the video ends', () => {
    expect(chapterIndexAt(VIDEO_DURATION_SECONDS)).toBe(JUDGES_CHAPTERS.length - 1)
    expect(chapterIndexAt(VIDEO_DURATION_SECONDS + 10_000)).toBe(JUDGES_CHAPTERS.length - 1)
  })

  it('falls back to the first chapter for non-finite times', () => {
    expect(chapterIndexAt(Number.NaN)).toBe(0)
    expect(chapterIndexAt(Number.POSITIVE_INFINITY)).toBe(0)
    expect(chapterIndexAt(Number.NEGATIVE_INFINITY)).toBe(0)
  })

  it('uses the supplied timeline instead of the built-in one', () => {
    expect(chapterIndexAt(5, CUSTOM_TIMELINE)).toBe(0)
    expect(chapterIndexAt(10, CUSTOM_TIMELINE)).toBe(1)
    expect(chapterIndexAt(19.9, CUSTOM_TIMELINE)).toBe(1)
    expect(chapterIndexAt(20, CUSTOM_TIMELINE)).toBe(2)
  })
})

describe('clampSeekTime', () => {
  it('leaves in-range seeks untouched', () => {
    expect(clampSeekTime(0)).toBe(0)
    expect(clampSeekTime(272)).toBe(272)
    expect(clampSeekTime(VIDEO_DURATION_SECONDS)).toBe(VIDEO_DURATION_SECONDS)
  })

  it('clamps past the end of the video', () => {
    expect(clampSeekTime(VIDEO_DURATION_SECONDS + 1)).toBe(VIDEO_DURATION_SECONDS)
    expect(clampSeekTime(10_000)).toBe(VIDEO_DURATION_SECONDS)
  })

  it('clamps before the start and invalid times to zero', () => {
    expect(clampSeekTime(-1)).toBe(0)
    expect(clampSeekTime(Number.NaN)).toBe(0)
    expect(clampSeekTime(Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('prefers the duration the player reports', () => {
    expect(clampSeekTime(150, 100)).toBe(100)
    expect(clampSeekTime(90, 100)).toBe(90)
    expect(clampSeekTime(500, 0)).toBe(VIDEO_DURATION_SECONDS)
  })

  it('keeps every chapter seek inside the confirmed duration', () => {
    for (const chapter of JUDGES_CHAPTERS) {
      expect(clampSeekTime(chapter.start)).toBe(chapter.start)
      expect(clampSeekTime(chapter.start)).toBeLessThanOrEqual(VIDEO_DURATION_SECONDS)
    }
  })
})

describe('formatChapterTime', () => {
  it.each([
    [0, '0:00'],
    [9, '0:09'],
    [46, '0:46'],
    [59, '0:59'],
    [60, '1:00'],
    [200, '3:20'],
    [272, '4:32'],
    [377, '6:17'],
    [378, '6:18'],
    [3599, '59:59'],
    [3600, '60:00'],
  ])('formats %s seconds as %s', (seconds, expected) => {
    expect(formatChapterTime(seconds)).toBe(expected)
  })

  it('rounds partial seconds down rather than up', () => {
    expect(formatChapterTime(59.99)).toBe('0:59')
    expect(formatChapterTime(200.9)).toBe('3:20')
  })

  it('clamps invalid input to 0:00', () => {
    expect(formatChapterTime(-5)).toBe('0:00')
    expect(formatChapterTime(Number.NaN)).toBe('0:00')
    expect(formatChapterTime(Number.POSITIVE_INFINITY)).toBe('0:00')
  })
})
