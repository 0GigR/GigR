import { useState, useEffect } from 'react'
import { Bell, BellRing, X, Loader2, Settings, Smartphone } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { subscribeToPushNotifications, syncPushSubscription } from '@/lib/push'

type PushState = 'unsupported' | 'denied' | 'granted' | 'default' | 'ios-browser' | 'disconnected'

function currentPushState(): PushState {
  // iOS Safari in the regular browser does not support Web Push at all —
  // it only works inside the installed PWA (home screen app) on iOS 16.4+.
  // Detect it before the PushManager check so we can tell the user to install.
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  const isStandalone = (window.navigator as any).standalone === true
  if (isIOS && !isStandalone) return 'ios-browser'
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported'
  return (Notification.permission as PushState) || 'default'
}

/**
 * Always-visible prompt to enable web push notifications.
 *
 * Mirrors the location flow: it asks automatically on page load (when the
 * browser allows it) instead of hiding behind the bell panel, and if the
 * browser suppressed the native dialog it stays visible with an Enable
 * button — a user gesture, which is what actually makes Chrome/Firefox show
 * the native permission prompt. "Not now" only dismisses for this session;
 * next visit it asks again whenever push is not currently enabled.
 *
 * It never hides silently when push is broken: on iOS Safari (browser) it
 * explains that push only works in the installed app, and when permission is
 * granted but the subscription is gone (expired token, cleared data) it
 * re-subscribes automatically.
 */
export default function PushPromptBanner() {
  const { user } = useAuthStore()
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem('gigr-push-prompt-dismissed') === '1'
  )
  const [state, setState] = useState<PushState>('default')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!user) return
    let cancelled = false

    const init = async () => {
      const s = currentPushState()

      // Never asked yet — auto-request on load, exactly like the location
      // prompt. Chrome ignores non-gesture requests, so if nothing happens
      // the banner stays visible and the Enable button re-triggers it.
      if (s === 'default') {
        try {
          const p = (await Notification.requestPermission()) as PushState
          if (cancelled) return
          if (p === 'granted') {
            const ok = await syncPushSubscription()
            if (!cancelled) setState(ok ? 'granted' : 'disconnected')
          } else {
            setState(p)
          }
        } catch {
          if (!cancelled) setState('default')
        }
        return
      }

      // Permission granted — make sure a real subscription exists and is
      // saved to the backend. If it's gone (expired FCM token, cleared site
      // data) sync re-creates it silently; if that fails, surface the banner
      // so the user can re-enable.
      if (s === 'granted') {
        const ok = await syncPushSubscription()
        if (!cancelled) setState(ok ? 'granted' : 'disconnected')
        return
      }

      setState(s)
    }

    init()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  if (!user || dismissed || state === 'granted') return null

  const handleEnable = async () => {
    setBusy(true)
    try {
      // In the disconnected state the browser may hold a dead subscription
      // (expired token) that subscribe() would just hand back — drop it so a
      // fresh one is created.
      if (state === 'disconnected') {
        const reg = await navigator.serviceWorker.ready
        const existing = await reg.pushManager.getSubscription()
        if (existing) await existing.unsubscribe()
      }
      const ok = await subscribeToPushNotifications()
      // Never hide on a failed save: permission may be granted while the
      // subscription still isn't on the server, which used to look "enabled"
      // while nothing ever arrived.
      setState(ok ? 'granted' : 'disconnected')
    } finally {
      setBusy(false)
    }
  }

  const handleDismiss = () => {
    sessionStorage.setItem('gigr-push-prompt-dismissed', '1')
    setDismissed(true)
  }

  const denied = state === 'denied'
  const disconnected = state === 'disconnected'
  const iosBrowser = state === 'ios-browser'

  return (
    <div className="sticky top-14 z-[60] bg-gray-900 px-4 py-3 text-white flex items-center justify-between gap-3 text-sm shadow-sm">
      <div className="flex items-center gap-2 min-w-0">
        {iosBrowser ? (
          <Smartphone className="w-4 h-4 shrink-0 text-violet-300" />
        ) : (
          <BellRing className="w-4 h-4 shrink-0 text-violet-300" />
        )}
        <div className="min-w-0">
          <p className="font-semibold truncate">
            {denied ? 'Notifications are blocked' : iosBrowser ? 'Get notifications on iPhone' : disconnected ? 'Notifications need reconnecting' : 'Turn on notifications'}
          </p>
          <p className="text-xs text-gray-300 truncate">
            {denied
              ? 'Enable notifications for Gigr in your browser/device settings to never miss messages or payments.'
              : iosBrowser
                ? 'On iPhone, push only works in the installed app. Tap Share, then Add to Home Screen, open the app and enable notifications there.'
                : disconnected
                  ? 'Push permission is on but the subscription expired. Tap Enable to reconnect instantly.'
                  : 'Get pinged instantly for new messages, applicants, and payments.'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!denied && !iosBrowser && (
          <button
            onClick={handleEnable}
            disabled={busy}
            className="inline-flex items-center gap-1.5 bg-white text-gray-900 px-3 py-1.5 rounded font-medium hover:bg-gray-100 transition-colors disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
            {busy ? 'Enabling...' : disconnected ? 'Reconnect' : 'Enable'}
          </button>
        )}
        {denied && (
          <span className="inline-flex items-center gap-1.5 text-xs text-gray-300">
            <Settings className="w-3.5 h-3.5" /> Browser settings
          </span>
        )}
        <button onClick={handleDismiss} className="opacity-60 hover:opacity-100 p-1" title="Not now">
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
