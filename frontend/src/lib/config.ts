import { useQuery } from '@tanstack/react-query'
import api from '@/lib/api'

/**
 * Public runtime config from GET /api/v1/config/public.
 *
 * The backend's single PAYMENT_RAIL switch decides which payment rail the whole
 * app runs on. Everything belonging to the *other* rail (wallets, USDC, cNFT
 * vouches) is hidden by reading it from here — never by a build-time flag — so
 * flipping one env var on the server flips the UI with no redeploy.
 */
export type PaymentRail = 'paypal' | 'solana'

export interface AppConfig {
  payment_rail: PaymentRail
  paypal: {
    enabled: boolean
    env: 'sandbox' | 'live'
    currency: string
    fee_percent: number
  }
  features: {
    wallet: boolean
    onchain_vouches: boolean
    paypal_checkout: boolean
  }
}

export function useAppConfig() {
  return useQuery<AppConfig>({
    queryKey: ['app-config'],
    queryFn: async () => {
      const { data } = await api.get('/config/public')
      return data
    },
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

/** Which rail is live, with convenience flags. Defaults to PayPal until loaded. */
export function useRail() {
  const { data, isLoading } = useAppConfig()
  const rail: PaymentRail = data?.payment_rail ?? 'paypal'
  return {
    rail,
    isPayPal: rail === 'paypal',
    isSolana: rail === 'solana',
    paypalEnabled: data?.paypal.enabled ?? false,
    paypalEnv: data?.paypal.env ?? 'sandbox',
    feePercent: data?.paypal.fee_percent ?? 0,
    config: data,
    isLoading,
  }
}
