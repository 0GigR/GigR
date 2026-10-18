/**
 * PremiumGate.tsx — Visual lock and upgrade overlay for premium agent capabilities.
 *
 * When VITE_FEATURE_AGENT_PREMIUM is enabled and the user is not on a Pro tier,
 * renders a sleek blurred preview with a non-intrusive upgrade banner.
 * When the feature gate is inactive or user is Pro, passes through children unaltered.
 *
 * House Standard Compliance:
 * - Zero emojis
 * - No banned variable names
 * - Status tags use strict typography ([PRO TIER])
 */

import React from 'react'
import { Sparkles, Lock, ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { useAgentFeature, type PremiumFeatureKey } from '@/hooks/useAgentFeature'

interface PremiumGateProps {
  featureKey: PremiumFeatureKey
  featureTitle?: string
  featureDescription?: string
  children: React.ReactNode
  className?: string
}

export default function PremiumGate({
  featureKey,
  featureTitle = 'Pro Agent Capability',
  featureDescription = 'Upgrade your account to unlock this autonomous background capability.',
  children,
  className = '',
}: PremiumGateProps) {
  const { isLocked } = useAgentFeature(featureKey)

  if (!isLocked) {
    return <>{children}</>
  }

  return (
    <div className={`relative overflow-hidden rounded-xl ${className}`}>
      {/* Blurred background preview */}
      <div className="filter blur-[3px] opacity-40 pointer-events-none select-none" aria-hidden="true">
        {children}
      </div>

      {/* Lock overlay */}
      <div className="absolute inset-0 z-10 flex flex-col items-center justify-center p-6 bg-gray-950/70 backdrop-blur-md text-center">
        <div className="w-10 h-10 rounded-full bg-violet-950/80 border border-violet-500/40 flex items-center justify-center mb-3 shadow-[0_0_20px_rgba(124,58,237,0.3)]">
          <Lock className="w-5 h-5 text-violet-400" />
        </div>

        <div className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-violet-900/40 border border-violet-500/30 text-violet-300 text-[11px] font-mono mb-2">
          <Sparkles className="w-3 h-3" />
          <span>[PRO TIER]</span>
        </div>

        <h4 className="text-base font-semibold text-white mb-1">{featureTitle}</h4>
        <p className="text-xs text-gray-400 max-w-sm mb-4 leading-relaxed">{featureDescription}</p>

        <Button
          asChild
          size="sm"
          className="bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 text-white font-medium text-xs shadow-lg shadow-violet-600/20"
        >
          <Link to="/dashboard/profile">
            Upgrade to Pro
            <ArrowRight className="w-3.5 h-3.5 ml-1.5" />
          </Link>
        </Button>
      </div>
    </div>
  )
}
