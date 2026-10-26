import { Navigate } from 'react-router-dom'
import { ShieldCheck } from 'lucide-react'
import { useRail } from '@/lib/config'
import { PaymentsLedger } from '@/components/PaymentsLedger'

/** A signed-in user's own payment history: every PayPal step on their jobs. */
export default function PaymentsPage() {
  const { isPayPal, isLoading } = useRail()
  if (!isLoading && !isPayPal) return <Navigate to="/dashboard" replace />

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 md:p-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <ShieldCheck className="h-6 w-6 text-blue-600 dark:text-blue-400" /> Payments
        </h1>
        <p className="mt-1 text-sm text-gray-500 dark:text-muted-foreground">
          Every escrow step on your jobs — checkout, funds held, payouts and refunds — straight from PayPal.
        </p>
      </div>
      <PaymentsLedger scope="mine" />
    </div>
  )
}
