/**
 * AgentPaymentsPanel.tsx - the x402 challenge, and the purchase.
 *
 * This panel lives on Agent access, not on Memory: it is about what an external
 * agent can buy, which has nothing to do with what Gigr remembers about a user.
 * An agent has no Gigr account, so the thing the panel chooses is a PROVIDER
 * from the public marketplace, not one of the signed-in user's jobs. The brief
 * endpoint is still priced by job, so the chosen provider's most recent
 * completed job is the id the quote and the purchase are asked for.
 *
 * An external agent can buy a brief about a job: it asks, gets a 402 quote in
 * USDC on Solana, pays, and calls again; Gigr verifies that settlement on chain
 * before it returns anything. This panel shows that exchange and also lets the
 * signed-in user complete it without a CLI or an external wallet: the server
 * signs the USDC transfer with the user's custodial wallet, so one tap buys the
 * brief.
 *
 * Two states are kept apart on purpose. Until a purchase succeeds the card shows
 * the quote and says so: "quote, not a payment". A purchase answer that is not a
 * paid brief never replaces that quote card, and the notice around it says what
 * happened to the money instead: nothing submitted, submitted and unconfirmed,
 * or confirmed but refused. Only a bought answer replaces the quote, and only it
 * says the brief was actually bought.
 */

import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  CircleAlert,
  CircleCheck,
  CircleDollarSign,
  Loader2,
  ReceiptText,
  Wallet,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ProviderCombobox } from '@/components/agent/ProviderCombobox'
import {
  fetchBriefProviders,
  purchaseAgentBrief,
  requestAgentBriefQuote,
} from '@/hooks/useAgentBrief'
import {
  purchaseHeadline,
  purchaseMayHaveMoved,
  settlementSignature,
  type PurchaseOutcome,
} from '@/lib/agentBriefPurchase'
import type { BriefProvider } from '@/lib/providerPicker'
import {
  isJobId,
  type BriefOutcome,
  type X402Quote,
} from '@/lib/x402Challenge'

const INPUT_ID = 'agent-brief-job-id'

/** Touch targets on the payment flow: 44px is the smallest comfortable one. */
const TOUCH_TARGET = 'h-11 min-h-11'

