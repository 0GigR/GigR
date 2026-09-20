import { useState, useEffect, useCallback, lazy, Suspense } from 'react'
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { Button } from '@/components/ui/button'
import { Logo } from '@/components/Logo'
import { useThemeStore } from '@/store/themeStore'
import { useUnreadStore } from '@/store/unreadStore'
import { useMessageNotifications } from '@/hooks/useMessageNotifications'
import AgentBell from '@/components/agent/AgentBell'
import NotificationBell from '@/components/NotificationBell'
import { useCurrencyStore } from '@/store/currencyStore'
import PushPromptBanner from '@/components/PushPromptBanner'
import LocationPromptBanner from '@/components/LocationPromptBanner'
import { useAgentStore } from '@/store/agentStore'
import api from '@/lib/api'

// Heavy/framer-motion widgets are lazy-loaded so they don't ship in the initial
// bundle (the dashboard shell must stay light for fast first paint after login).
const VoiceAssistant = lazy(() => import('@/components/VoiceAssistant'))
const OnboardingOverlay = lazy(() => import('@/components/OnboardingOverlay'))
const AnnouncementPopup = lazy(() => import('@/components/AnnouncementPopup'))
const AgentActivityPanel = lazy(() => import('@/components/agent/AgentActivityPanel'))
const CallReminderPrompt = lazy(() => import('@/components/agent/CallReminderPrompt'))
const GlobalItemModal = lazy(() => import('@/components/GlobalItemModal'))
import {
  LayoutDashboard,
  Briefcase,
  Wrench,
  Clock,
  MessageSquare,
  Shield,
  Gavel,
  User,
  Bot,
  Sun,
  Moon,
  LogOut,
  MoreHorizontal,
  X,
  RefreshCw,
  ChevronLeft,
} from 'lucide-react'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { useLocationStore } from '@/store/locationStore'

