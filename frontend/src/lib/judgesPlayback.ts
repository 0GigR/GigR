/**
 * judgesPlayback.ts - when the /judges demo video may start or stop itself.
 *
 * The page owns the IntersectionObserver and the player owns its own state;
 * both feed this one pure decision, so the autoplay rules are testable without
 * a browser, a YouTube iframe or a timer. The gate is deliberately written as
 * a list of refusals: every reason a player must NOT start itself is checked
 * before the single reason it may.
 *
 * Player states reported by the YouTube IFrame API, which is the only playback
 * signal it gives us: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering,
 * 5 video cued.
 */

/** The player must be at least this visible before it starts itself. */
export const AUTOPLAY_VISIBLE_RATIO = 0.6

/** How long an autoplay attempt gets to reach playing or buffering. */
export const AUTOPLAY_GRACE_MS = 1600

export type PlaybackCommand = 'play' | 'pause' | 'idle'

export interface PlaybackGate {
  /** Share of the player frame inside the viewport, 0 to 1. */
  visibleRatio: number
  isReady: boolean
  isPlaying: boolean
  ended: boolean
  reducedMotion: boolean
  userPaused: boolean
  autoplayRefused: boolean
}

/**
 * What the page should do about playback right now.
 *
 * `play` is always a muted start (the caller mutes first): browsers only allow
 * a programmatic start when it is silent. A deliberate pause, a finished
 * video, a refused start and prefers-reduced-motion all win over visibility,
 * so scrolling can never undo a decision the viewer made.
 */
export function playbackCommand(gate: PlaybackGate): PlaybackCommand {
  if (!gate.isReady) return 'idle'
  if (gate.visibleRatio < AUTOPLAY_VISIBLE_RATIO) {
    return gate.isPlaying ? 'pause' : 'idle'
  }
  if (gate.ended || gate.reducedMotion || gate.userPaused || gate.autoplayRefused) {
    return 'idle'
  }
  return gate.isPlaying ? 'idle' : 'play'
}

/**
 * True once the player has really started. Buffering counts: YouTube reports
 * 3 while it fetches the first frames, and treating that as a refusal would
 * show a Play button over a video that is about to play.
 */
export function didAutoplayStart(state: number): boolean {
  return state === 1 || state === 3
}