export function AgentPaymentsPanel() {
  const [provider, setProvider] = useState<BriefProvider | null>(null)
  // The job the brief is priced for. It comes from the chosen provider, or from
  // a pasted id when someone has one and no provider row.
  const [jobId, setJobId] = useState('')
  // An answer belongs to the id it was asked for. Editing the id drops the old
  // answer instead of leaving a quote for one job under another job's field.
  const [answer, setAnswer] = useState<{ jobId: string; outcome: BriefOutcome } | null>(null)
  const [purchase, setPurchase] = useState<{ jobId: string; outcome: PurchaseOutcome } | null>(
    null,
  )
  const [requesting, setRequesting] = useState(false)
  const [buying, setBuying] = useState(false)
  const quoteInFlight = useRef(false)
  const purchaseInFlight = useRef(false)

  const providersQuery = useQuery({
    queryKey: ['agent-brief', 'providers'],
    queryFn: fetchBriefProviders,
    staleTime: 60_000,
    retry: 0,
  })
  const providers = providersQuery.data ?? []
  const outcome = answer && answer.jobId === jobId.trim() ? answer.outcome : null
  const purchaseOutcome =
    purchase && purchase.jobId === jobId.trim() ? purchase.outcome : null
  const bought =
    purchaseOutcome && purchaseOutcome.kind === 'paid' ? purchaseOutcome : null

  const chooseProvider = (next: BriefProvider | null) => {
    setProvider(next)
    setJobId(next ? next.jobId : '')
    // A new subject is a new question: the old quote belongs to the old job.
    setAnswer(null)
    setPurchase(null)
  }

  const run = async () => {
    const cleaned = jobId.trim()
    if (quoteInFlight.current) return
    if (!cleaned) {
      setAnswer({
        jobId: cleaned,
        outcome: {
          kind: 'error',
          detail:
            'Choose a provider first, or paste a job id. The brief is priced for one job.',
        },
      })
      return
    }
    if (!isJobId(cleaned)) {
      setAnswer({
        jobId: cleaned,
        outcome: {
          kind: 'error',
          detail:
            'A Gigr job id is a UUID, for example 123e4567-e89b-12d3-a456-426614174000. Check the id and try again.',
        },
      })
      return
    }

    quoteInFlight.current = true
    setRequesting(true)
    try {
      const result = await requestAgentBriefQuote(cleaned)
      setAnswer({ jobId: cleaned, outcome: result })
    } finally {
      quoteInFlight.current = false
      setRequesting(false)
    }
  }

  const buy = async () => {
    const cleaned = jobId.trim()
    // The ref is the guard that matters on a double tap: state updates are
    // batched, so two taps in the same frame would both see `buying === false`.
    if (purchaseInFlight.current || !isJobId(cleaned)) return
    purchaseInFlight.current = true
    setBuying(true)
    try {
      const result = await purchaseAgentBrief(cleaned)
      setPurchase({ jobId: cleaned, outcome: result })
    } finally {
      purchaseInFlight.current = false
      setBuying(false)
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900 sm:p-5">
      <div className="flex gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-sky-200 bg-sky-50 dark:border-sky-900/60 dark:bg-sky-950/40">
          <CircleDollarSign className="h-5 w-5 text-sky-600 dark:text-sky-300" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">Agent payments</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            An external agent can buy a brief about a provider: the endpoint quotes a price in
            USDC on Solana and verifies the settlement on chain before it returns any content.
            You can buy the same brief here in one tap, paid from your Gigr wallet.
          </p>

          <form
            className="mt-4"
            onSubmit={(event) => {
              event.preventDefault()
              void run()
            }}
          >
            <ProviderCombobox
              providers={providers}
              selected={provider}
              onSelect={chooseProvider}
              loading={providersQuery.isLoading}
              failed={providersQuery.isError}
              onRetry={() => {
                void providersQuery.refetch()
              }}
            />

            {!providersQuery.isLoading &&
              !providersQuery.isError &&
              providers.length === 0 && (
                <p className="mt-2 text-xs text-gray-500">
                  No provider has completed a job yet, so there is no brief to buy. Paste a job
                  id below if you have one.
                </p>
              )}

            <div className="mt-3">
              <label
                htmlFor={INPUT_ID}
                className="text-[11px] font-medium uppercase tracking-wide text-gray-500"
              >
                Or paste a job id
              </label>
              <Input
                id={INPUT_ID}
                value={jobId}
                onChange={(event) => {
                  setJobId(event.target.value)
                  setProvider(null)
                }}
                placeholder="123e4567-e89b-12d3-a456-426614174000"
                spellCheck={false}
                autoComplete="off"
                className={`mt-1 font-mono text-xs ${TOUCH_TARGET}`}
              />
              <p className="mt-1 text-[11px] text-gray-500">
                Choosing a provider fills this in with that provider's most recent completed
                job. Typing here replaces it.
              </p>
            </div>

            <Button
              type="submit"
              size="sm"
              disabled={requesting}
              className={`mt-3 w-full gap-1.5 ${TOUCH_TARGET}`}
            >
              {requesting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ReceiptText className="h-3.5 w-3.5" />
              )}
              {requesting ? 'Requesting' : 'Request a brief'}
            </Button>
          </form>

          {bought ? (
            <PurchasedBriefCard outcome={bought} />
          ) : (
            <>
              {outcome && (
                <BriefOutcomeView outcome={outcome} onBuy={buy} buying={buying} />
              )}
              {purchaseOutcome && <PurchaseNotice outcome={purchaseOutcome} />}
            </>
          )}
        </div>
      </div>
    </section>
  )
}

function BriefOutcomeView({
  outcome,
  onBuy,
  buying,
}: {
  outcome: BriefOutcome
  onBuy: () => void
  buying: boolean
}) {
  if (outcome.kind === 'quote') {
    return <QuoteCard quote={outcome.quote} onBuy={onBuy} buying={buying} />
  }

  const copy: Record<Exclude<BriefOutcome['kind'], 'quote'>, { title: string; body: string }> = {
    feature_disabled: {
      title: 'Agent briefs are not offered by this deployment',
      body: 'The agent-brief endpoint is turned off here, so it answered 404 instead of a quote. Nothing was charged and no payment was made.',
    },
    job_not_found: {
      title: 'No brief for that job',
      body: 'The endpoint answered 404 for this job id. Check the id against the job you meant and try again.',
    },
    unexpected: {
      title: 'The endpoint answered without a payment challenge',
      body: 'This panel does not treat that as a purchase and shows no brief.',
    },
    error: {
      title: 'We could not get a quote',
      body: 'This panel did not receive an x402 challenge.',
    },
  }

  const notice = copy[outcome.kind]

  return (
    <div
      className="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-950/40"
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0 text-gray-500" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">{notice.title}</p>
          <p className="mt-1 text-xs text-gray-600 dark:text-gray-400">{notice.body}</p>
          <p className="mt-2 break-words font-mono text-[11px] text-gray-500">{outcome.detail}</p>
        </div>
      </div>
    </div>
  )
}

