import { describe, it, expect, vi } from 'vitest'
import api from '@/lib/api'
import { PAYMENT_RAIL } from '@/lib/rail'

describe('payment rail', () => {
  it('defaults to solana when VITE_PAYMENT_RAIL is unset', () => {
    expect(import.meta.env.VITE_PAYMENT_RAIL).toBeUndefined()
    expect(PAYMENT_RAIL).toBe('solana')
  })

  it('is added to every outgoing request by the api client', async () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
    // The request interceptor runs for every method, so every call carries it.
    const handlers = (api.interceptors.request as unknown as {
      handlers: { fulfilled: (c: { headers: Record<string, string> }) => Promise<{ headers: Record<string, string> }> | { headers: Record<string, string> } }[]
    }).handlers
    for (const h of handlers.filter(Boolean)) {
      const out = await h.fulfilled({ headers: {} })
      expect(out.headers['X-Payment-Rail']).toBe('solana')
    }
    expect(handlers.length).toBeGreaterThan(0)
  })
})
