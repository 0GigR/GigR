import api from '@/lib/api'

/** Result of POST /jobs/{id}/paypal/checkout. */
export interface PayPalCheckout {
  order_id: string
  approval_url: string
  amount: number
  currency: string
  status: string
}

/** Where this job's money is, plus every PayPal step (GET /jobs/{id}/payment). */
export interface JobPayment {
  rail: 'paypal' | 'solana'
  state: 'unfunded' | 'awaiting_approval' | 'escrowed' | 'released' | 'refunded'
  amount: number | null
  currency: string
  order_id: string | null
  capture_id: string | null
  payout_batch_id: string | null
  payout_status: string | null
  /** Staged jobs: one entry per milestone that has a PayPal order or capture. */
  milestones?: Array<{ id: string; title: string; status: string; amount_usd: number | null; payout_status: string | null }>
  fee_percent: number
  events: Array<{
    kind: string
    paypal_id: string | null
    amount: number | null
    currency: string | null
    status: string | null
    detail: string | null
    created_at: string | null
  }>
}

/** One row of the payments ledger (GET /payments/mine, /payments/admin/ledger). */
export interface LedgerEvent {
  id: string
  created_at: string | null
  kind: string
  job_id: string | null
  job_title: string | null
  paypal_id: string | null
  amount: number | null
  currency: string | null
  status: string | null
  detail: string | null
}

/**
 * Start funding a job's escrow through PayPal and send the client to approve it.
 * Nothing is charged until they approve; PayPal returns them to
 * /dashboard/paypal/return which captures the payment into escrow.
 */
export async function startPayPalCheckout(jobId: string): Promise<PayPalCheckout> {
  const { data } = await api.post<PayPalCheckout>(`/jobs/${jobId}/paypal/checkout`)
  return data
}

/** Same, for one milestone of a job that is paid in stages. */
export async function startMilestoneCheckout(jobId: string, milestoneId: string): Promise<PayPalCheckout> {
  const { data } = await api.post<PayPalCheckout>(`/jobs/${jobId}/milestones/${milestoneId}/paypal/checkout`)
  return data
}

export function redirectToPayPal(checkout: PayPalCheckout): void {
  window.location.assign(checkout.approval_url)
}

export const KIND_LABEL: Record<string, string> = {
  order_created: 'Checkout started',
  captured: 'Funds escrowed',
  payout_sent: 'Paid to provider',
  refunded: 'Refunded to client',
  failed: 'Needs attention',
  webhook: 'PayPal event',
}
