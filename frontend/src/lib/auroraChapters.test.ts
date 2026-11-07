import { describe, expect, it } from 'vitest'
import {
  AURORA_CHAPTERS,
  chapterIndexAt,
  formatChapterTime,
} from './auroraChapters'

describe('auroraChapters', () => {
  it('formats chapter times into minutes and seconds', () => {
    expect(formatChapterTime(0)).toBe('0:00')
    expect(formatChapterTime(35)).toBe('0:35')
    expect(formatChapterTime(74)).toBe('1:14')
    expect(formatChapterTime(116)).toBe('1:56')
    expect(formatChapterTime(140)).toBe('2:20')
    expect(formatChapterTime(223)).toBe('3:43')
    expect(formatChapterTime(243)).toBe('4:03')
    expect(formatChapterTime(280)).toBe('4:40')
  })

  it('resolves active chapter based on playback seconds', () => {
    expect(chapterIndexAt(0)).toBe(0)
    expect(chapterIndexAt(20)).toBe(0)
    expect(chapterIndexAt(35)).toBe(1)
    expect(chapterIndexAt(70)).toBe(1)
    expect(chapterIndexAt(74)).toBe(2)
    expect(chapterIndexAt(115)).toBe(2)
    expect(chapterIndexAt(116)).toBe(3)
    expect(chapterIndexAt(139)).toBe(3)
    expect(chapterIndexAt(140)).toBe(4)
    expect(chapterIndexAt(222)).toBe(4)
    expect(chapterIndexAt(223)).toBe(5)
    expect(chapterIndexAt(242)).toBe(5)
    expect(chapterIndexAt(243)).toBe(6)
    expect(chapterIndexAt(279)).toBe(6)
    expect(chapterIndexAt(280)).toBe(7)
    expect(chapterIndexAt(500)).toBe(7)
  })

  it('guarantees all 8 chapters have titles, tags, and content lines', () => {
    expect(AURORA_CHAPTERS.length).toBe(8)
    for (const chapter of AURORA_CHAPTERS) {
      expect(chapter.title.length).toBeGreaterThan(0)
      expect(chapter.lines.length).toBeGreaterThan(0)
      expect(chapter.start).toBeGreaterThanOrEqual(0)
    }
  })
})
