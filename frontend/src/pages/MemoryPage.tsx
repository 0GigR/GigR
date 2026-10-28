/**
 * MemoryPage.tsx - the user-facing surface for what the agent remembers.
 *
 * Reachable at /dashboard/memory from the sidebar, the agent panel and the AI
 * settings page. Its primary content is the sentences Walrus Memory holds for
 * the signed-in user, read-only from GET /ai/memory/facts. The JSONB preference
 * keys are a secondary section, shown only when at least one has a value: they
 * are what per-preference Forget acts on, and forgetting one leaves the stored
 * sentence because Walrus Memory has no per-fact delete. The namespace wipe
 * ("Forget everything Gigr remembers about me") is the separate, explicit
 * control that deletes every sentence this user has stored. Sui verification
 * stays on the preference entries, unchanged.
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
  Briefcase,
  ChevronDown,
  CircleAlert,
  FolderOpen,
  Loader2,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Star,
  Tag,
  Trash2,
  User,
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
  useAgentMemoryFacts,
  forgetAgentMemoryKey,
  forgetAgentMemoryNamespace,
  verifyMemoryReference,
  type AgentMemorySnapshot,
  type MemoryFact,
  type MemoryFactsReason,
} from '@/hooks/useAgentMemory'
import {
  failedVerification,
  findSuiReference,
  formatMemoryValue,
  groupFactsByCategory,
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
  type FactCategory,
} from '@/lib/agentMemory'

const VERIFICATION_STYLES: Record<VerificationTone, string> = {
  verified:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300',
  unverified:
    'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300',
  unavailable:
    'border-gray-200 bg-gray-100 text-gray-600 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300',
}

// One icon and one restrained accent per category, so a section is recognisable
// before its heading is read. The accents stay in the palette the rest of the
// dashboard uses; they are not a status signal.
const FACT_CATEGORY_ICONS: Record<FactCategory, ReactNode> = {
  about: <User className="w-4 h-4" />,
  jobs: <Briefcase className="w-4 h-4" />,
  services: <Tag className="w-4 h-4" />,
  messages: <MessageSquare className="w-4 h-4" />,
  ratings: <Star className="w-4 h-4" />,
  other: <FolderOpen className="w-4 h-4" />,
}

const FACT_CATEGORY_ACCENTS: Record<FactCategory, string> = {
  about:
    'bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-300',
  jobs: 'bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-300',
  services:
    'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-300',
  messages:
    'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-300',
  ratings: 'bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-300',
  other:
    'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
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
  const { data: snapshot, isError, error, refetch, isFetching } =
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
  const preferenceCount = Object.keys(memory).length
  const environmentDisabled = snapshot?.agentEnabled === false

  const {
    data: factsSnapshot,
    isLoading: factsLoading,
    isError: factsError,
    refetch: refetchFacts,
    isFetching: factsFetching,
  } = useAgentMemoryFacts(accountEnabled)

  const facts = factsSnapshot?.facts ?? []
  const factsReason: MemoryFactsReason = factsSnapshot?.reason ?? 'unavailable'
  const busy = isFetching || factsFetching || forgetMutation.isPending

  const refreshAll = () => {
    void refetch()
    void refetchFacts()
  }

  // The namespace wipe is the one action that deletes stored sentences. It is
  // offered only where the backend would accept it: with the feature off the
  // route answers 404, so showing the control would promise an action that
  // cannot run.
  const memoryWipeAvailable =
    !environmentDisabled &&
    factsReason !== 'feature_disabled' &&
    factsReason !== 'not_configured'

  const wipeMutation = useMutation({
    mutationFn: forgetAgentMemoryNamespace,
    onSuccess: (result) => {
      if (!result.ok) {
        // The backend answers with a reason instead of failing the page. Show
        // it and keep the page as it was: nothing was deleted.
        toast.error(forgetFailureText(result.reason))
        return
      }
      // Every sentence is gone, so the fact list and the preference map are
      // both re-read rather than guessed at.
      refreshAll()
      toast.success('Forgot everything Gigr remembers about you.')
    },
    onError: (mutationError: unknown) => {
      toast.error(
        extractError(
          mutationError,
          'We could not forget your memory. Nothing was deleted.',
        ),
      )
    },
  })

  let content: ReactNode
  if (!accountEnabled) {
    content = <DisabledState reason="account" />
  } else if (forbidden) {
    content = <DisabledState reason="forbidden" />
  } else {
    content = (
      <div className="space-y-8">
        {environmentDisabled && (
          <DisabledState
            reason="environment"
            hasStoredEntries={preferenceCount > 0 || facts.length > 0}
            checking={busy}
            onCheckAgain={refreshAll}
          />
        )}

        <MemoryFactsSection
          facts={facts}
          reason={factsReason}
          source={factsSnapshot?.source ?? 'none'}
          loading={factsLoading}
          failed={factsError}
          retrying={factsFetching}
          onRetry={() => {
            void refetchFacts()
          }}
          onOpenAgent={openAgentPanel}
        />

        {!factsLoading && preferenceCount > 0 ? (
          <section className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                Saved preferences
              </h2>
              <p className="text-sm text-gray-500 mt-1">
                Short values your agent saved to reuse. Forgetting one stops the agent using
                it. The sentence already written for that preference can remain, because
                Walrus Memory has no per-fact delete. Use the control below to remove
                everything Gigr remembers about you.
              </p>
            </div>
            <p className="text-xs text-gray-500">
              {preferenceCount} saved {preferenceCount === 1 ? 'preference' : 'preferences'}.
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
          </section>
        ) : null}

        {isError && !forbidden ? (
          <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5">
            <p className="text-sm text-gray-700 dark:text-gray-300">
              We could not load your saved preferences. The sentences above are not affected.
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              onClick={() => {
                void refetch()
              }}
              disabled={isFetching}
            >
              {isFetching ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : (
                <RefreshCw className="w-3 h-3" />
              )}
              Try again
            </Button>
          </div>
        ) : null}

        {memoryWipeAvailable ? (
          <MemoryWipeSection
            busy={wipeMutation.isPending}
            onConfirm={() => wipeMutation.mutate()}
          />
        ) : null}
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
            What Gigr remembers about you between conversations, read from Walrus Memory. The
            agent uses these notes to avoid asking the same questions twice.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="mt-1"
          onClick={refreshAll}
          disabled={busy || !accountEnabled}
        >
          <RefreshCw className={cn('w-3.5 h-3.5', isFetching || factsFetching ? 'animate-spin' : '')} />
          Refresh
        </Button>
      </div>

      {content}

      <ConfirmDialog
        open={pendingKey !== null}
        onOpenChange={(open) => {
          if (!open && !forgetMutation.isPending) setPendingKey(null)
        }}
        title={
          pendingKey !== null
            ? `Forget "${humanizeMemoryKey(pendingKey)}"?`
            : 'Forget this preference?'
        }
        description={
          pendingKey !== null
            ? `This removes the "${pendingKey}" saved preference, and the agent stops reusing it. The sentence already written for it can remain, because Walrus Memory has no per-fact delete. To remove every sentence Gigr holds about you, use "Forget everything Gigr remembers about me". This cannot be undone.`
            : ''
        }
        confirmLabel="Forget preference"
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

function MemoryFactsSection({
  facts,
  reason,
  source,
  loading,
  failed,
  retrying,
  onRetry,
  onOpenAgent,
}: {
  facts: MemoryFact[]
  reason: MemoryFactsReason
  source: 'walrus' | 'none'
  loading: boolean
  failed: boolean
  retrying: boolean
  onRetry: () => void
  onOpenAgent: () => void
}) {
  // Hooks run before every early return: the section is rendered while loading,
  // then with facts, and the state must keep its slot across those renders.
  // Sections start closed: the page opens as a five-card overview with counts,
  // and one click reveals the sentences. Tracking what is open (not what is
  // closed) makes that the empty default and survives facts arriving late.
  const [expandedGroups, setExpandedGroups] = useState<Set<FactCategory>>(
    new Set(),
  )

  const retryButton = (label: string) => (
    <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
      {retrying ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <RefreshCw className="w-3 h-3" />
      )}
      {label}
    </Button>
  )

  if (loading) return <LoadingState />

  if (failed) {
    return (
      <MemoryNotice
        warning
        title="We could not read Walrus Memory"
        body="Nothing has changed. The sentences Gigr stores are safe. Check your connection, then try again."
        action={retryButton('Try again')}
      />
    )
  }

  if (reason === 'feature_disabled' || reason === 'not_configured') {
    return (
      <MemoryNotice
        title="Memory is not enabled"
        body={
          reason === 'feature_disabled'
            ? 'Walrus Memory is turned off in this environment, so Gigr is not reading or saving memory sentences here. Nothing is wrong with your data.'
            : 'Walrus Memory is not set up in this environment, so Gigr is not reading or saving memory sentences here. Nothing is wrong with your data.'
        }
        action={retryButton('Check again')}
      />
    )
  }

  if (reason === 'relayer_busy') {
    return (
      <MemoryNotice
        warning
        title="Walrus Memory is busy"
        body="The relayer is limiting how often it can be read right now. Your facts are safe. Wait a minute, then try again."
        action={retryButton('Try again')}
      />
    )
  }

  if (reason === 'relayer_timeout') {
    return (
      <MemoryNotice
        warning
        title="Walrus Memory took too long"
        body="The recall did not finish in time. Your facts are safe. Try again; a smaller recall often completes."
        action={retryButton('Try again')}
      />
    )
  }

  if (reason !== 'ok') {
    return (
      <MemoryNotice
        warning
        title="We could not read Walrus Memory"
        body="Nothing has changed. The sentences Gigr stores are safe. Try again in a moment."
        action={retryButton('Try again')}
      />
    )
  }

  if (facts.length === 0) {
    return <EmptyState onOpenAgent={onOpenAgent} />
  }

  const count = facts.length
  const factGroups = groupFactsByCategory(facts)
  const allExpanded =
    factGroups.length > 0 && factGroups.every((group) => expandedGroups.has(group.id))

  const toggleGroup = (id: FactCategory) => {
    setExpandedGroups((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    setExpandedGroups(
      allExpanded ? new Set() : new Set(factGroups.map((group) => group.id)),
    )
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            What Gigr remembers
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            {count} {count === 1 ? 'thing' : 'things'} Gigr remembers, grouped by what each
            sentence is about. Open a section to read it.
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={toggleAll}
          className="h-7 px-2 text-xs text-gray-500 hover:text-violet-600 dark:text-gray-400 dark:hover:text-violet-300"
        >
          {allExpanded ? 'Collapse all' : 'Expand all'}
        </Button>
      </div>

      <div className="space-y-3">
        {factGroups.map((group) => {
          const isExpanded = expandedGroups.has(group.id)
          return (
            <div
              key={group.id}
              className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-sm overflow-hidden"
            >
              <button
                type="button"
                onClick={() => toggleGroup(group.id)}
                aria-expanded={isExpanded}
                aria-controls={`fact-group-${group.id}`}
                className="w-full flex items-center gap-3 px-4 py-3.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500/40"
              >
                <span
                  className={cn(
                    'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
                    FACT_CATEGORY_ACCENTS[group.id],
                  )}
                >
                  {FACT_CATEGORY_ICONS[group.id]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {group.label}
                  </span>
                  <span className="block text-[11px] text-gray-500 mt-0.5">
                    {group.entries.length}{' '}
                    {group.entries.length === 1 ? 'thing' : 'things'}
                  </span>
                </span>
                <ChevronDown
                  className={cn(
                    'w-4 h-4 text-gray-400 transition-transform duration-200',
                    !isExpanded && '-rotate-90',
                  )}
                />
              </button>
              {isExpanded && (
                <ol
                  id={`fact-group-${group.id}`}
                  className="px-4 pb-3 divide-y divide-gray-100 dark:divide-gray-800 animate-in fade-in duration-200"
                >
                  {group.entries.map((fact, index) => (
                    <li
                      key={`${group.id}-${index}-${fact.text}`}
                      className="py-3 text-sm leading-relaxed text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words"
                    >
                      {fact.text}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-gray-400">
        {source === 'walrus'
          ? 'Read from Walrus Memory. Within each group, the most relevant sentence comes first. This is what one memory recall returned.'
          : 'This is what one memory recall returned.'}
      </p>
    </section>
  )
}

/** Why a namespace wipe did not happen, in the page's own words. */
function forgetFailureText(reason: string): string {
  switch (reason) {
    case 'feature_disabled':
      return 'Memory is turned off in this environment, so there is nothing here to forget.'
    case 'not_configured':
      return 'Walrus Memory is not set up in this environment, so there is nothing here to forget.'
    case 'relayer_busy':
      return 'Walrus Memory is busy right now. Nothing was deleted. Wait a minute, then try again.'
    case 'relayer_timeout':
      return 'Walrus Memory took too long to answer. Nothing was deleted. Try again in a moment.'
    default:
      return 'We could not reach Walrus Memory. Nothing was deleted. Try again in a moment.'
  }
}

