/**
 * CurrencySelect — lets the signed-in user pick the currency prices are
 * DISPLAYED in (default NGN). Stored/settled amounts are always Naira; this
 * only changes formatting. Switching updates mounted prices in place via the
 * currency store — it never reloads the page.
 */
import { CURRENCIES, type CurrencyCode } from '@/lib/currency'
import { useCurrencyStore, applyDisplayCurrency } from '@/store/currencyStore'
import { toast } from 'sonner'

export function CurrencySelect() {
  const code = useCurrencyStore((s) => s.code)

  return (
    <select
      value={code}
      title="Display currency — amounts are stored & settled in Naira and shown converted"
      aria-label="Display currency"
      onChange={async (e) => {
        const picked = e.target.value as CurrencyCode
        if (picked === code) return
        const ok = await applyDisplayCurrency(picked)
        if (!ok) {
          toast.error('Could not load exchange rates — staying in Naira.')
        }
      }}
      className="h-9 rounded-lg border border-gray-300 bg-white px-2 text-xs font-medium text-gray-700 outline-none transition-colors hover:border-gray-400 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-200"
    >
      {CURRENCIES.map((c) => (
        <option key={c.code} value={c.code}>
          {c.code}
        </option>
      ))}
    </select>
  )
}
