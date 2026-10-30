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
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject } from 'react'
import { JUDGES_VIDEO_DURATION_SECONDS, clampSeekTime } from '@/lib/judgesChapters'

const YOUTUBE_API_SRC = 'https://www.youtube.com/iframe_api'
const YOUTUBE_SCRIPT_ID = 'youtube-iframe-api'
const POLL_INTERVAL_MS = 500

interface YouTubePlayer {
  getCurrentTime(): number
  getDuration(): number
  getIframe(): HTMLIFrameElement | null
  seekTo(seconds: number, allowSeekAhead: boolean): void
  playVideo(): void
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
    onStateChange?: (event: { target: YouTubePlayer }) => void
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
  /** Seek to a chapter, resuming playback. Safe before the player is ready. */
  seekTo: (seconds: number) => void
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
              } catch {
                // Keep the fallback duration.
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
            onStateChange: () => publishTime(playerRef.current),
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
  }, [videoId])

  const seekTo = useCallback((seconds: number) => {
    const target = clampSeekTime(seconds, durationRef.current)
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

  return { containerRef, isReady, failed, seekTo }
}
