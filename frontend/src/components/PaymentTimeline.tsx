import { useQuery } from '@tanstack/react-query'
import { ShieldCheck, ArrowDownToLine, ArrowUpFromLine, Undo2, AlertTriangle, Clock } from 'lucide-react'
import api from '@/lib/api'
import { useRail } from '@/lib/config'
import { KIND_LABEL, type JobPayment } from '@/lib/paypal'

const STATE_COPY: Record<JobPayment['state'], { label: string; tone: string }> = {
  unfunded: { label: 'Not funded yet', tone: 'text-gray-600 bg-gray-100' },
  awaiting_approval: { label: 'Waiting for PayPal approval', tone: 'text-amber-700 bg-amber-50' },
  escrowed: { label: 'Held in escrow', tone: 'text-blue-700 bg-blue-50' },
  released: { label: 'Paid to provider', tone: 'text-green-700 bg-green-50' },
  refunded: { label: 'Refunded to client', tone: 'text-purple-700 bg-purple-50' },
}

const KIND_ICON: Record<string, typeof ShieldCheck> = {
  order_created: Clock,
  captured: ArrowDownToLine,
  payout_sent: ArrowUpFromLine,
  refunded: Undo2,
  failed: AlertTriangle,
}

const fmt = (n: number | null, cur = 'USD') =>
  n == null ? '' : new Intl.NumberFormat(undefined, { style: 'currency', currency: cur }).format(n)

/**
 * The money's journey for one job, straight from the PayPal ledger: checkout →
 * escrowed → paid out / refunded. Shown in the contract room so both parties can
 * see exactly where the funds are and which PayPal transaction ids back it.
 */
export function PaymentTimeline({ jobId }: { jobId: string }) {
  const { isPayPal } = useRail()
  const { data } = useQuery<JobPayment>({
    queryKey: ['job-payment', jobId],
    queryFn: async () => (await api.get(`/jobs/${jobId}/payment`)).data,
    enabled: isPayPal && !!jobId,
    refetchInterval: 15000,
  })

  if (!isPayPal || !data || data.rail !== 'paypal') return null
  const state = STATE_COPY[data.state]

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-3 text-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <ShieldCheck className="h-4 w-4 text-blue-600" />
          PayPal escrow
        </div>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${state.tone}`}>{state.label}</span>
      </div>

      {data.amount != null && (
        <p className="mt-1 text-xs text-gray-500">
          {fmt(data.amount, data.currency)} {data.currency}
          {data.payout_status ? ` · payout ${data.payout_status.toLowerCase()}` : ''}
        </p>
      )}

      {data.events.length > 0 && (
        <ol className="mt-2 space-y-1.5 border-l border-gray-200 pl-3 dark:border-gray-700">
          {data.events.map((e, i) => {
            const Icon = KIND_ICON[e.kind] ?? Clock
            return (
              <li key={`${e.kind}-${i}`} className="relative text-xs">
                <Icon className="absolute -left-[22px] top-0.5 h-3.5 w-3.5 rounded-full bg-white text-gray-500 dark:bg-gray-900" />
                <span className="font-medium">{KIND_LABEL[e.kind] ?? e.kind}</span>
                {e.amount != null && <span className="text-gray-500"> · {fmt(e.amount, e.currency ?? 'USD')}</span>}
                {e.paypal_id && (
                  <span className="ml-1 font-mono text-[10px] text-gray-400">{e.paypal_id.slice(0, 14)}</span>
                )}
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
