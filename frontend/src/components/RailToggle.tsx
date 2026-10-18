import { useQueryClient } from '@tanstack/react-query'
import { useRail } from '@/lib/config'
import { useRailStore, type PaymentRail } from '@/store/railStore'

const LABEL: Record<PaymentRail, string> = { solana: 'Solana', paypal: 'PayPal' }

/** Switches this browser between the Solana and PayPal payment rails. Hidden unless both are configured. */
export function RailToggle({ className = '' }: { className?: string }) {
  const { rail, rails, canSwitch } = useRail()
  const setChoice = useRailStore((s) => s.setChoice)
  const qc = useQueryClient()

  if (!canSwitch) return null

  const pick = (next: PaymentRail) => {
    if (next === rail) return
    setChoice(next)
    // Everything on screen (wallet, payments, job funding) depends on the rail.
    qc.invalidateQueries()
  }

  return (
    <div
      role="group"
      aria-label="Payment method"
      className={`inline-flex rounded-full border border-gray-200 dark:border-gray-700 p-0.5 text-xs font-medium ${className}`}
    >
      {rails.map((r) => (
        <button
          key={r}
          type="button"
          aria-pressed={r === rail}
          onClick={() => pick(r)}
          className={`rounded-full px-2.5 py-1 transition-colors ${
            r === rail
              ? 'bg-black text-white dark:bg-white dark:text-black'
              : 'text-gray-500 hover:text-gray-900 dark:hover:text-gray-100'
          }`}
        >
          {LABEL[r]}
        </button>
      ))}
    </div>
  )
}
