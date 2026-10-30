/**
 * useYouTubePlayer.ts - the IFrame Player API for the /judges demo video.
 *
 * A plain iframe would be simpler, but it cannot report playback time, and the
 * chapter list and the copy panel both need getCurrentTime(). The API is
 * loaded once per document and shared by every mount.
 *
 * Time is published on a 500 ms interval and on player state changes (play,
 * pause, seek, end), which is the slowest cadence that still feels immediate
 * and is the upper bound the page is designed around. The page's callback only
 * commits when the active chapter changes, so a playing video does not
 * re-render the copy panel twice a second.
 *
 * Playback control lives here too, because only this hook can see the player's
 * state. The rules are decided by the pure gate in lib/judgesPlayback.ts and
 * executed by the callbacks below:
 *   - attemptAutoplay() always mutes first (an unmuted programmatic start is
 *     blocked by every browser), then verifies that the player really started;
 *   - a start that never happens (still unstarted, cued or paused after the
 *     grace period) is reported as an autoplay refusal so the page can show a
 *     Play button;
 *   - a pause this hook did not ask for is recorded as deliberate, so the page
 *     never resumes playback behind the viewer's back;
 *   - the viewer's sound choice is remembered and is not overridden by a later
 *     autoplay attempt.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { JUDGES_VIDEO_DURATION_SECONDS, clampSeekTime } from '@/lib/judgesChapters'
import { AUTOPLAY_GRACE_MS, didAutoplayStart } from '@/lib/judgesPlayback'

const YOUTUBE_API_SRC = 'https://www.youtube.com/iframe_api'
const YOUTUBE_SCRIPT_ID = 'youtube-iframe-api'
const POLL_INTERVAL_MS = 500

interface YouTubePlayer {
  getCurrentTime(): number
  getDuration(): number
  getIframe(): HTMLIFrameElement | null
  getPlayerState(): number
  seekTo(seconds: number, allowSeekAhead: boolean): void
  playVideo(): void
  pauseVideo(): void
  mute(): void
  unMute(): void
  isMuted(): boolean
  destroy(): void
}

interface YouTubePlayerEvent {
  target: YouTubePlayer
}

interface YouTubePlayerOptions {
  videoId: string
  width?: string
  height?: string
  playerVars?: Record<string, string | number>
  events?: {
    onReady?: (event: YouTubePlayerEvent) => void
    onStateChange?: (event: YouTubePlayerEvent & { data: number }) => void
    onError?: () => void
  }
}

interface YouTubeApi {
  Player: new (element: HTMLElement, options: YouTubePlayerOptions) => YouTubePlayer
}

declare global {
  interface Window {
    YT?: YouTubeApi
    onYouTubeIframeAPIReady?: () => void
  }
}

let apiPromise: Promise<YouTubeApi> | null = null

/** Loads https://www.youtube.com/iframe_api once and resolves with window.YT. */
export function loadYouTubeApi(): Promise<YouTubeApi> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('The YouTube player needs a browser'))
  }
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (apiPromise) return apiPromise

  apiPromise = new Promise<YouTubeApi>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady
    window.onYouTubeIframeAPIReady = () => {
      previous?.()
      if (window.YT?.Player) {
        resolve(window.YT)
      } else {
        apiPromise = null
        reject(new Error('The YouTube IFrame API loaded without a player'))
      }
    }

    // Another script or a previous mount may already have injected the tag.
    if (document.getElementById(YOUTUBE_SCRIPT_ID)) return

    const script = document.createElement('script')
    script.id = YOUTUBE_SCRIPT_ID
    script.src = YOUTUBE_API_SRC
    script.async = true
    script.onerror = () => {
      apiPromise = null
      reject(new Error('The YouTube IFrame API could not be loaded'))
    }
    document.head.appendChild(script)
  })

  return apiPromise
}

export interface YouTubePlayerHandle {
  /** Attach to the element the player should fill. */
  containerRef: RefObject<HTMLDivElement | null>
  isReady: boolean
  failed: boolean
  isPlaying: boolean
  isMuted: boolean
  /** True when the viewer paused (in the player or with our button). */
  userPaused: boolean
  /** True when a muted autoplay attempt never started. */
  autoplayRefused: boolean
  ended: boolean
  /** Seek to a chapter, resuming playback. Safe before the player is ready. */
  seekTo: (seconds: number) => void
  /** Muted programmatic start for a visible player; verifies it worked. */
  attemptAutoplay: () => void
  /** Pause because the player left the viewport. Never a user pause. */
  pauseForVisibility: () => void
  /** The viewer pressed Play: start with sound and clear every hold. */
  playFromGesture: () => void
  /** The viewer pressed Pause: hold playback until they press Play again. */
  pauseFromGesture: () => void
  toggleMute: () => void
}

