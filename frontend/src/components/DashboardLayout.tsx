import { Outlet, NavLink } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { Button } from '@/components/ui/button'
import { Logo } from '@/components/Logo'
import OnboardingOverlay from '@/components/OnboardingOverlay'
import { useThemeStore } from '@/store/themeStore'
import { useUnreadStore } from '@/store/unreadStore'
import { useMessageNotifications } from '@/hooks/useMessageNotifications'
import {
  LayoutDashboard,
  Briefcase,
  Wrench,
  Clock,
  MessageSquare,
  Gavel,
  User,
  Sun,
  Moon,
  LogOut,
} from 'lucide-react'

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Home', end: true },
  { to: '/dashboard/jobs', icon: Briefcase, label: 'Jobs' },
  { to: '/dashboard/services', icon: Wrench, label: 'Services' },
  { to: '/dashboard/activity', icon: Clock, label: 'Activity' },
  { to: '/dashboard/messages', icon: MessageSquare, label: 'Messages' },
  { to: '/dashboard/disputes', icon: Gavel, label: 'Jury' },
  { to: '/dashboard/profile', icon: User, label: 'Profile' },
]

export default function DashboardLayout() {
  const { logout } = useAuthStore()
  const { theme, toggle } = useThemeStore()
  const messageUnread = useUnreadStore((s) => s.messageUnread)

  // Global live message notifications (light + toast on any page)
  useMessageNotifications()

  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 text-black dark:text-white">
      <OnboardingOverlay />
      {/* Top Bar */}
      <header className="sticky top-0 z-50 border-b border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950">
        <div className="flex items-center justify-between px-4 py-3 max-w-7xl mx-auto">
          <div className="flex items-center gap-2">
            <Logo className="w-6 h-6" />
            <span className="font-bold text-lg">Gigr</span>
          </div>
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={toggle}>
              {theme === 'dark' ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </Button>
            <Button variant="ghost" size="icon" onClick={logout}>
              <LogOut className="h-5 w-5" />
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-6 md:pl-72">
        <Outlet />
      </main>

      {/* Bottom Navigation (mobile) */}
      <nav className="fixed bottom-0 left-0 right-0 border-t border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-950 md:hidden z-50">
        <div className="flex justify-around py-2">
          {navItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                `flex flex-col items-center px-3 py-1 rounded-lg text-xs ${
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
    </div>
  )
}