export default function DashboardLayout() {
  const { user, logout } = useAuthStore()
  const { theme, toggle } = useThemeStore()
  const messageUnread = useUnreadStore((s) => s.messageUnread)
  const [showMore, setShowMore] = useState(false)
  const [confirmLogout, setConfirmLogout] = useState(false)
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null)
  const [isRefreshing, setIsRefreshing] = useState(false)
  const queryClient = useQueryClient()
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW()
  const location = useLocation()
  const navigate = useNavigate()

  // Subscribe to the display currency so this shell (and the route page it
  // hosts) re-renders in place when the user switches currency — no reload.
  // The store value itself is read inside `fmtPrice`, so only the subscription
  // is needed here to keep every mounted price node in sync.
  useCurrencyStore((s) => s.code)
  useCurrencyStore((s) => s.rates)

  // Location is owned by locationStore now: one GPS request for the whole app
  // and a single throttled server sync. This component used to run its own
  // getCurrentPosition (via useGeolocation) AND post the result after 5s, on top
  // of the same work being done by HomePage, ServicesPage and the prompt banner.
  const requestLocation = useLocationStore((s) => s.request)
  useEffect(() => {
    requestLocation()
  }, [requestLocation])

  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault()
      setDeferredPrompt(e)
    }
    window.addEventListener('beforeinstallprompt', handler)
    return () => window.removeEventListener('beforeinstallprompt', handler)
  }, [])

  const handleInstallClick = async () => {
    if (!deferredPrompt) return
    deferredPrompt.prompt()
    const { outcome } = await deferredPrompt.userChoice
    if (outcome === 'accepted') {
      setDeferredPrompt(null)
    }
  }

  const isAdmin = user?.role === 'admin' || user?.role === 'superadmin'
  const aiEnabled = user?.ai_enabled !== false

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      await queryClient.invalidateQueries()
      await queryClient.refetchQueries({ type: 'active' })
    } finally {
      setTimeout(() => setIsRefreshing(false), 600)
    }
  }

  // `end` is optional: only the dashboard root needs exact matching.
  type NavItem = { to: string; icon: typeof LayoutDashboard; label: string; end?: boolean }

  // Navigation is split so a first-time user sees the few things that matter and
  // nothing else. Every route still exists and still works — this only changes
  // what is advertised.
  //
  // "Disputes" is the clearest example: a beginner should never have to wonder
  // what it is. It appears only once the user actually has one.
  const { data: myDisputes } = useQuery<unknown[]>({
    queryKey: ['disputes', 'mine'],
    queryFn: async () => {
      const { data } = await api.get('/disputes/my-disputes')
      return Array.isArray(data) ? data : []
    },
    enabled: !!user,
    staleTime: 5 * 60 * 1000,
  })
  const hasDisputes = (myDisputes?.length ?? 0) > 0

  const primaryNav: NavItem[] = [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Home', end: true },
    { to: '/dashboard/jobs', icon: Briefcase, label: 'Jobs' },
    { to: '/dashboard/services', icon: Wrench, label: 'Services' },
    { to: '/dashboard/messages', icon: MessageSquare, label: 'Messages' },
    { to: '/dashboard/activity', icon: Clock, label: 'Activity' },
    { to: '/dashboard/profile', icon: User, label: 'Profile' },
  ]
  const secondaryNav: NavItem[] = [
    ...(hasDisputes ? [{ to: '/dashboard/disputes', icon: Gavel, label: 'Disputes' }] : []),
    ...(aiEnabled ? [{ to: '/dashboard/ai-settings', icon: Bot, label: 'AI Settings' }] : []),
    ...(isAdmin ? [{ to: '/dashboard/admin', icon: Shield, label: 'Admin' }] : []),
  ]
  const navItems = [...primaryNav, ...secondaryNav]

  // The four destinations worth a permanent thumb slot on a phone. Messages is
  // here on purpose: it carries the unread badge, which was previously invisible
  // on mobile because the item only existed in the More sheet.
  const BOTTOM_NAV_PATHS = [
    '/dashboard',
    '/dashboard/jobs',
    '/dashboard/services',
    '/dashboard/messages',
  ]
  const bottomNav = BOTTOM_NAV_PATHS.map(
    (path) => navItems.find((item) => item.to === path)!,
  ).filter(Boolean)
  const moreNav = navItems.filter((item) => !BOTTOM_NAV_PATHS.includes(item.to))

  // Global live message notifications (light + toast on any page)
  useMessageNotifications()

  // Start agent polling (only when AI is enabled)
  const { startPolling, stopPolling, connectAgentWS, disconnectAgentWS, fetchEngineInfo } = useAgentStore()
  useEffect(() => {
    if (!aiEnabled) return
    startPolling()
    // Pull the engine status AND this user's stored agent settings, so the
    // autonomy level shown in the UI always matches what the backend enforces.
    fetchEngineInfo()
    return () => stopPolling()
  }, [startPolling, stopPolling, aiEnabled, fetchEngineInfo])

  // Heartbeat — keep last_seen_at fresh every 60 s
  useEffect(() => {
    if (!user) return
    api.post('/users/me/heartbeat').catch(() => {})
    const id = setInterval(() => api.post('/users/me/heartbeat').catch(() => {}), 60_000)
    return () => clearInterval(id)
  }, [user])

  // Agent push WS — get task updates instantly instead of waiting for the poll
  useEffect(() => {
    if (!user || !aiEnabled) return
    connectAgentWS(user.id)
    return () => disconnectAgentWS()
  }, [user, aiEnabled, connectAgentWS, disconnectAgentWS])

  // Only ONE banner may occupy the top of the page. Stacked install + push +
  // location + update bars were the single biggest source of first-look clutter.
  // Priority: update > install > push > location.
  const [pushBannerShowing, setPushBannerShowing] = useState(false)
  const handlePushBannerActive = useCallback((active: boolean) => {
    setPushBannerShowing(active)
  }, [])
  const bannerTaken = needRefresh || Boolean(deferredPrompt)

  // The dashboard home is the only place with nothing to go back to.
  const isDashboardRoot = location.pathname === '/dashboard' || location.pathname === '/dashboard/'

  const goBack = () => {
    const idx = (window.history.state as { idx?: number } | null)?.idx
    if (typeof idx === 'number' && idx > 0) {
      navigate(-1)
    } else {
      navigate('/dashboard')
    }
  }

  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 text-black dark:text-white">
      <Suspense fallback={null}>
        {aiEnabled && <VoiceAssistant />}
        {aiEnabled && <AgentActivityPanel />}
        {aiEnabled && <CallReminderPrompt />}
        <OnboardingOverlay />
        <AnnouncementPopup />
        <GlobalItemModal />
      </Suspense>
      {/* Top Bar */}
      <header className="sticky top-0 z-50 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
        <div className="flex items-center justify-between px-4 py-3 max-w-7xl mx-auto">
          <div className="flex items-center gap-2">
            {/* An installed iOS PWA has no system back gesture or button, so
                this is the only way back. React Router keeps an index in history
                state; when there is nothing to return to we go home rather than
                letting the button close the app. */}
            {!isDashboardRoot && (
              <Button
                variant="ghost"
                size="icon"
                className="-ml-2"
                onClick={goBack}
                title="Back"
                aria-label="Go back"
              >
                <ChevronLeft className="h-5 w-5" />
              </Button>
            )}
            <Logo className="w-6 h-6" />
            <span className="font-bold text-lg">Gigr</span>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell />
            {aiEnabled && <AgentBell />}
            <Button variant="ghost" size="icon" onClick={handleRefresh} disabled={isRefreshing} title="Refresh data">
              <RefreshCw className={`h-5 w-5 ${isRefreshing ? 'animate-spin' : ''}`} />
            </Button>
            <Button variant="ghost" size="icon" onClick={toggle}>
              {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={() => setConfirmLogout(true)}>
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Optional Install PWA Banner — sticky under the header, above the fixed sidebar (z-40) */}
      {deferredPrompt && !needRefresh && (
        <div className="sticky top-14 z-[60] bg-indigo-600 px-4 py-3 text-white flex justify-between items-center text-sm shadow-sm">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Install Gigr App</span>
            <span className="hidden sm:inline opacity-80">for a better, faster experience.</span>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={handleInstallClick} className="bg-white text-indigo-600 px-3 py-1 rounded font-medium hover:bg-gray-100 transition-colors">
              Install
            </button>
            <button onClick={() => setDeferredPrompt(null)} className="opacity-70 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}
      {/* Push Notification Banner — sticky under the header. Always asks when
          push is not currently enabled (auto on load, then via the Enable
          button, which is a user gesture the browsers require). */}
      <PushPromptBanner
        enabled={!bannerTaken}
        onActiveChange={handlePushBannerActive}
      />

      {/* Periodic location-sharing nudge — only when location_public is off,
          re-asks at most every 7 days. */}
      <LocationPromptBanner enabled={!bannerTaken && !pushBannerShowing} />

      {/* Update Available Banner — sticky under the header, above the fixed sidebar (z-40) */}
      {needRefresh && (
        <div className="sticky top-14 z-[60] bg-blue-600 px-4 py-3 text-white flex justify-between items-center text-sm shadow-sm">
          <div className="flex items-center gap-2">
            <span className="font-semibold">Update Available</span>
            <span className="hidden sm:inline opacity-80">A new version of Gigr is ready.</span>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={() => {
              // Hide the banner immediately, then activate the waiting SW.
              // updateServiceWorker(true) skip-waits the new worker AND reloads
              // the page once it takes control — so on the next load there is no
              // waiting worker and the banner does not reappear (the old
              // unregister+reload approach left the update pending → banner stuck).
              setNeedRefresh(false)
              updateServiceWorker(true)
            }} className="bg-background text-primary px-3 py-1 rounded font-medium hover:bg-gray-100 transition-colors">
              Reload to Update
            </button>
            <button onClick={() => setNeedRefresh(false)} className="opacity-70 hover:opacity-100">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      {/* pb-24 on mobile keeps page content clear of the fixed bottom nav;
          md:pb-6 restores normal padding on desktop where the nav is hidden */}
      <main className="max-w-7xl mx-auto px-4 pt-6 pb-24 md:pb-6 md:pl-72 relative">
        {/* Route transition — CSS-based (tw-animate-css) instead of framer-motion
            so the shell doesn't pull framer-motion into the initial bundle. */}
        <div key={location.pathname} className="animate-in fade-in slide-in-from-bottom-2 duration-300">
          <Outlet />
        </div>
      </main>

      {/* Bottom Navigation (mobile) */}
      <nav className="fixed bottom-0 left-0 right-0 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 md:hidden z-50">
        <div className="flex justify-around py-2">
          {bottomNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex flex-col items-center px-2 py-1 rounded-lg text-xs ${
                  isActive
                    ? 'text-black dark:text-white font-semibold'
                    : 'text-gray-500 dark:text-gray-400'
                }`
              }
            >
              <span className="relative">
                <item.icon className="h-5 w-5 mb-0.5" />
                {item.to === '/dashboard/messages' && messageUnread > 0 && (
                  <span className="absolute -top-1 -right-1 w-2.5 h-2.5 rounded-full bg-blue-900" />
                )}
              </span>
              {item.label}
            </NavLink>
          ))}
          <button
            onClick={() => setShowMore(true)}
            className="flex flex-col items-center px-2 py-1 rounded-lg text-xs text-gray-500 dark:text-gray-400"
          >
            <MoreHorizontal className="h-5 w-5 mb-0.5" />
            More
          </button>
        </div>
      </nav>

      {/* Sidebar (desktop) */}
      <aside className="hidden md:flex md:flex-col md:w-64 md:fixed md:top-14 md:left-0 md:bottom-0 border-r border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 p-4 z-40">
        <nav className="flex flex-col gap-1">
          {primaryNav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? 'bg-gray-100 dark:bg-gray-800 text-black dark:text-white'
                    : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                }`
              }
            >
              <item.icon className="h-5 w-5" />
              {item.label}
              {item.to === '/dashboard/messages' && messageUnread > 0 && (
                <span className="ml-auto w-2.5 h-2.5 rounded-full bg-blue-900" />
              )}
            </NavLink>
          ))}

          {secondaryNav.length > 0 && (
            <>
              <div className="mt-4 mb-1 px-4 text-[11px] font-semibold uppercase tracking-wide text-gray-400 dark:text-gray-600">
                More
              </div>
              {secondaryNav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-4 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-gray-100 dark:bg-gray-800 text-black dark:text-white'
                        : 'text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'
                    }`
                  }
                >
                  <item.icon className="h-5 w-5" />
                  {item.label}
                </NavLink>
              ))}
            </>
          )}
        </nav>
      </aside>

      {/* "More" Sheet (mobile) */}
      {showMore && (
        <div className="fixed inset-0 z-50 md:hidden">
          {/* Backdrop */}
          <div className="absolute inset-0 bg-black/40" onClick={() => setShowMore(false)} />
          {/* Sheet */}
          <div className="absolute bottom-0 left-0 right-0 bg-white dark:bg-gray-950 rounded-t-2xl p-4 animate-in slide-in-from-bottom duration-300">
            <div className="flex justify-between items-center mb-4">
              <h2 className="font-semibold text-lg">More</h2>
              <button onClick={() => setShowMore(false)} className="p-1">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-4">
              {moreNav.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={() => setShowMore(false)}
                  className={({ isActive }) =>
                    `flex flex-col items-center gap-1 p-2 rounded-lg ${
                      isActive ? 'bg-gray-100 dark:bg-gray-800' : ''
                    }`
                  }
                >
                  <item.icon className="h-6 w-6" />
                  <span className="text-xs">{item.label}</span>
                </NavLink>
              ))}
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmLogout}
        onOpenChange={setConfirmLogout}
        title="Log out?"
        description="You'll need to sign in again to access your dashboard."
        confirmLabel="Log Out"
        cancelLabel="Stay"
        onConfirm={() => { setConfirmLogout(false); logout() }}
      />
    </div>
  )
}