export function useYouTubePlayer(
  videoId: string,
  onTime: (seconds: number) => void,
): YouTubePlayerHandle {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const playerRef = useRef<YouTubePlayer | null>(null)
  // Kept in a ref so a parent re-render cannot tear down and recreate the player.
  const onTimeRef = useRef(onTime)
  onTimeRef.current = onTime
  const pendingSeekRef = useRef<number | null>(null)
  const durationRef = useRef<number>(JUDGES_VIDEO_DURATION_SECONDS)
  const [isReady, setIsReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [isMuted, setIsMuted] = useState(true)
  const [userPaused, setUserPaused] = useState(false)
  const [autoplayRefused, setAutoplayRefused] = useState(false)
  const [ended, setEnded] = useState(false)

  // The last player state we were told about, so a pause can be classified.
  const playerStateRef = useRef(-1)
  // Mirrors isMuted for callbacks that must not depend on a stale render.
  const mutedRef = useRef(true)
  // The viewer chose a sound setting; autoplay must not override it.
  const choseSoundRef = useRef(false)
  // Pauses before this timestamp are ours (leaving the viewport), not theirs.
  const quietPauseUntilRef = useRef(0)
  const refusalTimerRef = useRef<number | null>(null)

  const applyMuted = useCallback((muted: boolean) => {
    mutedRef.current = muted
    setIsMuted(muted)
  }, [])

  useEffect(() => {
    let cancelled = false
    let timer: number | null = null
    const container = containerRef.current
    if (!container) return

    setIsReady(false)
    setFailed(false)

    function publishTime(player: YouTubePlayer | null) {
      if (!player || cancelled) return
      try {
        const seconds = player.getCurrentTime()
        onTimeRef.current(Number.isFinite(seconds) ? seconds : 0)
      } catch {
        // The player is between states; the next tick will succeed.
      }
    }

    /** Classifies a state change that the page did not ask for. */
    function handleState(state: number) {
      if (cancelled) return
      const previous = playerStateRef.current
      playerStateRef.current = state
      const playing = state === 1 || state === 3
      setIsPlaying(playing)

      if (state === 1) {
        // Playback is real: nothing is refused, finished or held any more.
        setAutoplayRefused(false)
        setEnded(false)
        setUserPaused(false)
        return
      }

      if (state === 2) {
        const wasPlaying = previous === 1 || previous === 3
        const pausedByUs = performance.now() < quietPauseUntilRef.current
        if (wasPlaying && !pausedByUs) setUserPaused(true)
        return
      }

      if (state === 0) {
        setEnded(true)
        setIsPlaying(false)
      }
    }

    loadYouTubeApi()
      .then((YT) => {
        if (cancelled) return

        // YouTube replaces the element it is given with its own iframe. Give it
        // a private child so a StrictMode remount never hands it a detached
        // node and leaves the page with no visible player.
        const mount = document.createElement('div')
        container.appendChild(mount)

        new YT.Player(mount, {
          videoId,
          width: '100%',
          height: '100%',
          playerVars: {
            rel: 0,
            playsinline: 1,
            modestbranding: 1,
            enablejsapi: 1,
            origin: window.location.origin,
            // The player is born muted: this is what makes a programmatic
            // start legal, and the page shows the state as "Sound off".
            mute: 1,
          },
          events: {
            onReady: (event) => {
              if (cancelled) return
              const player = event.target
              playerRef.current = player
              const frame = player.getIframe()
              if (frame) frame.setAttribute('title', 'Gigr demo video')
              try {
                const reported = player.getDuration()
                if (Number.isFinite(reported) && reported > 0) {
                  durationRef.current = reported
                }
                applyMuted(player.isMuted())
              } catch {
                // Keep the fallback duration and the known muted start.
              }
              const pending = pendingSeekRef.current
              if (pending !== null) {
                pendingSeekRef.current = null
                try {
                  player.seekTo(clampSeekTime(pending, durationRef.current), true)
                } catch {
                  // A seek before the stream is ready is retried by the user.
                }
              }
              setIsReady(true)
              publishTime(player)
              timer = window.setInterval(() => publishTime(playerRef.current), POLL_INTERVAL_MS)
            },
            onStateChange: (event) => {
              publishTime(playerRef.current)
              handleState(event.data)
            },
            onError: () => {
              if (!cancelled) setFailed(true)
            },
          },
        })
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })

    return () => {
      cancelled = true
      if (timer !== null) window.clearInterval(timer)
      if (refusalTimerRef.current !== null) {
        window.clearTimeout(refusalTimerRef.current)
        refusalTimerRef.current = null
      }
      playerStateRef.current = -1
      const player = playerRef.current
      playerRef.current = null
      if (player) {
        try {
          player.destroy()
        } catch {
          // The iframe may already be gone.
        }
      }
      // If the API resolved but creation failed, no player owns the mount.
      while (container.firstChild) container.removeChild(container.firstChild)
    }
  }, [videoId, applyMuted])

  const seekTo = useCallback((seconds: number) => {
    const target = clampSeekTime(seconds, durationRef.current)
    setUserPaused(false)
    setAutoplayRefused(false)
    setEnded(false)
    const player = playerRef.current
    if (!player) {
      pendingSeekRef.current = target
      return
    }
    try {
      player.seekTo(target, true)
      player.playVideo()
    } catch {
      pendingSeekRef.current = target
    }
  }, [])

  const attemptAutoplay = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    try {
      // A silent start is the only programmatic start browsers allow. Once the
      // viewer has chosen a sound setting, their choice is kept.
      if (!choseSoundRef.current) {
        player.mute()
        applyMuted(true)
      }
      player.playVideo()
    } catch {
      return
    }
    if (refusalTimerRef.current !== null) window.clearTimeout(refusalTimerRef.current)
    refusalTimerRef.current = window.setTimeout(() => {
      refusalTimerRef.current = null
      const current = playerRef.current
      if (!current) return
      // Someone paused on purpose in the meantime: that is not a refusal.
      if (performance.now() < quietPauseUntilRef.current) return
      let state = -1
      try {
        state = current.getPlayerState()
      } catch {
        // Between states; treat the silence as a refusal so the page offers Play.
      }
      if (didAutoplayStart(state)) return
      setAutoplayRefused(true)
      setIsPlaying(false)
    }, AUTOPLAY_GRACE_MS)
  }, [applyMuted])

  const pauseForVisibility = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    quietPauseUntilRef.current = performance.now() + AUTOPLAY_GRACE_MS
    if (refusalTimerRef.current !== null) {
      window.clearTimeout(refusalTimerRef.current)
      refusalTimerRef.current = null
    }
    try {
      player.pauseVideo()
    } catch {
      // Nothing to pause.
    }
    setIsPlaying(false)
  }, [])

  const playFromGesture = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    setUserPaused(false)
    setAutoplayRefused(false)
    try {
      if (ended) {
        player.seekTo(0, true)
        setEnded(false)
      }
      // A click is a gesture, so sound is allowed from here on.
      player.unMute()
      choseSoundRef.current = true
      applyMuted(false)
      player.playVideo()
    } catch {
      // Leave the Play button in place so the tap can be repeated.
    }
  }, [applyMuted, ended])

  const pauseFromGesture = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    quietPauseUntilRef.current = 0
    setUserPaused(true)
    try {
      player.pauseVideo()
    } catch {
      // The player is already gone; the flag still holds the page back.
    }
    setIsPlaying(false)
  }, [])

  const toggleMute = useCallback(() => {
    const player = playerRef.current
    if (!player) return
    let mutedNow = mutedRef.current
    try {
      mutedNow = player.isMuted()
    } catch {
      // Fall back to the mirrored value.
    }
    if (mutedNow) {
      try {
        player.unMute()
      } catch {
        return
      }
      choseSoundRef.current = true
      applyMuted(false)
    } else {
      try {
        player.mute()
      } catch {
        return
      }
      choseSoundRef.current = false
      applyMuted(true)
    }
  }, [applyMuted])

  return {
    containerRef,
    isReady,
    failed,
    isPlaying,
    isMuted,
    userPaused,
    autoplayRefused,
    ended,
    seekTo,
    attemptAutoplay,
    pauseForVisibility,
    playFromGesture,
    pauseFromGesture,
    toggleMute,
  }
}
