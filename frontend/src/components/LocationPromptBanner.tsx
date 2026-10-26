import { useState, useEffect } from 'react'
import { MapPin, X, Loader2 } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { useGeolocation } from '@/hooks/useGeolocation'
import { useLocationStore } from '@/store/locationStore'
import api from '@/lib/api'

const LAST_PROMPT_KEY = 'gigr-location-prompt-last'
const REASK_AFTER_DAYS = 7

/**
 * Periodic nudge to share the user's public location.
 *
 * Only appears when location sharing is currently OFF, and at most once every
 * REASK_AFTER_DAYS per browser (localStorage). "Not now" dismisses for the
 * period; "Enable" requests the browser location and flips location_public on.
 */
export default function LocationPromptBanner({ enabled = true }: { enabled?: boolean } = {}) {
  const { user, fetchUser } = useAuthStore()
  const geo = useGeolocation()
  const [visible, setVisible] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!user) return
    if ((user as any)?.location_public) return
    if (!navigator.geolocation) return

    let last = 0
    try {
      last = parseInt(localStorage.getItem(LAST_PROMPT_KEY) || '0', 10)
    } catch {
      last = 0
    }
    const due = Date.now() - last > REASK_AFTER_DAYS * 24 * 60 * 60 * 1000
    setVisible(due)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id, (user as any)?.location_public])

  const dismiss = () => {
    try {
      localStorage.setItem(LAST_PROMPT_KEY, String(Date.now()))
    } catch {
      /* ignore */
    }
    setVisible(false)
  }

  const handleEnable = async () => {
    setBusy(true)
    setError(null)
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error('Geolocation not supported'))
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 120000,
        })
      })
      // Seed the shared store, which performs the (throttled) location sync —
      // the banner keeps its own opt-in PATCH of `location_public` below.
      useLocationStore
        .getState()
        .setPosition(position.coords.latitude, position.coords.longitude, position.coords.accuracy)
      await api.patch('/users/me', { location_public: true })
      await fetchUser()
      try {
        localStorage.setItem(LAST_PROMPT_KEY, String(Date.now()))
      } catch {
        /* ignore */
      }
      setVisible(false)
    } catch (err: any) {
      setError(
        err?.code === 1 || /denied/i.test(String(err?.message || err))
          ? 'Location permission was blocked. Allow it in your browser settings to share your location.'
          : 'Could not get your location. Please try again.'
      )
      // Don't nag again immediately after a failed attempt.
      dismiss()
    } finally {
      setBusy(false)
    }
  }

  if (!enabled || !visible || !user || (user as any)?.location_public) return null
  void geo // geolocation hook kept for future use; enabling requests fresh position

  return (
    <div className="sticky top-14 z-[60] bg-indigo-600 px-4 py-3 text-white flex items-center justify-between gap-3 text-sm shadow-sm">
      <div className="flex items-center gap-2 min-w-0">
        <MapPin className="w-4 h-4 shrink-0 text-indigo-200" />
        <div className="min-w-0">
          <p className="font-semibold truncate">Share your location?</p>
          <p className="text-xs text-indigo-200 truncate">
            {error || 'Show jobs and providers near you. Your exact address stays private.'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          onClick={handleEnable}
          disabled={busy}
          className="inline-flex items-center gap-1.5 bg-white dark:bg-card text-indigo-600 dark:text-indigo-400 px-3 py-1.5 rounded font-medium hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition-colors disabled:opacity-60"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />}
          {busy ? 'Locating...' : 'Enable'}
        </button>
        <button onClick={dismiss} className="opacity-70 hover:opacity-100 p-1" title="Not now">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
