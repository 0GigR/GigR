import { useState, useEffect } from 'react'
import { Outlet, NavLink } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { Button } from '@/components/ui/button'
import { Logo } from '@/components/Logo'
import OnboardingOverlay from '@/components/OnboardingOverlay'
import { useThemeStore } from '@/store/themeStore'
import { useUnreadStore } from '@/store/unreadStore'
import { useMessageNotifications } from '@/hooks/useMessageNotifications'
import VoiceAssistant from '@/components/VoiceAssistant'
import AgentBell from '@/components/agent/AgentBell'
import NotificationBell from '@/components/NotificationBell'
import AgentActivityPanel from '@/components/agent/AgentActivityPanel'
import GlobalItemModal from '@/components/GlobalItemModal'
import { useAgentStore } from '@/store/agentStore'
import api from '@/lib/api'
import {
  LayoutDashboard,
  Briefcase,
  Wrench,
  Clock,
  MessageSquare,
  Shield,
  Gavel,
  User,
  Sun,
  Moon,
  LogOut,
  MoreHorizontal,
  X,
} from 'lucide-react'

export default function DashboardLayout() {
  const { user, logout } = useAuthStore()
  const { theme, toggle } = useThemeStore()
  const messageUnread = useUnreadStore((s) => s.messageUnread)
  const [showMore, setShowMore] = useState(false)
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null)

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

  const navItems = [
    { to: '/dashboard', icon: LayoutDashboard, label: 'Home', end: true },
    { to: '/dashboard/jobs', icon: Briefcase, label: 'Jobs' },
    { to: '/dashboard/services', icon: Wrench, label: 'Services' },
    { to: '/dashboard/activity', icon: Clock, label: 'Activity' },
    { to: '/dashboard/messages', icon: MessageSquare, label: 'Messages' },
    { to: '/dashboard/disputes', icon: Gavel, label: 'Disputes' },
    { to: '/dashboard/profile', icon: User, label: 'Profile' },
    ...(isAdmin ? [{ to: '/dashboard/admin', icon: Shield, label: 'Admin' }] : []),
  ]

  // Global live message notifications (light + toast on any page)
  useMessageNotifications()

  // Start agent polling (only when AI is enabled)
  const { startPolling, stopPolling, connectAgentWS, disconnectAgentWS } = useAgentStore()
  useEffect(() => {
    if (!aiEnabled) return
    startPolling()
    return () => stopPolling()
  }, [startPolling, stopPolling, aiEnabled])

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

  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 text-black dark:text-white">
      {aiEnabled && <VoiceAssistant />}
      {aiEnabled && <AgentActivityPanel />}
      <OnboardingOverlay />
      <GlobalItemModal />
      {/* Top Bar */}
      <header className="sticky top-0 z-50 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
        <div className="flex items-center justify-between px-4 py-3 max-w-7xl mx-auto">
          <div className="flex items-center gap-2">
            <Logo className="w-6 h-6" />
            <span className="font-bold text-lg">Gigr</span>
          </div>
          <div className="flex items-center gap-2">
            <NotificationBell />
            {aiEnabled && <AgentBell />}
            <Button variant="ghost" size="icon" onClick={toggle}>
              {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={logout}>
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Optional Install PWA Banner */}
      {deferredPrompt && (
        <div className="bg-indigo-600 px-4 py-3 text-white flex justify-between items-center text-sm shadow-sm">
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

      {/* Main Content Area */}
      <main className="max-w-7xl mx-auto px-4 py-6 md:pl-72">
        <Outlet />
      </main>

      {/* Bottom Navigation (mobile) */}
      <nav className="fixed bottom-0 left-0 right-0 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 md:hidden z-50">
        <div className="flex justify-around py-2">
          {navItems.slice(0, 4).map((item) => (
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
          {navItems.map((item) => (
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
              {navItems.slice(4).map((item) => (
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
    </div>
  )
}