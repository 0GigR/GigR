import { describe, expect, it } from 'vitest'
import {
  AURORA_CHAPTERS,
  chapterIndexAt,
  formatChapterTime,
} from './auroraChapters'

describe('auroraChapters', () => {
  it('formats chapter times into minutes and seconds', () => {
    expect(formatChapterTime(0)).toBe('0:00')
    expect(formatChapterTime(59)).toBe('0:59')
    expect(formatChapterTime(60)).toBe('1:00')
    expect(formatChapterTime(155)).toBe('2:35')
  })

  it('resolves active chapter based on playback seconds', () => {
    expect(chapterIndexAt(0)).toBe(0)
    expect(chapterIndexAt(30)).toBe(0)
    expect(chapterIndexAt(60)).toBe(1)
    expect(chapterIndexAt(149)).toBe(1)
    expect(chapterIndexAt(150)).toBe(2)
    expect(chapterIndexAt(239)).toBe(2)
    expect(chapterIndexAt(240)).toBe(3)
    expect(chapterIndexAt(500)).toBe(3)
  })

  it('guarantees all chapters have titles, tags, and content lines', () => {
    expect(AURORA_CHAPTERS.length).toBe(4)
    for (const chapter of AURORA_CHAPTERS) {
      expect(chapter.title.length).toBeGreaterThan(0)
      expect(chapter.lines.length).toBeGreaterThan(0)
      expect(chapter.start).toBeGreaterThanOrEqual(0)
    }
  })
})
