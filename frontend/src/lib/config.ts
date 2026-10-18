import { useQuery } from '@tanstack/react-query'
import api from '@/lib/api'
import { PAYMENT_RAIL, type PaymentRail } from '@/lib/rail'

/**
 * Public runtime config from GET /api/v1/config/public.
 *
 * The rail is a build-time choice (VITE_PAYMENT_RAIL, see lib/rail) that `lib/api`
 * sends as `X-Payment-Rail`; the backend has no rail setting of its own. This
 * endpoint reports PayPal details (env, currency, fee) and which rails the
 * backend has credentials for. Everything belonging to the other rail (wallets,
 * USDC, cNFT vouches, PayPal checkout) is hidden by reading the rail below.
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

/** Which rail this build uses, with convenience flags. Known synchronously: no flash of the wrong UI. */
export function useRail() {
  const { data, isLoading } = useAppConfig()
  const rail: PaymentRail = PAYMENT_RAIL
  const rails: PaymentRail[] = data?.available_rails ?? []
  return {
    rail,
    isPayPal: rail === 'paypal',
    isSolana: rail === 'solana',
    /** False when the backend has no credentials for this build's rail. */
    railConfigured: isLoading || rails.length === 0 || rails.includes(rail),
    paypalEnabled: data?.paypal.enabled ?? false,
    paypalEnv: data?.paypal.env ?? 'sandbox',
    feePercent: data?.paypal.fee_percent ?? 0,
    config: data,
    isLoading,
  }
}
