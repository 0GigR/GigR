import axios from 'axios'
import { useAuthStore } from '@/store/authStore'
import { toast } from 'sonner'
import { PAYMENT_RAIL } from '@/lib/rail'

// ── Token helpers ────────────────────────────────────────────────────────────
// We persist the access_token in localStorage as a fallback for cross-site
// environments (Vercel + Render) where Chrome blocks third-party cookies.
// The backend already accepts both HttpOnly cookie AND Authorization header.
const TOKEN_KEY = 'baros_access_token'
// Kept next to the access token so a session survives environments where
// third-party cookies are blocked outright (iOS Safari, installed PWAs). The
// backend rotates this on every refresh, so it keeps sliding forward.
const REFRESH_KEY = 'baros_refresh_token'

export const saveToken = (token: string) => localStorage.setItem(TOKEN_KEY, token)
export const clearToken = () => localStorage.removeItem(TOKEN_KEY)
export const getToken = () => localStorage.getItem(TOKEN_KEY)

export const saveRefreshToken = (token: string) => localStorage.setItem(REFRESH_KEY, token)
export const getRefreshToken = () => localStorage.getItem(REFRESH_KEY)
export const clearRefreshToken = () => localStorage.removeItem(REFRESH_KEY)
export const clearTokens = () => {
  clearToken()
  clearRefreshToken()
}

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
  // Which payment rail this frontend build uses (VITE_PAYMENT_RAIL).
  config.headers['X-Payment-Rail'] = PAYMENT_RAIL
  return config
})

// ── Shared single-flight refresh promise to prevent concurrent 401 races ───
let refreshPromise: Promise<string | null> | null = null

async function requestTokenRefresh(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      try {
        const storedRefresh = getRefreshToken()
        const res = await axios.post(
          `${import.meta.env.VITE_API_URL || '/api/v1'}/auth/refresh`,
          storedRefresh ? { refresh_token: storedRefresh } : {},
          { withCredentials: true, headers: { 'Content-Type': 'application/json' } }
        )
        const { access_token, refresh_token } = res.data ?? {}
        if (access_token) saveToken(access_token)
        if (refresh_token) saveRefreshToken(refresh_token)
        return access_token || null
      } catch {
        clearTokens()
        useAuthStore.getState().logout()
        return null
      } finally {
        refreshPromise = null
      }
    })()
  }
  return refreshPromise
}

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

      // Guests with no stored tokens at all: /auth/me failing 401 is expected.
      // Do not attempt a pointless refresh or bounce them away from public pages.
      const storedRefresh = getRefreshToken()
      const storedToken = getToken()
      if (!storedRefresh && !storedToken) {
        return Promise.reject(error)
      }

      const newAccessToken = await requestTokenRefresh()
      if (newAccessToken) {
        originalRequest.headers['Authorization'] = `Bearer ${newAccessToken}`
        return api(originalRequest)
      }

      const currentPath = typeof window !== 'undefined' ? window.location.pathname : ''
      const isPublicPage =
        currentPath === '/' ||
        currentPath.startsWith('/profile') ||
        currentPath.startsWith('/user') ||
        currentPath.startsWith('/login') ||
        currentPath.startsWith('/register') ||
        currentPath.startsWith('/forgot-password') ||
        currentPath.startsWith('/reset-password')

      if (!isPublicPage && typeof window !== 'undefined') {
        window.location.href = '/'
      }
      return Promise.reject(error)
    }

    // Handle generic 400 errors (payment, validation, etc.) with a toast
    if (error.response?.status === 400 && error.response?.data?.detail) {
      toast.error(error.response.data.detail)
    }

    return Promise.reject(error)
  }
)
export default api

/**
 * Extracts a human-readable error message from an API exception.
 * Intelligently handles network failures and timeouts.
 */
export function extractError(err: any, fallback: string): string {
  if (!err.response) {
    if (err.code === 'ECONNABORTED' || err.message?.includes('timeout')) {
      return 'Request timed out. Please check your connection and try again.'
    }
    return 'Network request failed. Please check your internet connection.'
  }
  
  if (err.response?.data?.detail) {
    const detail = err.response.data.detail
    return typeof detail === 'string' ? detail : JSON.stringify(detail)
  }
  
  if (err.response?.data?.error?.message) {
    return err.response.data.error.message
  }
  
  return fallback
}