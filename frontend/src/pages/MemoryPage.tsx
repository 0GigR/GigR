/**
 * MemoryPage.tsx - the user-facing surface for what the agent remembers.
 *
 * Reachable at /dashboard/memory from the sidebar, the agent panel and the AI
 * settings page. It lists every memory key the server holds, grouped by kind,
 * with a confirmed Forget action and an advisory Sui verification badge for
 * values that are Sui object ids.
 *
 * House standard: zero emojis, zero decorative unicode, confirmation before a
 * destructive action, and an honest state for empty, loading, error and
 * feature-disabled.
 */

import { useRef, useState, type ReactNode } from 'react'
import axios from 'axios'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle,
  Bot,
  Brain,
  CircleAlert,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { extractError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/store/authStore'
import { useAgentStore } from '@/store/agentStore'
import {
  useAgentMemory,
  forgetAgentMemoryKey,
  verifyMemoryReference,
  type AgentMemorySnapshot,
} from '@/hooks/useAgentMemory'
import {
  failedVerification,
  findSuiReference,
  formatMemoryValue,
  groupMemory,
  humanizeMemoryKey,
  normalizeVerification,
  verificationLabel,
  verificationReasonText,
  verificationTone,
  type MemoryEntry,
  type MemoryGroup,
  type MemoryVerification,
  type VerificationTone,
} from '@/lib/agentMemory'

const VERIFICATION_STYLES: Record<VerificationTone, string> = {
  verified:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300',
  unverified:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300',
  unavailable:
    'border-gray-200 bg-gray-100 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300',
}

function httpStatus(error: unknown): number | null {
  if (axios.isAxiosError(error)) return error.response?.status ?? null
  return null
}

export default function MemoryPage() {
  const user = useAuthStore((state) => state.user)
  const openAgentPanel = useAgentStore((state) => state.openPanel)
  const queryClient = useQueryClient()

  const accountEnabled = user?.ai_enabled !== false
  const { data: snapshot, isLoading, isError, error, refetch, isFetching } =
    useAgentMemory(accountEnabled)

  const [pendingKey, setPendingKey] = useState<string | null>(null)
  const forgettingRef = useRef(false)

  const forgetMutation = useMutation({
    mutationFn: async (key: string) => {
      const memory = await forgetAgentMemoryKey(key)
      return { key, memory }
    },
    onSuccess: ({ key, memory }) => {
      const previous = queryClient.getQueryData<AgentMemorySnapshot>(['agent', 'memory'])
      const next =
        memory ??
        (previous
          ? Object.fromEntries(
              Object.entries(previous.memory).filter(([entryKey]) => entryKey !== key),
            )
          : {})
      queryClient.setQueryData<AgentMemorySnapshot>(['agent', 'memory'], (current) =>
        current ? { ...current, memory: next } : current,
      )
      // The AI settings page reads the same map from the zustand store.
      useAgentStore.setState({ agentMemory: next })
      setPendingKey(null)
      toast.success(`Forgot "${key}".`)
    },
    onError: (mutationError: unknown) => {
      toast.error(
        extractError(mutationError, 'We could not forget that memory. It is still saved.'),
      )
    },
  })

  const forbidden = isError && httpStatus(error) === 403
  const memory = snapshot?.memory ?? {}
  const groups = groupMemory(memory)
  const count = Object.keys(memory).length
  const environmentDisabled = forbidden || snapshot?.agentEnabled === false
  const busy = isFetching || forgetMutation.isPending

  let body: ReactNode
  if (!accountEnabled) {
    body = <DisabledState reason="account" />
  } else if (isLoading) {
    body = <LoadingState />
  } else if (isError && !forbidden) {
    body = (
      <ErrorState
        retrying={isFetching}
        onRetry={() => {
          void refetch()
        }}
      />
    )
  } else if (forbidden) {
    body = <DisabledState reason="forbidden" />
  } else {
    body = (
      <div className="space-y-4">
        {environmentDisabled && (
          <DisabledState
            reason="environment"
            hasStoredEntries={count > 0}
            checking={isFetching}
            onCheckAgain={() => {
              void refetch()
            }}
          />
        )}

        {count > 0 ? (
          <>
            <p className="text-xs text-gray-500">
              {count} {count === 1 ? 'memory' : 'memories'}. You can forget any entry, and the
              agent stops using it in future tasks.
            </p>
            {groups.map((group) => (
              <MemoryGroupSection
                key={group.id}
                group={group}
                onForget={(key) => setPendingKey(key)}
              />
            ))}
            <p className="text-[11px] leading-relaxed text-gray-400">
              Entries do not carry a separate update time. This list is what your agent holds now.
            </p>
          </>
        ) : environmentDisabled ? null : (
          <EmptyState onOpenAgent={openAgentPanel} />
        )}
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto space-y-8 animate-in fade-in duration-300">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-3">
            <Brain className="w-8 h-8 text-violet-600 dark:text-violet-400" />
            Memory
          </h1>
          <p className="text-gray-500 mt-2 text-sm">
            What Gigr remembers about you between conversations. The agent uses these notes to
            avoid asking the same questions twice.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-1"
          onClick={() => {
            void refetch()
          }}
          disabled={busy || !accountEnabled}
        >
          <RefreshCw className={cn('w-3.5 h-3.5', isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {body}

      <ConfirmDialog
        open={pendingKey !== null}
        onOpenChange={(open) => {
          if (!open && !forgetMutation.isPending) setPendingKey(null)
        }}
        title={
          pendingKey !== null
            ? `Forget "${humanizeMemoryKey(pendingKey)}"?`
            : 'Forget this memory?'
        }
        description={
          pendingKey !== null
            ? `This removes the "${pendingKey}" memory from what Gigr remembers about you. The agent stops using it in future tasks. This cannot be undone.`
            : ''
        }
        confirmLabel="Forget memory"
        cancelLabel="Cancel"
        loading={forgetMutation.isPending}
        onConfirm={() => {
          if (pendingKey === null || forgettingRef.current) return
          forgettingRef.current = true
          forgetMutation.mutate(pendingKey, {
            onSettled: () => {
              forgettingRef.current = false
            },
          })
        }}
      />
    </div>
  )
}

function MemoryGroupSection({
  group,
  onForget,
}: {
  group: MemoryGroup
  onForget: (key: string) => void
}) {
  return (
    <section className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-gray-900 dark:text-gray-100">{group.label}</h2>
        <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500">
          {group.entries.length}
        </span>
      </div>
      {group.id === 'chain' && (
        <p className="text-xs text-gray-500 mt-1">
          Entries holding a Sui object id can be checked without changing anything.
        </p>
      )}
      <div className="mt-4 divide-y divide-gray-100 dark:divide-gray-800">
        {group.entries.map((entry) => (
          <MemoryEntryRow key={entry.key} entry={entry} onForget={onForget} />
        ))}
      </div>
    </section>
  )
}

function MemoryEntryRow({
  entry,
  onForget,
}: {
  entry: MemoryEntry
  onForget: (key: string) => void
}) {
  const reference = findSuiReference(entry.value)
  const [checked, setChecked] = useState<{ reference: string; result: MemoryVerification } | null>(
    null,
  )
  const [checking, setChecking] = useState(false)
  // A result only belongs to the reference it was requested for. If the value
  // changes while the page is open, the old badge is no longer shown.
  const result = checked && checked.reference === reference ? checked.result : null

  const runCheck = async (target: string) => {
    if (checking) return
    setChecking(true)
    try {
      const verificationBody = await verifyMemoryReference(target)
      setChecked({ reference: target, result: normalizeVerification(verificationBody, target) })
    } catch (verificationError) {
      // Never surface this as an error toast: the memory is unaffected and the
      // rest of the page keeps working. The badge says the check did not run.
      console.warn('[agent-memory] verification request failed', verificationError)
      setChecked({ reference: target, result: failedVerification(target) })
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {humanizeMemoryKey(entry.key)}
          </p>
          <p className="text-[11px] font-mono text-gray-400 break-all mt-0.5">{entry.key}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {reference && (
            <Button
              variant="ghost"
              size="sm"
              disabled={checking}
              onClick={() => {
                void runCheck(reference)
              }}
              className="h-7 px-2 text-xs text-violet-700 hover:text-violet-800 hover:bg-violet-50 dark:text-violet-300 dark:hover:bg-violet-950/30"
            >
              {checking ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <ShieldCheck className="w-3 h-3" />
              )}
              {checking ? 'Checking' : result ? 'Check again' : 'Verify on Sui'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onForget(entry.key)}
            className="h-7 px-2 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
          >
            <Trash2 className="w-3 h-3" />
            Forget
          </Button>
        </div>
      </div>

      <MemoryValue value={entry.value} />

      {result && <VerificationResult result={result} />}
    </div>
  )
}

function MemoryValue({ value }: { value: unknown }) {
  const view = formatMemoryValue(value)

  if (view.kind === 'empty') {
    return <p className="mt-2 text-sm italic text-gray-400">{view.text}</p>
  }
  if (view.kind === 'text') {
    return (
      <p className="mt-2 text-sm text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words">
        {view.text}
      </p>
    )
  }
  if (view.kind === 'list') {
    return (
      <ul className="mt-2 flex flex-wrap gap-1.5">
        {view.items.map((item, index) => (
          <li
            key={`${item}-${index}`}
            className="text-xs px-2 py-0.5 rounded-full bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300"
          >
            {item}
          </li>
        ))}
      </ul>
    )
  }
  return (
    <pre className="mt-2 text-[11px] leading-relaxed font-mono bg-gray-50 dark:bg-gray-950/60 border border-gray-100 dark:border-gray-800 rounded-lg p-2.5 overflow-x-auto whitespace-pre-wrap break-words text-gray-700 dark:text-gray-300">
      {view.text}
    </pre>
  )
}

function VerificationResult({ result }: { result: MemoryVerification }) {
  const tone = verificationTone(result)
  const BadgeIcon =
    tone === 'verified' ? ShieldCheck : tone === 'unverified' ? ShieldAlert : CircleAlert

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2" aria-live="polite">
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
          VERIFICATION_STYLES[tone],
        )}
      >
        <BadgeIcon className="w-3 h-3" />
        {verificationLabel(tone)}
      </span>
      <span className="text-[11px] text-gray-500">{verificationReasonText(result)}</span>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="space-y-4" aria-busy="true">
      <p className="text-sm text-gray-500">Loading what Gigr remembers...</p>
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 space-y-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-14 w-full" />
      </div>
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl p-5 space-y-4">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-14 w-full" />
      </div>
    </div>
  )
}

function ErrorState({ onRetry, retrying }: { onRetry: () => void; retrying: boolean }) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-6 text-center">
      <AlertTriangle className="w-8 h-8 text-amber-500 mx-auto" />
      <p className="font-medium mt-3">We could not load your memory</p>
      <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
        Your memories are not lost. Check your connection, then try again.
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onRetry} disabled={retrying}>
        {retrying ? (
          <Loader2 className="w-3.5 h-3.5 animate-spin" />
        ) : (
          <RefreshCw className="w-3.5 h-3.5" />
        )}
        Try again
      </Button>
    </div>
  )
}

