/**
 * OnChainProofPanel.tsx - "Prove it on chain": the Walrus blob as a Sui object.
 *
 * The panel exists so the claim "the memory is on Walrus" can be checked rather
 * than trusted. It verifies one Sui object id through the existing advisory
 * endpoint that the rest of this page already uses and prints what the chain
 * said: the object type, its version, who owns it and the certified epoch.
 *
 * Three rules shape it:
 *
 * 1. Only the server's `verified` answer can produce a verified badge. A
 *    missing field never becomes a green one.
 * 2. A failure is named. The backend returns a reason per failure and the panel
 *    shows that reason's own sentence; an unknown reason is still printed.
 * 3. When the deployment cannot check anything (flag off, no Tatum Sui
 *    credentials) the form is replaced by an explanation, not a dead control.
 *
 * The known-good object is verified once when the panel appears, so the demo
 * starts from live evidence. That check is read-only and is the same endpoint
 * the saved-preference Verify control calls.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CircleAlert,
  Link2,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { verifyMemoryReference } from '@/hooks/useAgentMemory'
import {
  failedVerification,
  normalizeVerification,
  verificationReasonText,
  verificationTone,
  type MemoryVerification,
  type VerificationTone,
} from '@/lib/agentMemory'
import {
  KNOWN_GOOD_SUI_OBJECT_ID,
  proofBadge,
  proofFields,
  proofUnavailableNotice,
  type ProofField,
} from '@/lib/chainProof'

const BADGE_STYLES: Record<VerificationTone, string> = {
  verified:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300',
  unverified:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300',
  unavailable:
    'border-gray-200 bg-gray-100 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300',
}

const INPUT_ID = 'sui-object-id'

interface CheckedAnswer {
  reference: string
  result: MemoryVerification
}

export function OnChainProofPanel() {
  const [reference, setReference] = useState(KNOWN_GOOD_SUI_OBJECT_ID)
  const [checked, setChecked] = useState<CheckedAnswer | null>(null)
  const [checking, setChecking] = useState(false)
  const [inputError, setInputError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const runCheck = useCallback(async (target: string) => {
    const cleaned = target.trim()
    if (inFlight.current) return
    if (!cleaned) {
      setChecked(null)
      setInputError('Paste a Sui object id to check.')
      return
    }

    setInputError(null)
    inFlight.current = true
    setChecking(true)
    try {
      const body = await verifyMemoryReference(cleaned)
      setChecked({ reference: cleaned, result: normalizeVerification(body, cleaned) })
    } catch (error) {
      // Advisory and read-only: a failed request must not look like a failed
      // verification, and it must never look like a successful one.
      console.warn('[chain-proof] verification request failed', error)
      setChecked({ reference: cleaned, result: failedVerification(cleaned) })
    } finally {
      inFlight.current = false
      setChecking(false)
    }
  }, [])

  // One live check from the prefilled object id, so the panel opens with
  // evidence. The ref guard keeps StrictMode's development remount from
  // spending a second call.
  const initialCheckStarted = useRef(false)
  useEffect(() => {
    if (initialCheckStarted.current) return
    initialCheckStarted.current = true
    void runCheck(KNOWN_GOOD_SUI_OBJECT_ID)
  }, [runCheck])

  const current = checked && checked.reference === reference.trim() ? checked.result : null
  const notice = current ? proofUnavailableNotice(current.reason) : null

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-violet-200 bg-violet-50 dark:border-violet-900/60 dark:bg-violet-950/40">
          <Link2 className="h-5 w-5 text-violet-600 dark:text-violet-300" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">Prove it on chain</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            A Walrus blob lives as an object on Sui. Its existence and certification can be read
            back from the chain, so the storage claim does not have to be taken on trust. The
            check is read-only: it never changes a memory.
          </p>

          {notice ? (
            <div className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-950/40">
              <div className="flex items-start gap-2">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
                    {notice.title}
                  </p>
                  <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{notice.body}</p>
                  {current && (
                    <p className="mt-1 font-mono text-[10px] text-gray-400">
                      reason: {current.reason}
                    </p>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    disabled={checking}
                    onClick={() => {
                      void runCheck(reference)
                    }}
                  >
                    {checking ? (
                      <Loader2 className="h-3 w-3 animate-spin" />
                    ) : (
                      <RefreshCw className="h-3 w-3" />
                    )}
                    Check again
                  </Button>
                </div>
              </div>
            </div>
          ) : (
            <form
              className="mt-4"
              onSubmit={(event) => {
                event.preventDefault()
                void runCheck(reference)
              }}
            >
              <label
                htmlFor={INPUT_ID}
                className="text-[11px] font-medium uppercase tracking-wide text-gray-500"
              >
                Sui object id
              </label>
              <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                <Input
                  id={INPUT_ID}
                  value={reference}
                  onChange={(event) => {
                    setReference(event.target.value)
                    if (inputError) setInputError(null)
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={inputError ? true : undefined}
                  className="font-mono text-xs sm:flex-1"
                />
                <Button type="submit" size="sm" disabled={checking} className="shrink-0">
                  {checking ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <ShieldCheck className="h-3.5 w-3.5" />
                  )}
                  {checking ? 'Checking' : 'Verify on Sui'}
                </Button>
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-gray-400">
                A Sui object id starts with 0x. A bare Walrus blob id is a content commitment, not
                an object id, and is reported as such rather than guessed.
              </p>
              {inputError && (
                <p role="alert" className="mt-1 text-xs text-red-600 dark:text-red-400">
                  {inputError}
                </p>
              )}
            </form>
          )}

          {current && !notice && <ProofResult result={current} />}
        </div>
      </div>
    </section>
  )
}

function ProofResult({ result }: { result: MemoryVerification }) {
  const tone = verificationTone(result)
  const badge = proofBadge(result)
  const fields = proofFields(result)
  const Icon = tone === 'verified' ? ShieldCheck : tone === 'unverified' ? ShieldAlert : CircleAlert

  return (
    <div
      className="mt-4 rounded-lg border border-gray-200 bg-gray-50/60 p-4 dark:border-gray-800 dark:bg-gray-950/40"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold',
            BADGE_STYLES[tone],
          )}
        >
          <Icon className="h-3.5 w-3.5" />
          {badge.label}
        </span>
        <span className="text-xs text-gray-600 dark:text-gray-400">
          {verificationReasonText(result)}
        </span>
        {tone !== 'verified' && (
          <span className="font-mono text-[10px] text-gray-400">reason: {result.reason}</span>
        )}
      </div>

      {fields.length > 0 && (
        <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
          {fields.map((field) => (
            <ProofFieldRow key={field.label} field={field} />
          ))}
        </dl>
      )}

      {result.object_id && (
        <p className="mt-3 break-all font-mono text-[10px] text-gray-400">
          checked {result.object_id}
        </p>
      )}
    </div>
  )
}

function ProofFieldRow({ field }: { field: ProofField }) {
  return (
    <div className={cn('min-w-0', field.wide && 'sm:col-span-2')}>
      <dt className="text-[11px] uppercase tracking-wide text-gray-500">{field.label}</dt>
      <dd
        className={cn(
          'mt-0.5 break-words text-gray-900 dark:text-gray-100',
          field.mono && 'font-mono',
          field.mono && field.wide ? 'break-all text-[10px]' : 'text-sm',
        )}
      >
        {field.value}
      </dd>
    </div>
  )
}
