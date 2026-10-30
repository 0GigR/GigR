import { describe, expect, it } from 'vitest'
import {
  AUTOPLAY_VISIBLE_RATIO,
  didAutoplayStart,
  playbackCommand,
} from './judgesPlayback'
import type { PlaybackGate } from './judgesPlayback'

/** A ready, paused, visible player with no reason to hold back. */
const clear: PlaybackGate = {
  visibleRatio: 1,
  isReady: true,
  isPlaying: false,
  ended: false,
  reducedMotion: false,
  userPaused: false,
  autoplayRefused: false,
}

const gate = (patch: Partial<PlaybackGate>): PlaybackGate => ({ ...clear, ...patch })

describe('judges autoplay gate', () => {
  it('requires 60 percent of the player to be visible', () => {
    expect(AUTOPLAY_VISIBLE_RATIO).toBe(0.6)
    expect(playbackCommand(gate({ visibleRatio: 0.599 }))).toBe('idle')
    expect(playbackCommand(gate({ visibleRatio: 0.6 }))).toBe('play')
    expect(playbackCommand(gate({ visibleRatio: 1 }))).toBe('play')
  })

  it('does nothing until the player exists', () => {
    expect(playbackCommand(gate({ isReady: false, visibleRatio: 0 }))).toBe('idle')
    expect(playbackCommand(gate({ isReady: false }))).toBe('idle')
  })

  it('pauses a playing video that scrolls out of view', () => {
    expect(playbackCommand(gate({ isPlaying: true, visibleRatio: 0.2 }))).toBe('pause')
    expect(playbackCommand(gate({ isPlaying: true, visibleRatio: 0 }))).toBe('pause')
  })

  it('leaves an already playing video alone while it is visible', () => {
    expect(playbackCommand(gate({ isPlaying: true }))).toBe('idle')
  })

  it('never restarts a video the viewer paused', () => {
    expect(playbackCommand(gate({ userPaused: true }))).toBe('idle')
    expect(playbackCommand(gate({ userPaused: true, visibleRatio: 0.9 }))).toBe('idle')
    // Restored by an explicit play, never by scrolling.
    expect(playbackCommand(gate({ userPaused: false }))).toBe('play')
  })

  it('does not autoplay under prefers-reduced-motion', () => {
    expect(playbackCommand(gate({ reducedMotion: true }))).toBe('idle')
    expect(playbackCommand(gate({ reducedMotion: true, isPlaying: true }))).toBe('idle')
    // A reduced-motion viewer who scrolls away still gets the video paused.
    expect(
      playbackCommand(gate({ reducedMotion: true, isPlaying: true, visibleRatio: 0.1 })),
    ).toBe('pause')
  })

  it('leaves a refused autoplay paused until the viewer presses play', () => {
    expect(playbackCommand(gate({ autoplayRefused: true }))).toBe('idle')
    expect(playbackCommand(gate({ autoplayRefused: true, isPlaying: true }))).toBe(
      'idle',
    )
  })

  it('does not restart a finished video', () => {
    expect(playbackCommand(gate({ ended: true }))).toBe('idle')
    expect(playbackCommand(gate({ ended: true, isPlaying: false }))).toBe('idle')
  })
})

describe('judges autoplay refusal detection', () => {
  it('counts playing and buffering as started', () => {
    expect(didAutoplayStart(1)).toBe(true)
    expect(didAutoplayStart(3)).toBe(true)
  })

  it('counts unstarted, cued, paused and ended as not started', () => {
    expect(didAutoplayStart(-1)).toBe(false)
    expect(didAutoplayStart(5)).toBe(false)
    expect(didAutoplayStart(2)).toBe(false)
    expect(didAutoplayStart(0)).toBe(false)
  })
})
