/**
 * One GPS source for the whole app.
 *
 * `useGeolocation` used to be mounted by five components, each calling
 * `navigator.geolocation` itself, and three of them separately POSTed the result
 * to `/users/me/location`. That meant duplicate permission prompts, up to five
 * concurrent position requests per page load, and several redundant writes.
 *
 * The browser position now lives here. Components read it; the store owns the
 * request, the freshness window, the iOS fallback, live tracking, and the single
 * throttled server sync.
 */
import { create } from 'zustand'
import api from '@/lib/api'

/** Reuse a recent fix instead of asking the device again. */
const FRESH_MS = 5 * 60 * 1000
/** Write to the server at most this often, however many components read us. */
const SERVER_SYNC_MS = 2 * 60 * 1000

interface LocationState {
  latitude: number | null
  longitude: number | null
  accuracy: number | null
  error: string | null
  loading: boolean
  updatedAt: number | null
  watching: boolean
  lastSyncedAt: number | null

  /** Ask the browser for a position (no-op when we already have a fresh one). */
  request: (options?: { force?: boolean }) => void
  /** Force a fresh fix (used by "refresh" buttons). */
  refresh: () => void
  /** Continuously track the device (opt-in; used for live neighbourhood). */
  startWatching: () => void
  stopWatching: () => void
  /** Record a position from any source (e.g. the consent banner). */
  setPosition: (latitude: number, longitude: number, accuracy?: number | null) => void
  clear: () => void
}

// navigator.geolocation.watchPosition returns a number in the DOM lib.
let _watchId: number | null = null

export const useLocationStore = create<LocationState>((set, get) => ({
  latitude: null,
  longitude: null,
  accuracy: null,
  error: null,
  loading: false,
  updatedAt: null,
  watching: false,
  lastSyncedAt: null,

  request: (options) => {
    const state = get()
    if (!('geolocation' in navigator)) {
      set({ error: 'Geolocation is not supported in this browser', loading: false })
      return
    }
    const fresh =
      state.updatedAt != null &&
      Date.now() - state.updatedAt < FRESH_MS &&
      state.latitude != null
    // Concurrent mounts all call request(); only the first should actually ask.
    if (!options?.force && (state.loading || fresh)) return

    set({ loading: true, error: null })

    const onSuccess = (position: GeolocationPosition) => {
      get().setPosition(
        position.coords.latitude,
        position.coords.longitude,
        position.coords.accuracy,
      )
    }

    // iOS Safari: high accuracy can fail silently or time out. Try it first,
    // then fall back to a low-accuracy fix with a longer timeout.
    const onError = (err: GeolocationPositionError) => {
      if (err.code === err.TIMEOUT || err.code === err.POSITION_UNAVAILABLE) {
        navigator.geolocation.getCurrentPosition(
          onSuccess,
          (err2) => {
            set({
              latitude: null,
              longitude: null,
              accuracy: null,
              error:
                err2.code === err2.PERMISSION_DENIED
                  ? 'Location permission denied. Enable it in your browser or device settings.'
                  : err2.message,
              loading: false,
            })
          },
          { enableHighAccuracy: false, timeout: 20000, maximumAge: 300000 },
        )
        return
      }
      set({
        error:
          err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. Enable it in your browser or device settings.'
            : err.message,
        loading: false,
      })
    }

    navigator.geolocation.getCurrentPosition(onSuccess, onError, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 60000,
    })
  },

  refresh: () => get().request({ force: true }),

  startWatching: () => {
    if (_watchId != null || !('geolocation' in navigator)) return
    _watchId = navigator.geolocation.watchPosition(
      (position) =>
        get().setPosition(
          position.coords.latitude,
          position.coords.longitude,
          position.coords.accuracy,
        ),
      () => {
        /* live tracking is best-effort; the one-shot request reports errors */
      },
      { enableHighAccuracy: false, timeout: 30000, maximumAge: 120000 },
    )
    set({ watching: true })
  },

  stopWatching: () => {
    if (_watchId != null && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(_watchId)
    }
    _watchId = null
    set({ watching: false })
  },

  setPosition: (latitude, longitude, accuracy = null) => {
    set({
      latitude,
      longitude,
      accuracy: accuracy ?? null,
      error: null,
      loading: false,
      updatedAt: Date.now(),
    })

    // The one and only server sync, throttled. Best-effort: a failure here must
    // never affect the UI.
    const last = get().lastSyncedAt ?? 0
    if (Date.now() - last > SERVER_SYNC_MS) {
      set({ lastSyncedAt: Date.now() })
      api.post('/users/me/location', { latitude, longitude }).catch(() => {})
    }
  },

  clear: () => {
    get().stopWatching()
    set({
      latitude: null,
      longitude: null,
      accuracy: null,
      error: null,
      loading: false,
      updatedAt: null,
      lastSyncedAt: null,
    })
  },
}))
