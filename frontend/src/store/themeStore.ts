import { create } from 'zustand'

type Theme = 'light' | 'dark'

interface ThemeState {
  theme: Theme
  toggle: () => void
}

// Apply theme immediately on module load to prevent flash on refresh
const _stored = (localStorage.getItem('theme') as Theme) || 'light'
document.documentElement.classList.toggle('dark', _stored === 'dark')

export const useThemeStore = create<ThemeState>((set) => ({
  theme: _stored,
  toggle: () => {
    set((state) => {
      const newTheme = state.theme === 'dark' ? 'light' : 'dark'
      localStorage.setItem('theme', newTheme)
      document.documentElement.classList.toggle('dark', newTheme === 'dark')
      return { theme: newTheme }
    })
  },
}))