function DisabledState({
  reason,
  hasStoredEntries = false,
  onCheckAgain,
  checking = false,
}: {
  reason: 'account' | 'environment' | 'forbidden'
  hasStoredEntries?: boolean
  onCheckAgain?: () => void
  checking?: boolean
}) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 p-6">
      <div className="flex gap-3">
        <div className="w-10 h-10 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center shrink-0">
          <Bot className="w-5 h-5 text-gray-500" />
        </div>
        <div className="min-w-0">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">Memory is not enabled</h2>
          <p className="text-sm text-gray-500 mt-1">
            {reason === 'account'
              ? 'The AI agent is turned off for your account, so Gigr is not remembering anything about you right now.'
              : reason === 'forbidden'
                ? 'Memory is not available for this account in this environment, so Gigr is not showing or changing anything for you right now.'
                : 'The AI agent is turned off in this environment, so Gigr is not remembering anything about you right now.'}
          </p>
          <p className="text-sm text-gray-500 mt-2">
            {reason === 'forbidden'
              ? 'Nothing is wrong with your data. If you expected memory to be available, contact support.'
              : 'There is nothing you need to fix. When the agent is turned on, the notes it keeps appear here.'}
          </p>
          {hasStoredEntries && (
            <p className="text-sm text-gray-500 mt-2">Notes saved earlier are still listed below.</p>
          )}
          {onCheckAgain && (
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={onCheckAgain}
              disabled={checking}
            >
              {checking ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              Check again
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

function EmptyState({ onOpenAgent }: { onOpenAgent: () => void }) {
  return (
    <div className="text-center py-14 px-4 border border-dashed border-gray-200 dark:border-gray-800 rounded-xl bg-gray-50 dark:bg-gray-900/40">
      <div className="w-12 h-12 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center mx-auto">
        <Brain className="w-6 h-6 text-gray-400" />
      </div>
      <p className="font-medium mt-3">Nothing remembered yet</p>
      <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
        Gigr has not stored anything about you. When the agent learns a preference from a task,
        or you ask it to remember something, it appears here.
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onOpenAgent}>
        Open the agent
      </Button>
    </div>
  )
}
