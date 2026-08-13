import { useState, useEffect } from 'react'
import { Bell, BellRing, X, Loader2, Settings } from 'lucide-react'
import { useAuthStore } from '@/store/authStore'
import { subscribeToPushNotifications } from '@/lib/push'

type PushState = 'unsupported' | 'denied' | 'granted' | 'default'

function currentPushState(): PushState {
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
 */
export default function PushPromptBanner() {
  const { user } = useAuthStore()
  const [dismissed, setDismissed] = useState(
    () => sessionStorage.getItem('gigr-push-prompt-dismissed') === '1'
  )
  const [state, setState] = useState<PushState>('default')
  const [busy, setBusy] = useState(false)

  // Auto-ask on load when permission is unset, exactly like the location
  // prompt. If the browser ignores the non-gesture request (Chrome does),
  // the banner below remains and the Enable button re-triggers it properly.
  useEffect(() => {
    if (!user) return
    const s = currentPushState()
    setState(s)
    if (s === 'default') {
      Notification.requestPermission()
        .then((p) => setState(p as PushState))
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

  if (!user || dismissed || state === 'granted' || state === 'unsupported') return null

  const handleEnable = async () => {
    setBusy(true)
    try {
      const ok = await subscribeToPushNotifications()
      setState(ok ? 'granted' : currentPushState())
    } finally {
      setBusy(false)
    }
  }

  const handleDismiss = () => {
    sessionStorage.setItem('gigr-push-prompt-dismissed', '1')
    setDismissed(true)
  }

  const denied = state === 'denied'

  return (
    <div className="sticky top-14 z-[60] bg-gray-900 px-4 py-3 text-white flex items-center justify-between gap-3 text-sm shadow-sm">
      <div className="flex items-center gap-2 min-w-0">
        <BellRing className="w-4 h-4 shrink-0 text-violet-300" />
        <div className="min-w-0">
          <p className="font-semibold truncate">
            {denied ? 'Notifications are blocked' : 'Turn on notifications'}
          </p>
          <p className="text-xs text-gray-300 truncate">
            {denied
              ? 'Enable notifications for Gigr in your browser/device settings to never miss messages or payments.'
              : 'Get pinged instantly for new messages, applicants, and payments.'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {!denied && (
          <button
            onClick={handleEnable}
            disabled={busy}
            className="inline-flex items-center gap-1.5 bg-white text-gray-900 px-3 py-1.5 rounded font-medium hover:bg-gray-100 transition-colors disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
            {busy ? 'Enabling...' : 'Enable'}
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
