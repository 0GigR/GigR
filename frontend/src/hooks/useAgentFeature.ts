/**
 * useAgentFeature.ts — Client-side subscription and feature gate evaluation.
 *
 * Checks feature flags alongside the user's subscription tier.
 * When VITE_FEATURE_AGENT_PREMIUM is false (the default), all agent features
 * remain unlocked. When true, designated advanced capabilities require
 * 'pro' or 'enterprise' subscription tier.
 *
 * House Standard Compliance:
 * - Zero emojis
 * - No banned variable names
 */

import { useMemo } from 'react'
import { useAuthStore } from '@/store/authStore'
import { isFeatureEnabled } from '@/lib/featureFlags'

export type PremiumFeatureKey =
  | 'planner'
  | 'smartApply'
  | 'streaming'
  | 'proactiveHunt'
  | 'autoNegotiate'
  | 'extendedContext'

const PREMIUM_FEATURES: ReadonlySet<string> = new Set([
  'planner',
  'smartApply',
  'streaming',
  'proactiveHunt',
  'autoNegotiate',
  'extendedContext',
])

export function useAgentFeature(featureKey?: PremiumFeatureKey) {
  const user = useAuthStore((state) => state.user)
  const isGateActive = isFeatureEnabled('premiumGate')

  const userTier = useMemo(() => {
    return (user?.subscription_tier || 'free').toLowerCase()
  }, [user])

  const isProOrEnterprise = userTier === 'pro' || userTier === 'enterprise'

  const canAccess = useMemo(() => {
    return (feature: PremiumFeatureKey): boolean => {
      // If paywall gate is disabled globally, everything is accessible
      if (!isGateActive) return true
      // Pro and Enterprise users have access to all agent capabilities
      if (isProOrEnterprise) return true
      // Free users only have access if it is not in the premium set
      return !PREMIUM_FEATURES.has(feature)
    }
  }, [isGateActive, isProOrEnterprise])

  const isLocked = useMemo(() => {
    if (!featureKey) return false
    return !canAccess(featureKey)
  }, [featureKey, canAccess])

  return {
    isLocked,
    isGateActive,
    userTier,
    canAccess,
  }
}
