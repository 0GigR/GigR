/**
 * PriceInput — a currency-aware price entry field.
 *
 * Gigr stores and settles every price in Naira (NGN). This input keeps that
 * invariant: its `value`/`onChange` are always the CANONICAL NGN amount (as a
 * plain string), so every existing submit handler, draft and prefill keeps
 * working untouched.
 *
 * When the user's display currency is not NGN (and a rate is cached), the field
 * instead lets them TYPE in that currency and converts to the canonical NGN
 * amount behind the scenes. When the currency is NGN — or a rate isn't available
 * yet — it behaves exactly like a plain ₦ number field.
 */
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { useCurrencyStore } from '@/store/currencyStore'
import { cn } from '@/lib/utils'

interface PriceInputProps {
  /** Canonical Naira amount as stored ('' when unset). */
  value: string
  /** Called with the new canonical Naira amount ('' when cleared). */
  onChange: (naira: string) => void
  placeholder?: string
  className?: string
  inputClassName?: string
  id?: string
  disabled?: boolean
  /** Show a "= ₦…" caption while entering in a non-Naira currency. */
  showEquivalent?: boolean
}

/** Keep digits and a single decimal point — currency text only. */
function sanitize(raw: string): string {
  return raw.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1')
}

/** Plain-digits form of a number (up to 2 decimals, no trailing zeros). */
function toPlain(value: number): string {
  if (!Number.isFinite(value)) return ''
  return value.toFixed(2).replace(/\.?0+$/, '')
}

/** What the field should display for a stored Naira amount. */
function fieldTextFor(value: string, code: string, rate: number | null): string {
  if (!value) return ''
  if (code === 'NGN' || rate == null || rate <= 0) return value
  const naira = parseFloat(value)
  if (!Number.isFinite(naira) || naira <= 0) return ''
  return toPlain(naira * rate)
}

export function PriceInput({
  value,
  onChange,
  placeholder,
  className,
  inputClassName,
  id,
  disabled,
  showEquivalent = true,
}: PriceInputProps) {
  const code = useCurrencyStore((s) => s.code)
  const rates = useCurrencyStore((s) => s.rates)
  const rate = code === 'NGN' ? null : (rates?.[code] ?? null)
  const displayMode = code !== 'NGN' && rate != null && rate > 0

  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState(() => fieldTextFor(value, code, rate))

  const shown = focused ? draft : fieldTextFor(value, code, rate)

  const handleChange = (raw: string) => {
    const clean = sanitize(raw)
    setDraft(clean)
    if (clean === '') {
      onChange('')
      return
    }
    const num = Number(clean)
    if (!Number.isFinite(num)) return
    if (displayMode && rate != null) {
      onChange(String(Math.round(num / rate)))
    } else {
      onChange(clean)
    }
  }

  const handleFocus = () => {
    setDraft(fieldTextFor(value, code, rate))
    setFocused(true)
  }

  const nairaNum = parseFloat(value)
  const canonicalNgn = Number.isFinite(nairaNum) ? nairaNum : 0

  return (
    <div className={className}>
      <div className="relative">
        <Input
          id={id}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={shown}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => handleChange(e.target.value)}
          onFocus={handleFocus}
          onBlur={() => setFocused(false)}
          aria-label={placeholder || 'Price'}
          className={cn('pr-12', inputClassName)}
        />
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-gray-400">
          {displayMode ? code : '₦'}
        </span>
      </div>
      {showEquivalent && displayMode && canonicalNgn > 0 && value !== '' && (
        <p className="mt-1 text-xs text-gray-500 dark:text-muted-foreground">
          = ₦{Math.round(canonicalNgn).toLocaleString()} <span className="text-gray-400">(stored in Naira)</span>
        </p>
      )}
    </div>
  )
}
