import { create } from 'zustand'
import api, { saveToken, saveRefreshToken, clearTokens } from '@/lib/api'

interface User {
  id: string
  email: string
  display_name: string
  phone_number?: string | null
  profile_image_url?: string | null
  google_id?: string | null
  is_verified: boolean
  created_at: string
  role?: string | null
  ai_enabled?: boolean
  subscription_tier?: string | null
  location_public?: boolean
  permissions?: string[] | null
  /** Server-side UI preferences (onboarding dismissal and similar). */
  ui_settings?: Record<string, unknown> | null
}

interface AuthState {
  user: User | null
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (data: {
    email: string
    password?: string
    display_name: string
    phone_number?: string
  }) => Promise<void>
  googleAuth: (cred: string | { token?: string; access_token?: string }) => Promise<void>
  logout: () => Promise<void>
  fetchUser: () => Promise<void>
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,

  fetchUser: async () => {
    try {
      const res = await api.get('/auth/me')
      set({ user: res.data, isLoading: false })
    } catch {
      set({ user: null, isLoading: false })
    }
  },

  login: async (email, password) => {
    // Backend returns { access_token, token_type } AND sets HttpOnly cookies.
    // We also save to localStorage so the Bearer header fallback works in
    // cross-site deployments (Vercel + Render) where Chrome blocks cookies.
    const res = await api.post('/auth/login', { email, password })
    if (res.data?.access_token) {
      saveToken(res.data.access_token)
    }
    // Persist the rotating refresh token too, so the session survives even where
    // third-party cookies are blocked.
    if (res.data?.refresh_token) {
      saveRefreshToken(res.data.refresh_token)
    }
    const userRes = await api.get('/auth/me')
    set({ user: userRes.data })
  },

  register: async (data) => {
    await api.post('/auth/register', data)
    if (data.password) {
      const res = await api.post('/auth/login', { email: data.email, password: data.password })
      if (res.data?.access_token) {
        saveToken(res.data.access_token)
      }
      if (res.data?.refresh_token) {
        saveRefreshToken(res.data.refresh_token)
      }
    }
    const userRes = await api.get('/auth/me')
    set({ user: userRes.data })
  },

  googleAuth: async (cred) => {
    // Accepts either an ID token (classic button) or an OAuth access token
    // (custom useGoogleLogin button). Backend handles both.
    const body = typeof cred === 'string' ? { token: cred } : cred
    const res = await api.post('/auth/google', body)
    if (res.data?.access_token) {
      saveToken(res.data.access_token)
    }
    if (res.data?.refresh_token) {
      saveRefreshToken(res.data.refresh_token)
    }
    const userRes = await api.get('/auth/me')
    set({ user: userRes.data })
  },

  logout: async () => {
    try {
      await api.post('/auth/logout')
    } catch {}
    clearTokens()
    set({ user: null })
  },
}))