import { BrowserRouter, Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { useEffect, lazy, Suspense, type ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/components/ToastProvider'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import DashboardLayout from '@/components/DashboardLayout'

// ── Route-level code splitting ──────────────────────────────────────────────
// Every page is loaded on demand via React.lazy. Leaflet (map pages), framer-motion
// (landing/activity/messages) and heic2any (image upload pages) are only ever
// imported from these lazy chunks, so they leave the initial bundle entirely.
const LandingPage = lazy(() => import('@/pages/LandingPage'))
const LoginPage = lazy(() => import('@/pages/LoginPage'))
const RegisterPage = lazy(() => import('@/pages/RegisterPage'))
const ForgotPasswordPage = lazy(() => import('@/pages/ForgotPasswordPage'))
const ResetPasswordPage = lazy(() => import('@/pages/ResetPasswordPage'))
const HomePage = lazy(() => import('@/pages/HomePage'))
const JobsPage = lazy(() => import('@/pages/JobsPage'))
const ServicesPage = lazy(() => import('@/pages/ServicesPage'))
const ServiceDetailPage = lazy(() => import('@/pages/ServiceDetailPage'))
const ActivityPage = lazy(() => import('@/pages/ActivityPage'))
const MessagesPage = lazy(() => import('@/pages/MessagesPage'))
const DisputesPage = lazy(() => import('@/pages/DisputesPage'))
const ProfilePage = lazy(() => import('@/pages/ProfilePage'))
const AdminDashboard = lazy(() => import('@/pages/AdminDashboard'))
const PublicProfilePage = lazy(() => import('@/pages/PublicProfilePage'))
const AISettingsPage = lazy(() => import('@/pages/AISettingsPage'))
const PayPalReturnPage = lazy(() => import('@/pages/PayPalReturnPage'))
const PaymentsPage = lazy(() => import('@/pages/PaymentsPage'))
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'))

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
              </Route>
              {/* Legacy public route still works */}
              <Route path="/profile/:userId" element={<PublicProfilePage />} />
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
