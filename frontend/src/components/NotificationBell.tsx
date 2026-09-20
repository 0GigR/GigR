import { useState, useEffect } from 'react'
import {
  Bell, CheckCircle2, BellOff, Loader2, Smartphone,
  MessageSquare, Briefcase, UserPlus, Wallet, ClipboardCheck,
  XCircle, Bot, X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { createPortal } from 'react-dom'
import { Button } from '@/components/ui/button'
import api from '@/lib/api'
import { Link, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { subscribeToPushNotifications, syncPushSubscription } from '@/lib/push'
import { toast } from 'sonner'

import { formatDistanceToNow } from 'date-fns'

export interface Notification {
  id: string
  title: string
  message: string
  link?: string
  is_read: boolean
  created_at: string
  type?: string
}

// Per-type presentation: which icon and color each kind of notification gets
// in the bell. Unknown types fall back to the system (bell) style.
const TYPE_META: Record<string, { icon: LucideIcon; color: string; label: string }> = {
  message:     { icon: MessageSquare,  color: 'text-blue-600 dark:text-blue-400',     label: 'Message' },
  job:         { icon: Briefcase,      color: 'text-violet-600 dark:text-violet-400', label: 'Job' },
  request:     { icon: UserPlus,       color: 'text-indigo-600 dark:text-indigo-400', label: 'Request' },
  application: { icon: UserPlus,       color: 'text-indigo-600 dark:text-indigo-400', label: 'Application' },
  accepted:    { icon: CheckCircle2,   color: 'text-emerald-600 dark:text-emerald-400', label: 'Accepted' },
  payment:     { icon: Wallet,         color: 'text-green-600 dark:text-green-400',   label: 'Payment' },
  work:        { icon: ClipboardCheck, color: 'text-amber-600 dark:text-amber-400',   label: 'Work' },
  cancelled:   { icon: XCircle,        color: 'text-red-500 dark:text-red-400',       label: 'Cancelled' },
  agent:       { icon: Bot,            color: 'text-cyan-600 dark:text-cyan-400',     label: 'Agent' },
  system:      { icon: Bell,           color: 'text-gray-500 dark:text-gray-400',     label: 'System' },
}

function getTypeMeta(type?: string) {
  return TYPE_META[type || 'system'] || TYPE_META.system
}

import { safeAppLink } from '@/lib/appLinks'

function getPushState(): 'unsupported' | 'denied' | 'granted' | 'default' | 'ios-browser' | 'disconnected' {
  // iOS Safari in regular browser doesn't support Web Push at all
  // Only works when installed as a PWA (home screen app) on iOS 16.4+
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  const isStandalone = (window.navigator as any).standalone === true
  if (isIOS && !isStandalone) return 'ios-browser'
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported'
  return (Notification.permission as any) || 'default'
}

// Bell filter tabs: which notification types each tab shows. Everything else
// (unknown/legacy types) only appears under "All".
const FILTER_GROUPS: Record<string, string[]> = {
  messages: ['message'],
  jobs: ['job', 'request', 'application', 'accepted', 'work', 'cancelled'],
  money: ['payment'],
  agent: ['agent'],
}
const FILTER_LABELS: Record<string, string> = {
  all: 'All',
  messages: 'Messages',
  jobs: 'Jobs',
  money: 'Money',
  agent: 'Agent',
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('all')
  const [pushState, setPushState] = useState<ReturnType<typeof getPushState>>('default')
  const [subscribing, setSubscribing] = useState(false)
  const [reconnecting, setReconnecting] = useState(false)
  const queryClient = useQueryClient()
  const { user } = useAuthStore()
  const location = useLocation()

  useEffect(() => {
    setPushState(getPushState())
  }, [open])

  // Close the panel whenever the route changes — tapping a notification
  // navigates the app, and the panel should not linger over the new page.
  useEffect(() => {
    setOpen(false)
  }, [location.pathname])

  // Truth check: green "enabled" must mean the SERVER has the subscription,
  // not just that the browser granted permission. If permission is granted
  // but the backend has no record of it (failed save, expired token), show
  // "not connected" so the user can Reconnect instead of silently getting
  // nothing.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    api.get('/push/status')
      .then(({ data }) => {
        if (cancelled) return
        if (getPushState() === 'granted' && !data.subscribed) {
          setPushState('disconnected')
        }
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [open])

  // Silent heal: if push is already granted, re-sync the subscription on load
  // so a backend-side expiry (410) or cleared site data doesn't silently kill
  // notifications until the user manually re-enables them.
  useEffect(() => {
    if (!user) return
    if (getPushState() !== 'granted') return
    let cancelled = false
    syncPushSubscription().then((ok) => {
      if (!cancelled && ok) setPushState('granted')
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id])

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

  // Force a fresh push token. An expired subscription that the server 410'd
  // (token dead, e.g. after a long gap) must be dropped before subscribing
  // again — pushManager.subscribe() would otherwise return the same dead one.
  const handleReconnect = async () => {
    setReconnecting(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const existing = await reg.pushManager.getSubscription()
      if (existing) await existing.unsubscribe()
      const ok = await subscribeToPushNotifications()
      if (ok) {
        setPushState('granted')
        toast.success('Push notifications reconnected')
      } else {
        setPushState(getPushState())
        toast.error('Could not reconnect push notifications')
      }
    } finally {
      setReconnecting(false)
    }
  }

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
        // Permission granted but the save failed or the token is dead — keep
        // it visible as "not connected" instead of pretending it's enabled.
        setPushState(state === 'granted' ? 'disconnected' : state)
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

  // Defensive: never trust the API response shape. A non-array here would
  // crash the whole dashboard, since the bell mounts on every page.
  const notifs = Array.isArray(notifications) ? notifications : []
  const unreadCount = notifs.filter(n => !n.is_read).length

  const filtered = filter === 'all'
    ? notifs
    : notifs.filter(n => (FILTER_GROUPS[filter] || []).includes(n.type || ''))
  const counts: Record<string, number> = { all: notifs.length }
  for (const key of Object.keys(FILTER_GROUPS)) {
    counts[key] = notifs.filter(n => FILTER_GROUPS[key].includes(n.type || '')).length
  }

  // A notification counts as a "failure" if its text signals something went wrong.
  // Only these turn the badge red; everything else is a calm purple.
  const isFailure = (n: Notification) =>
    /\b(fail(?:ed|ure)?|error|unable|couldn'?t|could not|declined|rejected|cancell?ed)\b/i.test(
      `${n.title} ${n.message}`
    )
  const hasUnreadFailure = notifs.some(n => !n.is_read && isFailure(n))

  // Mark ONE notification read when the user taps it. Opening the panel does
  // NOT clear the badge anymore — unread dots stay until each item is actually
  // seen (or "Mark all read" is pressed). Message notifications also auto-clear
  // when the conversation itself is opened (read-conversation).
  const markOneRead = (id: string) => {
    api.post(`/notifications/${id}/read`)
      .then(() => queryClient.invalidateQueries({ queryKey: ['notifications'] }))
      .catch(() => {})
  }

  const renderPushBanner = () => {
    if (pushState === 'granted') {
      return (
        <div className="p-3 border-t border-gray-100 dark:border-gray-800 bg-green-50 dark:bg-green-900/20 flex items-center justify-between gap-2 text-xs text-green-700 dark:text-green-400 shrink-0">
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="w-3.5 h-3.5" />
            Push notifications are enabled
          </span>
          <button
            onClick={handleReconnect}
            disabled={reconnecting}
            className="font-medium text-green-800 dark:text-green-300 hover:underline disabled:opacity-60"
            title="Expired subscriptions silently stop delivering — reconnect forces a fresh token"
          >
            {reconnecting ? 'Reconnecting...' : 'Reconnect'}
          </button>
        </div>
      )
    }
    if (pushState === 'disconnected') {
      return (
        <div className="p-3 border-t border-gray-100 dark:border-gray-800 bg-amber-50 dark:bg-amber-900/20 flex items-center justify-between gap-2 text-xs text-amber-700 dark:text-amber-300 shrink-0">
          <span className="inline-flex items-center gap-2">
            <BellOff className="w-3.5 h-3.5 shrink-0" />
            Permission on, but not connected
          </span>
          <button
            onClick={handleReconnect}
            disabled={reconnecting}
            className="font-medium text-amber-800 dark:text-amber-200 hover:underline disabled:opacity-60"
          >
            {reconnecting ? 'Reconnecting...' : 'Reconnect'}
          </button>
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

      {/* Portal the panel + backdrop to document.body: it lives inside the
          z-50 header, so its z-[9999] was capped by the header's stacking
          context — the mobile bottom nav (also z-50, later in the DOM) painted
          over the panel's footer. Portaled, it sits above everything. */}
      {open && createPortal(
        <>
          <div className="fixed inset-0 bg-black/40 z-[9998]" onClick={() => setOpen(false)} />
          {/* 100dvh (not h-full/100vh): on mobile, 100vh is taller than the
              visible viewport while the browser chrome is showing, which hid
              the push-enable footer behind the bottom nav / browser UI. */}
          <div className="fixed top-0 right-0 h-[100dvh] w-full max-w-sm bg-white dark:bg-gray-950 border-l border-gray-200 dark:border-gray-800 shadow-2xl z-[9999] flex flex-col animate-in slide-in-from-right duration-300 pb-[env(safe-area-inset-bottom)]">
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
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
            
            {/* Filter tabs */}
            <div className="flex gap-1 px-3 py-2 border-b border-gray-100 dark:border-gray-800 overflow-x-auto shrink-0">
              {Object.keys(FILTER_LABELS).map(key => (
                <button
                  key={key}
                  onClick={() => setFilter(key)}
                  className={`px-2.5 py-1 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                    filter === key
                      ? 'bg-black text-white dark:bg-white dark:text-black'
                      : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700'
                  }`}
                >
                  {FILTER_LABELS[key]}
                  {counts[key] > 0 && <span className={`ml-1 ${filter === key ? 'opacity-70' : 'text-gray-400'}`}>{counts[key]}</span>}
                </button>
              ))}
            </div>

            <div className="flex-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="p-8 text-center text-sm text-gray-500 flex flex-col items-center justify-center h-full">
                  <Bell className="w-12 h-12 text-gray-200 dark:text-gray-800 mb-3" />
                  <p>{filter === 'all' ? 'No notifications yet.' : 'Nothing here yet.'}</p>
                </div>
              ) : (
                <div className="flex flex-col divide-y divide-gray-50 dark:divide-gray-800/50">
                  {filtered.map(n => {
                    const meta = getTypeMeta(n.type)
                    const TypeIcon = meta.icon
                    return (
                      <div
                        key={n.id}
                        className={`p-4 text-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-900/50 ${
                          n.is_read ? 'bg-transparent opacity-80' : 'bg-blue-50/50 dark:bg-blue-900/10'
                        }`}
                      >
                        <Link
                          to={safeAppLink(n.link)}
                          onClick={() => { setOpen(false); if (!n.is_read) markOneRead(n.id) }}
                          className="block"
                        >
                          <p className="font-semibold mb-1 flex items-start gap-2">
                            <span className={`mt-0.5 shrink-0 ${meta.color}`} title={meta.label}>
                              <TypeIcon className="w-4 h-4" />
                            </span>
                            <span className="flex items-center gap-2">
                              {n.title}
                              {!n.is_read && <span className="w-2 h-2 rounded-full bg-blue-600 shrink-0" />}
                            </span>
                          </p>
                          <p className="text-gray-600 dark:text-gray-300 text-sm leading-relaxed pl-6">
                            {n.message}
                          </p>
                          <p className="text-xs text-gray-400 mt-2 font-medium pl-6">
                            {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                          </p>
                        </Link>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
            
            {renderPushBanner()}
          </div>
        </>,
        document.body
      )}
    </div>
  )
}
