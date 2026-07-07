import { create } from 'zustand'
import api, { saveToken, clearToken } from '@/lib/api'

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
  googleAuth: (token: string) => Promise<void>
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
    }
    const userRes = await api.get('/auth/me')
    set({ user: userRes.data })
  },

  googleAuth: async (token) => {
    // Backend returns { access_token, token_type } AND sets HttpOnly cookies.
    const res = await api.post('/auth/google', { token })
    if (res.data?.access_token) {
      saveToken(res.data.access_token)
    }
    const userRes = await api.get('/auth/me')
    set({ user: userRes.data })
  },

  logout: async () => {
    try {
      await api.post('/auth/logout')
    } catch {}
    clearToken()
    set({ user: null })
  },
}))