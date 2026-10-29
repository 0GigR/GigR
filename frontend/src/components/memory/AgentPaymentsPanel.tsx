/**
 * AgentPaymentsPanel.tsx - "Agent payments": the x402 challenge, made visible.
 *
 * An external agent can buy a brief about a job. It asks, gets a 402 quote in
 * USDC on Solana, pays, and calls again; Gigr verifies that settlement on chain
 * before it returns anything. This panel shows the first step of that exchange
 * and stops there on purpose.
 *
 * It cannot show a purchase. It sends no X-PAYMENT header, has no wallet, and
 * has no outcome kind for a paid brief: a 2xx is labelled unexpected rather
 * than celebrated. What it does show is the quote's real fields, the named
 * reason the endpoint gave, and a plain statement that the round trip needs a
 * funded devnet USDC payment.
 */

import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { CircleDollarSign, CircleAlert, Loader2, ReceiptText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchAgentBriefJobs, requestAgentBriefQuote } from '@/hooks/useAgentBrief'
import {
  isJobId,
  type BriefOutcome,
  type X402Quote,
} from '@/lib/x402Challenge'

const INPUT_ID = 'agent-brief-job-id'

export function AgentPaymentsPanel() {
  const [jobId, setJobId] = useState('')
  // An answer belongs to the id it was asked for. Editing the id drops the old
  // answer instead of leaving a quote for one job under another job's field.
  const [answer, setAnswer] = useState<{ jobId: string; outcome: BriefOutcome } | null>(null)
  const [requesting, setRequesting] = useState(false)
  const inFlight = useRef(false)

  const jobsQuery = useQuery({
    queryKey: ['agent-brief', 'jobs'],
    queryFn: fetchAgentBriefJobs,
    staleTime: 60_000,
    retry: 0,
  })
  const jobs = jobsQuery.data ?? []
  const pickedJob = jobs.some((job) => job.id === jobId) ? jobId : ''
  const outcome = answer && answer.jobId === jobId.trim() ? answer.outcome : null

  const run = async () => {
    const cleaned = jobId.trim()
    if (inFlight.current) return
    if (!cleaned) {
      setAnswer({
        jobId: cleaned,
        outcome: { kind: 'error', detail: 'Choose one of your jobs or paste its id first.' },
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

    inFlight.current = true
    setRequesting(true)
    try {
      const result = await requestAgentBriefQuote(cleaned)
      setAnswer({ jobId: cleaned, outcome: result })
    } finally {
      inFlight.current = false
      setRequesting(false)
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-800 dark:bg-gray-900">
      <div className="flex gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full border border-sky-200 bg-sky-50 dark:border-sky-900/60 dark:bg-sky-950/40">
          <CircleDollarSign className="h-5 w-5 text-sky-600 dark:text-sky-300" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">Agent payments</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            An external agent can buy a brief about a job. The endpoint quotes a price in USDC on
            Solana and verifies the settlement on chain before it returns any content. This panel
            asks for the quote and shows the terms: the full round trip needs a funded devnet USDC
            payment, and no payment is made here.
          </p>

          <form
            className="mt-4"
            onSubmit={(event) => {
              event.preventDefault()
              void run()
            }}
          >
            <label
              htmlFor={INPUT_ID}
              className="text-[11px] font-medium uppercase tracking-wide text-gray-500"
            >
              Job
            </label>
            {jobs.length > 0 && (
              <select
                aria-label="Pick one of your jobs"
                value={pickedJob}
                onChange={(event) => setJobId(event.target.value)}
                className="mt-1 w-full rounded-lg border border-gray-200 bg-gray-50 p-2 text-sm text-gray-900 focus:ring-2 focus:ring-sky-500 dark:border-gray-700 dark:bg-gray-950/40 dark:text-gray-100"
              >
                <option value="">Pick one of your jobs</option>
                {jobs.map((job) => (
                  <option key={job.id} value={job.id}>
                    {job.title} ({job.status})
                  </option>
                ))}
              </select>
            )}
            <div className="mt-2 flex flex-col gap-2 sm:flex-row">
              <Input
                id={INPUT_ID}
                value={jobId}
                onChange={(event) => setJobId(event.target.value)}
                placeholder="Or paste a job id"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs sm:flex-1"
              />
              <Button type="submit" size="sm" disabled={requesting} className="shrink-0">
                {requesting ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ReceiptText className="h-3.5 w-3.5" />
                )}
                {requesting ? 'Requesting' : 'Request a brief'}
              </Button>
            </div>
          </form>

          {outcome && <BriefOutcomeView outcome={outcome} />}
        </div>
      </div>
    </section>
  )
}

function BriefOutcomeView({ outcome }: { outcome: BriefOutcome }) {
  if (outcome.kind === 'quote') return <QuoteCard quote={outcome.quote} />

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

function QuoteCard({ quote }: { quote: X402Quote }) {
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
        These are the terms the endpoint returned for this job. No money has moved: this panel has
        no wallet and sends no payment.
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

      <p className="mt-3 border-t border-amber-200 pt-3 text-xs leading-relaxed text-amber-800 dark:border-amber-900/60 dark:text-amber-200">
        The full round trip needs a funded devnet USDC payment. An agent sends the amount above to
        the pay-to address, then asks again with the settlement signature in the X-PAYMENT header.
        Gigr verifies that settlement on chain before it returns the brief. This panel shows the
        challenge and stops there.
      </p>
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
