import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { useEffect } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ToastProvider } from '@/components/ToastProvider'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import LandingPage from '@/pages/LandingPage'
import LoginPage from '@/pages/LoginPage'
import RegisterPage from '@/pages/RegisterPage'
import DashboardLayout from '@/components/DashboardLayout'
import HomePage from '@/pages/HomePage'
import JobsPage from '@/pages/JobsPage'
import ServicesPage from '@/pages/ServicesPage'
import ActivityPage from '@/pages/ActivityPage'
import MessagesPage from '@/pages/MessagesPage'
import DisputesPage from '@/pages/DisputesPage'
import ProfilePage from '@/pages/ProfilePage'
import { CookieConsentBanner } from '@/components/CookieConsent'
import AdminDashboard from '@/pages/AdminDashboard'
import PublicProfilePage from '@/pages/PublicProfilePage'
import AISettingsPage from '@/pages/AISettingsPage'
import NotFoundPage from '@/pages/NotFoundPage'

const queryClient = new QueryClient()

function ProtectedRoute({ children }: { children: React.ReactNode }) {
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
          <CookieConsentBanner />
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/login" element={<LoginPage />} />
            <Route path="/register" element={<RegisterPage />} />
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
              <Route path="activity" element={<ActivityPage />} />
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
            {/* Catch-all 404 Route */}
            <Route path="*" element={<NotFoundPage />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </ErrorBoundary>
  )
}

export default App