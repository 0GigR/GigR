import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Bot, Check, Loader2, RefreshCw, Scale } from 'lucide-react'
import api, { extractError } from '@/lib/api'
import { Button } from '@/components/ui/button'

export interface AiRecommendation {
  outcome: 'release' | 'refund' | 'split'
  provider_percent: number | null
  confidence: number
  rationale: string
  key_facts: string[]
  evidence_gaps: string[]
  source: 'ai' | 'heuristic'
  model?: string | null
  generated_at?: string
}

const OUTCOME_COPY: Record<AiRecommendation['outcome'], { title: string; tone: string }> = {
  release: { title: 'Pay the provider in full', tone: 'bg-green-100 dark:bg-green-950/50 text-green-800 dark:text-green-400' },
  refund: { title: 'Refund the client in full', tone: 'bg-purple-100 dark:bg-purple-950/50 text-purple-800 dark:text-purple-400' },
  split: { title: 'Split the escrow', tone: 'bg-amber-100 dark:bg-amber-950/50 text-amber-800 dark:text-amber-400' },
}

/**
 * The AI arbiter's recommendation for a dispute. It reads the chat, amendments
 * and work-submission record and proposes release / refund / split — but a human
 * admin applies it, and only then does the PayPal payout / refund happen.
 */
export function AiArbiterPanel({
  disputeId,
  recommendation,
  escrowedUsd,
  paymentState,
}: {
  disputeId: string
  recommendation?: AiRecommendation | null
  escrowedUsd?: number | null
  paymentState?: string | null
}) {
  const queryClient = useQueryClient()
  const [manualPct, setManualPct] = useState(50)

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['admin-disputes'] })
    queryClient.invalidateQueries({ queryKey: ['payments-ledger'] })
  }

  const rerun = useMutation({
    mutationFn: async () => (await api.post(`/disputes/${disputeId}/ai-recommendation`)).data,
    onSuccess: () => {
      toast.success('AI review updated')
      refresh()
    },
    onError: (err) => toast.error(extractError(err, 'AI review failed')),
  })

  const apply = useMutation({
    mutationFn: async () => (await api.post(`/disputes/${disputeId}/apply-recommendation`)).data,
    onSuccess: () => {
      toast.success('Recommendation applied — PayPal has been instructed.')
      refresh()
    },
    onError: (err) => toast.error(extractError(err, 'Could not apply the recommendation')),
  })

  const splitManually = useMutation({
    mutationFn: async () =>
      (await api.post(`/disputes/${disputeId}/resolve`, { resolution: 'split', provider_percent: manualPct })).data,
    onSuccess: () => {
      toast.success(`Escrow split ${manualPct}% / ${100 - manualPct}% via PayPal.`)
      refresh()
    },
    onError: (err) => toast.error(extractError(err, 'Split failed')),
  })

  const money = (pct: number) =>
    escrowedUsd != null ? ` (${new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format((escrowedUsd * pct) / 100)})` : ''

  const rec = recommendation
  const busy = apply.isPending || splitManually.isPending

  return (
    <div className="rounded-xl border border-blue-100 bg-blue-50/50 p-3 text-sm dark:border-blue-900/40 dark:bg-blue-950/20">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-semibold text-blue-900 dark:text-blue-200">
          <Bot className="h-4 w-4" /> AI arbiter
          {rec && (
            <span className="rounded-full bg-white px-2 py-0.5 text-[11px] font-medium text-gray-600 dark:text-muted-foreground dark:bg-muted">
              {rec.source === 'ai' ? 'AI-reviewed' : 'rule-based fallback'}
            </span>
          )}
        </div>
        <Button size="sm" variant="ghost" onClick={() => rerun.mutate()} disabled={rerun.isPending}>
          {rerun.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          <span className="ml-1">{rec ? 'Re-run' : 'Run review'}</span>
        </Button>
      </div>

      {!rec && <p className="mt-2 text-xs text-gray-500 dark:text-muted-foreground">No recommendation yet. Run the AI review to get one.</p>}

      {rec && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${OUTCOME_COPY[rec.outcome].tone}`}>
              {OUTCOME_COPY[rec.outcome].title}
              {rec.outcome === 'split' && rec.provider_percent != null
                ? ` — ${rec.provider_percent}% provider / ${100 - rec.provider_percent}% client${money(rec.provider_percent)}`
                : ''}
            </span>
            <span className="text-xs text-gray-500 dark:text-muted-foreground">confidence {Math.round(rec.confidence * 100)}%</span>
          </div>
          <p className="text-gray-700 dark:text-muted-foreground">{rec.rationale}</p>
          {rec.key_facts.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-gray-600 dark:text-muted-foreground">
              {rec.key_facts.map((f, i) => (
                <li key={i}>{f}</li>
              ))}
            </ul>
          )}
          {rec.evidence_gaps.length > 0 && (
            <p className="text-xs text-amber-700 dark:text-amber-400">Missing evidence: {rec.evidence_gaps.join('; ')}</p>
          )}
          <Button size="sm" onClick={() => apply.mutate()} disabled={busy || paymentState === 'released'}>
            {apply.isPending ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <Check className="mr-1 h-3.5 w-3.5" />}
            Apply recommendation via PayPal
          </Button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-blue-100 pt-3 dark:border-blue-900/40">
        <Scale className="h-4 w-4 text-gray-500 dark:text-muted-foreground" />
        <span className="text-xs text-gray-600 dark:text-muted-foreground">Decide yourself — provider gets</span>
        <input
          type="range"
          min={1}
          max={99}
          value={manualPct}
          onChange={(e) => setManualPct(Number(e.target.value))}
          className="w-32 accent-blue-600"
          aria-label="Provider share percent"
        />
        <span className="w-24 text-xs font-medium">
          {manualPct}%{money(manualPct)}
        </span>
        <Button size="sm" variant="outline" onClick={() => splitManually.mutate()} disabled={busy}>
          {splitManually.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Split'}
        </Button>
      </div>
    </div>
  )
}
