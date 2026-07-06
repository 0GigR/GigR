import axios from 'axios'
import { useAuthStore } from '@/store/authStore'
import { toast } from 'sonner'

// ── Token helpers ────────────────────────────────────────────────────────────
// We persist the access_token in localStorage as a fallback for cross-site
// environments (Vercel + Render) where Chrome blocks third-party cookies.
// The backend already accepts both HttpOnly cookie AND Authorization header.
const TOKEN_KEY = 'baros_access_token'

export const saveToken = (token: string) => localStorage.setItem(TOKEN_KEY, token)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)
export const getToken = () => localStorage.getItem(TOKEN_KEY)

// ── Axios instance ───────────────────────────────────────────────────────────
// When VITE_API_URL is set (production), use it as-is.
// When blank (local dev), default to /api/v1 so Vite's proxy picks it up.
const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || '/api/v1',
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,  // still send cookies when they work
  timeout: 15000,
})

// ── Request interceptor: inject Bearer token from localStorage ───────────────
// This is the fallback that makes auth work even when cross-site cookies are blocked.
api.interceptors.request.use((config) => {
  const token = getToken()
  if (token && !config.headers['Authorization']) {
    config.headers['Authorization'] = `Bearer ${token}`
  }
  return config
})

// ── Response interceptor: handle 401 / token refresh ─────────────────────────
api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config

    // Never retry these endpoints (avoids infinite loops)
    if (
      originalRequest.url?.includes('/auth/refresh') ||
      originalRequest.url?.includes('/auth/logout')
    ) {
      return Promise.reject(error)
    }

    // If 401 and haven't retried yet
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true

      try {
        // Try cookie-based refresh first
        const refreshRes = await api.post('/auth/refresh')
        // If the backend returns a new access_token in body, save it
        if (refreshRes.data?.access_token) {
          saveToken(refreshRes.data.access_token)
          originalRequest.headers['Authorization'] = `Bearer ${refreshRes.data.access_token}`
        }
        return api(originalRequest)
      } catch {
        // Refresh failed – log out and redirect
        clearToken()
        useAuthStore.getState().logout()
        if (window.location.pathname !== '/') {
          window.location.href = '/'
        }
        return Promise.reject(error)
      }
    }

    // Handle generic 400 errors (Solana/USDC etc.) with a toast
    if (error.response?.status === 400 && error.response?.data?.detail) {
      toast.error(error.response.data.detail)
    }

    return Promise.reject(error)
  }
)

export default api