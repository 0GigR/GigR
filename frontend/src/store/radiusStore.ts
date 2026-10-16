/**
 * radiusStore.ts — Global search radius configuration persisted across the app.
 *
 * Controls proximity filtering in:
 * - HomePage nearby feed
 * - ServicesPage search & map
 * - JobsPage search & map
 * - MapExplorer
 * - AI Agent command dispatch
 *
 * A radiusKm value of 0 represents "Worldwide / No limit".
 */

import { create } from 'zustand'

const STORAGE_KEY = 'gigr-search-radius-km'
const DEFAULT_RADIUS_KM = 10

export interface RadiusPreset {
  value: number
  label: string
  detail: string
}

export const RADIUS_PRESETS: RadiusPreset[] = [
  { value: 0.2, label: '200 m', detail: 'Street' },
  { value: 0.5, label: '500 m', detail: 'Block' },
  { value: 1, label: '1 km', detail: 'Close' },
  { value: 3, label: '3 km', detail: 'Local' },
  { value: 5, label: '5 km', detail: 'District' },
  { value: 10, label: '10 km', detail: 'City' },
  { value: 25, label: '25 km', detail: 'Metro' },
  { value: 50, label: '50 km', detail: 'State' },
  { value: 0, label: 'All', detail: 'Worldwide' },
]

export function formatRadiusLabel(km: number): string {
  if (km <= 0) return 'Worldwide'
  if (km < 1) return `${Math.round(km * 1000)} m`
  return `${km} km`
}

export function formatRadiusDescription(km: number): string {
  if (km <= 0) return 'Worldwide (no distance limit)'
  if (km <= 0.3) return 'Street level (~200 m)'
  if (km <= 0.8) return 'Immediate neighborhood (~500 m)'
  if (km <= 2) return 'Walking distance (~1-2 km)'
  if (km <= 7) return 'Local district (~5 km)'
  if (km <= 15) return 'City area (~10 km)'
  if (km <= 35) return 'Metropolitan area (~25 km)'
  return `Extended region (~${km} km)`
}

function readStoredRadius(): number {
  try {
    if (typeof window === 'undefined') return DEFAULT_RADIUS_KM
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return DEFAULT_RADIUS_KM
    const parsed = parseFloat(raw)
    return isNaN(parsed) || parsed < 0 ? DEFAULT_RADIUS_KM : parsed
  } catch {
    return DEFAULT_RADIUS_KM
  }
}

interface RadiusStoreState {
  radiusKm: number
  setRadiusKm: (radius: number) => void
}

export const useRadiusStore = create<RadiusStoreState>((set) => ({
  radiusKm: readStoredRadius(),
  setRadiusKm: (radiusKm: number) => {
    const clamped = Math.max(0, Number(radiusKm) || 0)
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(STORAGE_KEY, String(clamped))
      }
    } catch {
      // Storage unavailable
    }
    set({ radiusKm: clamped })
  },
}))
