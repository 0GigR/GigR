import { useQuery } from '@tanstack/react-query'
import api from '@/lib/api'
import { useRailStore, type PaymentRail } from '@/store/railStore'

/**
 * Public runtime config from GET /api/v1/config/public.
 *
 * Both payment rails run side by side. The toggle stores the user's choice and
 * `lib/api` sends it as `X-Payment-Rail`; the backend answers with the rail it
 * is using for this browser. Everything belonging to the *other* rail (wallets,
 * USDC, cNFT vouches, PayPal checkout) is hidden by reading that answer — never
 * by a build-time flag. With Solana selected the app is the original one.
 */
export type { PaymentRail }

export interface AppConfig {
  payment_rail: PaymentRail
  default_rail?: PaymentRail
  available_rails?: PaymentRail[]
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
  const choice = useRailStore((s) => s.choice)
  return useQuery<AppConfig>({
    queryKey: ['app-config', choice],
    queryFn: async () => {
      const { data } = await api.get('/config/public')
      return data
    },
    staleTime: 5 * 60_000,
    retry: 1,
  })
}

/** Which rail is live for this browser, with convenience flags. */
export function useRail() {
  const { data, isLoading } = useAppConfig()
  const choice = useRailStore((s) => s.choice)
  // Until the config loads, show the original (Solana) look rather than flashing PayPal.
  const rail: PaymentRail = data?.payment_rail ?? choice ?? 'solana'
  const rails: PaymentRail[] = data?.available_rails ?? []
  return {
    rail,
    isPayPal: rail === 'paypal',
    isSolana: rail === 'solana',
    rails,
    canSwitch: rails.length > 1,
    paypalEnabled: data?.paypal.enabled ?? false,
    paypalEnv: data?.paypal.env ?? 'sandbox',
    feePercent: data?.paypal.fee_percent ?? 0,
    config: data,
    isLoading,
  }
}
