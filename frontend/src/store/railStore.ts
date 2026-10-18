import { create } from 'zustand'

export type PaymentRail = 'paypal' | 'solana'

const KEY = 'gigr_payment_rail'

function load(): PaymentRail | null {
  try {
    const v = localStorage.getItem(KEY)
    return v === 'paypal' || v === 'solana' ? v : null
  } catch {
    return null
  }
}

interface RailState {
  /** The rail this browser chose with the toggle; null = use the server default. */
  choice: PaymentRail | null
  setChoice: (rail: PaymentRail) => void
}

export const useRailStore = create<RailState>((set) => ({
  choice: load(),
  setChoice: (rail) => {
    try {
      localStorage.setItem(KEY, rail)
    } catch {
      /* private mode: the choice just lasts for this session */
    }
    set({ choice: rail })
  },
}))

/** Read outside React (the axios interceptor). */
export const getRailChoice = (): PaymentRail | null => useRailStore.getState().choice
