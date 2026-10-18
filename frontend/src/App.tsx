import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { useEffect, lazy, Suspense, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/components/ToastProvider'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import DashboardLayout from '@/components/DashboardLayout'

// ── Route-level code splitting with resilient chunk reload ────────────────────
// Every page is loaded on demand. When a new deployment is pushed to production,
// older cached tabs might request stale chunk hashes. lazyWithRetry catches any
// dynamic import failure and reloads the window to fetch the new deployment cleanly.
function lazyWithRetry<T extends React.ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      return await factory()
    } catch (err: any) {
      const isChunkError =
        err?.message?.includes('dynamically imported module') ||
        err?.message?.includes('Failed to fetch') ||
        err?.message?.includes('Loading chunk') ||
        err?.name === 'ChunkLoadError'

      const reloadKey = 'gigr_chunk_reload'
      const lastReload = sessionStorage.getItem(reloadKey)
      const now = Date.now()

      if (isChunkError && (!lastReload || now - parseInt(lastReload, 10) > 15000)) {
        sessionStorage.setItem(reloadKey, String(now))
        window.location.reload()
        return new Promise<{ default: T }>(() => {})
      }
      throw err
    }
  })
}

const LandingPage = lazyWithRetry(() => import('@/pages/LandingPage'))
const LoginPage = lazyWithRetry(() => import('@/pages/LoginPage'))
const RegisterPage = lazyWithRetry(() => import('@/pages/RegisterPage'))
const ForgotPasswordPage = lazyWithRetry(() => import('@/pages/ForgotPasswordPage'))
const ResetPasswordPage = lazyWithRetry(() => import('@/pages/ResetPasswordPage'))
const HomePage = lazyWithRetry(() => import('@/pages/HomePage'))
const JobsPage = lazyWithRetry(() => import('@/pages/JobsPage'))
const ServicesPage = lazyWithRetry(() => import('@/pages/ServicesPage'))
const ServiceDetailPage = lazyWithRetry(() => import('@/pages/ServiceDetailPage'))
const ActivityPage = lazyWithRetry(() => import('@/pages/ActivityPage'))
const MessagesPage = lazyWithRetry(() => import('@/pages/MessagesPage'))
const DisputesPage = lazyWithRetry(() => import('@/pages/DisputesPage'))
const ProfilePage = lazyWithRetry(() => import('@/pages/ProfilePage'))
const AdminDashboard = lazyWithRetry(() => import('@/pages/AdminDashboard'))
const PublicProfilePage = lazyWithRetry(() => import('@/pages/PublicProfilePage'))
const AISettingsPage = lazyWithRetry(() => import('@/pages/AISettingsPage'))
const PayPalReturnPage = lazyWithRetry(() => import('@/pages/PayPalReturnPage'))
const PaymentsPage = lazyWithRetry(() => import('@/pages/PaymentsPage'))
const NotFoundPage = lazyWithRetry(() => import('@/pages/NotFoundPage'))

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: 'always',
    },
    mutations: {
      networkMode: 'always',
    },
  },
})

function PageFallback() {
  return (
    <div className="flex h-screen items-center justify-center">
      <div className="h-8 w-8 rounded-full border-2 border-gray-300 border-t-black animate-spin" />
    </div>
  )
}

// A deep link to a dashboard route that doesn't exist (a stale notification,
// an admin-entered announcement link, an old cached URL) would otherwise show
// a dead 404 page. Unknown /dashboard/* paths bounce to the dashboard home
// instead; genuinely unknown public paths still get the real 404 page.
function CatchAll() {
  const location = useLocation()
  if (location.pathname.startsWith('/dashboard')) {
    return <Navigate to="/dashboard" replace />
  }
  return <NotFoundPage />
}

function ProtectedRoute({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuthStore()
  if (isLoading) return <div className="flex h-screen items-center justify-center">Loading…</div>
  if (!user) return <Navigate to="/" replace />
  return children
}

function App() {
  const { fetchUser, isLoading } = useAuthStore()

  useEffect(() => {
    fetchUser()
  }, [])

  if (isLoading) return <div className="flex h-screen items-center justify-center">Loading…</div>

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ToastProvider />
          <Suspense fallback={<PageFallback />}>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/register" element={<RegisterPage />} />
              <Route path="/forgot-password" element={<ForgotPasswordPage />} />
              <Route path="/reset-password" element={<ResetPasswordPage />} />
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute>
                    <DashboardLayout />
                  </ProtectedRoute>
                }
              >
                <Route index element={<HomePage />} />
                <Route path="jobs" element={<JobsPage />} />
                <Route path="services" element={<ServicesPage />} />
                <Route path="services/:id" element={<ServiceDetailPage />} />
                <Route path="activity" element={<ActivityPage />} />
                <Route path="paypal/return" element={<PayPalReturnPage />} />
                <Route path="payments" element={<PaymentsPage />} />
                <Route path="messages" element={<MessagesPage />} />
                <Route path="disputes" element={<DisputesPage />} />
                <Route path="profile" element={<ProfilePage />} />
                <Route path="ai-settings" element={<AISettingsPage />} />
                <Route path="admin" element={<AdminDashboard />} />
                {/* Public profile inside dashboard for consistent nav */}
                <Route path="user/:userId" element={<PublicProfilePage />} />
                <Route path="profile/:userId" element={<PublicProfilePage />} />
              </Route>
              {/* Public portfolio routes — open to guests, shared links, and web bots */}
              <Route path="/profile/:userId" element={<PublicProfilePage />} />
              <Route path="/user/:userId" element={<PublicProfilePage />} />
              {/* Catch-all 404 Route — dashboard unknowns bounce home */}
              <Route path="*" element={<CatchAll />} />
            </Routes>
          </Suspense>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}

export default App