function QuoteCard({
  quote,
  onBuy,
  buying,
}: {
  quote: X402Quote
  onBuy: () => void
  buying: boolean
}) {
  const amount = quote.amountUsdc
    ? `${quote.amountUsdc} USDC`
    : 'Not stated by the endpoint'

  return (
    <div
      className="mt-4 rounded-xl border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-900/60 dark:bg-amber-950/20"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-300 bg-amber-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-amber-800 dark:border-amber-800 dark:bg-amber-950/60 dark:text-amber-200">
          <ReceiptText className="h-3.5 w-3.5" />
          Quote, not a payment
        </span>
      </div>
      <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">
        These are the terms the endpoint returned for this job. No money has moved yet: nothing is
        paid until you tap Buy this brief and the transfer confirms.
      </p>

      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        <QuoteRow label="Scheme" value={quote.scheme} mono />
        <QuoteRow label="Network" value={quote.network} mono />
        <QuoteRow label="Asset (USDC mint)" value={quote.asset} mono wide />
        <QuoteRow
          label="Amount"
          value={amount}
          hint={`${quote.amountAtomic} atomic units`}
          wide
        />
        <QuoteRow label="Pay to" value={quote.payTo} mono wide />
        <QuoteRow label="Quote expires" value={quote.expiresAtLabel ?? 'Not stated'} />
        {quote.maxTimeoutSeconds !== null && (
          <QuoteRow label="Quote life" value={`${quote.maxTimeoutSeconds} seconds`} />
        )}
        <QuoteRow
          label="Reason"
          value={quote.reason ?? 'Not stated'}
          hint={quote.reasonText}
          mono={quote.reason !== null}
          wide
        />
        {quote.resource && <QuoteRow label="Resource" value={quote.resource} mono wide />}
        {quote.nonce && <QuoteRow label="Quote nonce" value={quote.nonce} mono wide />}
      </dl>

      <Button
        type="button"
        onClick={onBuy}
        disabled={buying}
        aria-busy={buying}
        className={`mt-3 w-full gap-2 bg-sky-600 text-white hover:bg-sky-700 dark:bg-sky-600 dark:hover:bg-sky-500 ${TOUCH_TARGET}`}
      >
        {buying ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Wallet className="h-4 w-4" />
        )}
        {buying ? 'Paying from your wallet' : 'Buy this brief'}
      </Button>

      <p className="mt-2 text-[11px] leading-relaxed text-amber-800 dark:text-amber-200">
        Gigr sends the USDC from your Gigr wallet and checks the settlement on Solana before it
        shows the brief. One tap buys one brief: tapping twice will not pay twice.
      </p>
    </div>
  )
}

