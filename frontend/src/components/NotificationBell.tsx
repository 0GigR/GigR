import { useState, useEffect } from 'react'
import { Bell, CheckCircle2, BellOff, Loader2, Smartphone } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import api from '@/lib/api'
import { Link } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { subscribeToPushNotifications } from '@/lib/push'
import { toast } from 'sonner'

import { formatDistanceToNow } from 'date-fns'

export interface Notification {
  id: string
  title: string
  message: string
  link?: string
  is_read: boolean
  created_at: string
}

function getPushState(): 'unsupported' | 'denied' | 'granted' | 'default' | 'ios-browser' {
  // iOS Safari in regular browser doesn't support Web Push at all
  // Only works when installed as a PWA (home screen app) on iOS 16.4+
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  const isStandalone = (window.navigator as any).standalone === true
  if (isIOS && !isStandalone) return 'ios-browser'
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported'
  return (Notification.permission as any) || 'default'
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [pushState, setPushState] = useState<ReturnType<typeof getPushState>>('default')
  const [subscribing, setSubscribing] = useState(false)
  const queryClient = useQueryClient()
  const { user } = useAuthStore()

  useEffect(() => {
    setPushState(getPushState())
  }, [open])

  // Polling notifications every 15s
  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ['notifications'],
    queryFn: async () => {
      const { data } = await api.get('/notifications/')
      return data
    },
    refetchInterval: 15000,
    enabled: !!user,
  })

  const markAllReadMutation = useMutation({
    mutationFn: async () => {
      await api.post('/notifications/read-all')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
      setOpen(false)
    },
  })

  const handleSubscribe = async () => {
    setSubscribing(true)
    try {
      const success = await subscribeToPushNotifications()
      if (success) {
        setPushState('granted')
        toast.success('Push notifications enabled!')
      } else {
        // Check if it's a permission denial
        const state = getPushState()
        setPushState(state)
        if (state === 'denied') {
          toast.error('Notifications blocked. Go to your browser/device settings and allow notifications for this site.')
        } else {
          toast.error('Could not enable push notifications. Please try again.')
        }
      }
    } finally {
      setSubscribing(false)
    }
  }

  const unreadCount = notifications.filter(n => !n.is_read).length

  // A notification counts as a "failure" if its text signals something went wrong.
  // Only these turn the badge red; everything else is a calm purple.
  const isFailure = (n: Notification) =>
    /\b(fail(?:ed|ure)?|error|unable|couldn'?t|could not|declined|rejected|cancell?ed)\b/i.test(
      `${n.title} ${n.message}`
    )
  const hasUnreadFailure = notifications.some(n => !n.is_read && isFailure(n))

  // Opening the panel is itself an acknowledgement — clear the badge server-side
  // so the user doesn't have to press "Mark all read".
  useEffect(() => {
    if (open && unreadCount > 0) {
      api.post('/notifications/read-all')
        .then(() => queryClient.invalidateQueries({ queryKey: ['notifications'] }))
        .catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const renderPushBanner = () => {
    if (pushState === 'granted') {
      return (
        <div className="p-3 border-t border-gray-100 dark:border-gray-800 bg-green-50 dark:bg-green-900/20 flex items-center gap-2 justify-center text-xs text-green-700 dark:text-green-400 shrink-0">
          <CheckCircle2 className="w-3.5 h-3.5" />
          Push notifications are enabled
        </div>
      )
    }
    if (pushState === 'denied') {
      return (
        <div className="p-3 border-t border-gray-100 dark:border-gray-800 bg-red-50 dark:bg-red-900/20 shrink-0">
          <div className="flex items-center gap-2 text-xs text-red-600 dark:text-red-400 justify-center">
            <BellOff className="w-3.5 h-3.5 shrink-0" />
            Notifications blocked. Enable in browser/device settings.
          </div>
        </div>
      )
    }
    if (pushState === 'ios-browser') {
      return (
        <div className="p-3 border-t border-gray-100 dark:border-gray-800 bg-blue-50 dark:bg-blue-900/20 shrink-0">
          <div className="flex items-start gap-2 text-xs text-blue-700 dark:text-blue-300">
            <Smartphone className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              On iOS, tap <strong>Share → Add to Home Screen</strong> to install the app, then enable notifications inside it.
            </span>
          </div>
        </div>
      )
    }
    if (pushState === 'unsupported') {
      return (
        <div className="p-3 border-t text-center text-xs text-gray-400 shrink-0">
          Push notifications not supported in this browser.
        </div>
      )
    }
    // default — not yet asked
    return (
      <div className="p-3 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 text-center shrink-0">
        <button
          onClick={handleSubscribe}
          disabled={subscribing}
          className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 font-medium disabled:opacity-60"
        >
          {subscribing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Bell className="w-3.5 h-3.5" />}
          {subscribing ? 'Enabling...' : 'Enable Push Notifications'}
        </button>
      </div>
    )
  }

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(!open)}
        className="relative"
        title="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className={`absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full ${hasUnreadFailure ? 'bg-red-500' : 'bg-violet-600'} text-white text-[10px] font-bold flex items-center justify-center px-1`}>
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 bg-black/40 z-[9998]" onClick={() => setOpen(false)} />
          <div className="fixed top-0 right-0 h-full w-full max-w-sm bg-white dark:bg-gray-950 border-l border-gray-200 dark:border-gray-800 shadow-2xl z-[9999] flex flex-col animate-in slide-in-from-right duration-300">
            <div className="flex justify-between items-center p-4 border-b border-gray-100 dark:border-gray-800 shrink-0">
              <h3 className="font-semibold text-lg">Notifications</h3>
              <div className="flex items-center gap-3">
                {unreadCount > 0 && (
                  <button
                    className="text-xs text-blue-600 hover:underline font-medium"
                    onClick={() => markAllReadMutation.mutate()}
                    disabled={markAllReadMutation.isPending}
                  >
                    Mark all read
                  </button>
                )}
                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => setOpen(false)}>
                  ✕
                </Button>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="p-8 text-center text-sm text-gray-500 flex flex-col items-center justify-center h-full">
                  <Bell className="w-12 h-12 text-gray-200 dark:text-gray-800 mb-3" />
                  <p>No notifications yet.</p>
                </div>
              ) : (
                <div className="flex flex-col divide-y divide-gray-50 dark:divide-gray-800/50">
                  {notifications.map(n => (
                    <div
                      key={n.id}
                      className={`p-4 text-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-900/50 ${
                        n.is_read ? 'bg-transparent opacity-80' : 'bg-blue-50/50 dark:bg-blue-900/10'
                      }`}
                    >
                      <Link
                        to={n.link || '#'}
                        onClick={() => setOpen(false)}
                        className="block"
                      >
                        <p className="font-semibold mb-1 flex items-center gap-2">
                          {n.title}
                          {!n.is_read && <span className="w-2 h-2 rounded-full bg-blue-600" />}
                        </p>
                        <p className="text-gray-600 dark:text-gray-300 text-sm leading-relaxed">
                          {n.message}
                        </p>
                        <p className="text-xs text-gray-400 mt-2 font-medium">
                          {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                        </p>
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            {renderPushBanner()}
          </div>
        </>
      )}
    </div>
  )
}