/**
 * The namespace wipe: the one control that deletes stored sentences.
 *
 * Kept visually and textually separate from the per-preference Forget so the two
 * can never be confused: that one drops a saved value and leaves its sentence,
 * this one deletes every sentence the user has in Walrus Memory. The
 * confirmation says both things and that the wipe cannot be undone.
 */
function MemoryWipeSection({
  busy,
  onConfirm,
}: {
  busy: boolean
  onConfirm: () => void
}) {
  const [confirming, setConfirming] = useState(false)

  return (
    <section className="rounded-xl border border-red-200 bg-red-50/40 p-5 dark:border-red-900/60 dark:bg-red-950/20">
      <div className="flex gap-3">
        <div className="w-10 h-10 rounded-full bg-white dark:bg-gray-900 border border-red-200 dark:border-red-900/60 flex items-center justify-center shrink-0">
          <Trash2 className="w-5 h-5 text-red-600 dark:text-red-400" />
        </div>
        <div className="min-w-0">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">
            Forget everything
          </h2>
          <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">
            Removes your entire memory from Walrus Memory: every sentence Gigr has stored
            about you, in one action. It cannot be undone. Saved preferences above are
            separate and are not removed by this; forget those one at a time.
          </p>
          <Button
            variant="destructive"
            size="sm"
            className="mt-3"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {busy ? (
              <Loader2 className="w-3 h-3 animate-spin" />
            ) : (
              <Trash2 className="w-3 h-3" />
            )}
            Forget everything Gigr remembers about me
          </Button>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={(open) => {
          if (!open && !busy) setConfirming(false)
        }}
        title="Forget everything Gigr remembers about you?"
        description="This removes your entire memory from Walrus Memory, so none of the sentences Gigr stored about you can be recalled again. It cannot be undone. Saved preferences are not removed by this; forget them one at a time."
        confirmLabel="Forget everything"
        cancelLabel="Cancel"
        loading={busy}
        onConfirm={() => {
          setConfirming(false)
          onConfirm()
        }}
      />
    </section>
  )
}

function MemoryNotice({
  title,
  body,
  action,
  warning = false,
}: {
  title: string
  body: string
  action?: ReactNode
  warning?: boolean
}) {
  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/40 p-6">
      <div className="flex gap-3">
        <div className="w-10 h-10 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center shrink-0">
          {warning ? (
            <AlertTriangle className="w-5 h-5 text-amber-500" />
          ) : (
            <Bot className="w-5 h-5 text-gray-500" />
          )}
        </div>
        <div className="min-w-0">
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">{title}</h2>
          <p className="text-sm text-gray-500 mt-1">{body}</p>
          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
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
      <p className="text-xs text-gray-400">
        Reading the sentences from Walrus Memory. This can take a few seconds.
      </p>
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