function PurchaseNotice({ outcome }: { outcome: PurchaseOutcome }) {
  if (outcome.kind === 'paid') return null

  const headline = purchaseHeadline(outcome)
  const signature = settlementSignature(outcome)
  const message = outcome.message
  // The notice speaks for the purchase, not for a payment that does not exist.
  const tone =
    purchaseMayHaveMoved(outcome)
      ? 'border-sky-200 bg-sky-50/60 text-sky-900 dark:border-sky-900/60 dark:bg-sky-950/30 dark:text-sky-100'
      : 'border-gray-200 bg-gray-50 text-gray-900 dark:border-gray-800 dark:bg-gray-950/40 dark:text-gray-100'

  return (
    <div
      className={`mt-4 rounded-xl border p-4 ${tone}`}
      role={outcome.kind === 'pending' ? 'status' : 'alert'}
      aria-live="polite"
    >
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">{headline}</p>
          <p className="mt-1 break-words text-xs leading-relaxed">{message}</p>
          {signature && (
            <div className="mt-2">
              <p className="text-[11px] font-medium uppercase tracking-wide opacity-70">
                Settlement signature
              </p>
              <p className="mt-0.5 break-all font-mono text-[11px]">{signature}</p>
            </div>
          )}
          {outcome.kind !== 'no_answer' && outcome.reason === 'insufficient_usdc' && (
            <p className="mt-2 text-[11px] opacity-80">
              This job is not marked as paid, so the quote above is still only a quote.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

function PurchasedBriefCard({ outcome }: { outcome: Extract<PurchaseOutcome, { kind: 'paid' }> }) {
  const brief = outcome.brief
  const amount = brief.amountUsdc ? `${brief.amountUsdc} USDC` : 'Not stated'

  return (
    <div
      className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 dark:border-emerald-900/60 dark:bg-emerald-950/20"
      aria-live="polite"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-300 bg-emerald-100 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200">
          <CircleCheck className="h-3.5 w-3.5" />
          {outcome.alreadyPurchased ? 'Bought earlier' : 'Bought with x402'}
        </span>
        <span className="text-[11px] font-medium text-emerald-800 dark:text-emerald-200">
          {amount}
        </span>
      </div>

      <p className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">
        {purchaseHeadline(outcome)}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-gray-900 dark:text-gray-100">
        {brief.summary}
      </p>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2">
        <BriefRow label="Job" value={brief.title} wide />
        <BriefRow label="Job status" value={brief.jobStatus} />
        <BriefRow
          label="Posted price"
          value={brief.postedPrice === null ? 'Not recorded' : brief.postedPrice.toFixed(2)}
        />
        <BriefRow
          label="Ratings"
          value={
            brief.ratingsCount === 0
              ? 'None yet'
              : `${brief.ratingsCount} at ${brief.ratingsAverage?.toFixed(2) ?? 'n/a'} average`
          }
          wide
        />
        <BriefRow label="Completed jobs" value={String(brief.completedJobs)} />
        <BriefRow
          label="Comparable jobs"
          value={
            brief.comparableJobs === 0
              ? 'None yet'
              : `${brief.comparableJobs} priced ${brief.comparableMin ?? 'n/a'} to ${
                  brief.comparableMax ?? 'n/a'
                }`
          }
          wide
        />
        <BriefRow
          label="Disputes"
          value={brief.disputesTotal === 0 ? 'None' : `${brief.disputesTotal} (${brief.disputesOpen} open)`}
          wide
        />
      </dl>

      <div className="mt-3 border-t border-emerald-200 pt-3 dark:border-emerald-900/60">
        <p className="text-[11px] font-medium uppercase tracking-wide text-emerald-800/80 dark:text-emerald-200/80">
          Settlement signature
        </p>
        <p className="mt-0.5 break-all font-mono text-[11px] text-gray-900 dark:text-gray-100">
          {outcome.signature}
        </p>
        {brief.network && (
          <p className="mt-2 break-all text-[11px] text-emerald-800 dark:text-emerald-200">
            {`Verified on ${brief.network}. Paid from your Gigr wallet, so no external wallet or CLI was involved.`}
          </p>
        )}
      </div>
    </div>
  )
}

function BriefRow({
  label,
  value,
  wide = false,
}: {
  label: string
  value: string
  wide?: boolean
}) {
  return (
    <div className={wide ? 'min-w-0 col-span-2' : 'min-w-0'}>
      <dt className="text-[11px] uppercase tracking-wide text-emerald-800/70 dark:text-emerald-200/70">
        {label}
      </dt>
      <dd className="mt-0.5 break-words text-sm text-gray-900 dark:text-gray-100">{value}</dd>
    </div>
  )
}

function QuoteRow({
  label,
  value,
  hint,
  mono = false,
  wide = false,
}: {
  label: string
  value: string
  hint?: string
  mono?: boolean
  wide?: boolean
}) {
  return (
    <div className={wide ? 'min-w-0 sm:col-span-2' : 'min-w-0'}>
      <dt className="text-[11px] uppercase tracking-wide text-amber-700/80 dark:text-amber-300/80">
        {label}
      </dt>
      <dd
        className={
          mono
            ? 'mt-0.5 break-all font-mono text-xs text-gray-900 dark:text-gray-100'
            : 'mt-0.5 break-words text-sm text-gray-900 dark:text-gray-100'
        }
      >
        {value}
      </dd>
      {hint && (
        <p className="mt-0.5 break-words text-[11px] text-amber-700/90 dark:text-amber-300/90">
          {hint}
        </p>
      )}
    </div>
  )
}
