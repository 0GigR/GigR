/**
 * AgentAccessPage.tsx - where an external agent's x402 payment is shown and made.
 *
 * Reachable at /dashboard/agent-access from the sidebar and the mobile More
 * sheet. It exists because the x402 paid brief is not a memory setting: an agent
 * that buys a brief has no Gigr account and never visits a memory page. The page
 * owns one panel, and the panel owns the whole exchange: choose a provider, ask
 * for the quote, pay, see what was verified on chain.
 *
 * The provider is the thing chosen here. The brief endpoint is priced by job, so
 * the panel asks for that provider's most recent completed job and keeps the
 * endpoint's contract unchanged.
 *
 * House standard: zero emojis, zero decorative unicode, an honest state for
 * empty, loading, error and feature-disabled, and 44px touch targets because the
 * demo is recorded on a 390px phone.
 */

import { KeyRound } from 'lucide-react'
import { AgentPaymentsPanel } from '@/components/agent/AgentPaymentsPanel'

export default function AgentAccessPage() {
  return (
    <div className="mx-auto max-w-2xl animate-in fade-in space-y-6 duration-300">
      <div>
        <h1 className="flex items-center gap-3 text-2xl font-bold sm:text-3xl">
          <KeyRound className="h-7 w-7 text-sky-600 dark:text-sky-400" />
          Agent access
        </h1>
        <p className="mt-2 text-sm text-gray-500">
          What an outside agent can buy from Gigr, and what it pays. An agent asks for a
          brief about a provider, gets a price in USDC on Solana, pays, and Gigr checks the
          settlement on chain before it answers.
        </p>
      </div>

      <AgentPaymentsPanel />
    </div>
  )
}
