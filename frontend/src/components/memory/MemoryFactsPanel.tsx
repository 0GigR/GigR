/**
 * MemoryFactsPanel.tsx - the sentences Walrus Memory holds, and the controls
 * that change one of them.
 *
 * Walrus Memory has no per-fact delete or edit. The backend therefore rewrites
 * the whole namespace for every change: it reads the sentences, wipes them and
 * writes the ones that remain back. That is why every confirmation here says
 * three things: the memory is removed, the change cannot be undone, and the
 * memories that are kept are rewritten. The controls are deliberately heavier
 * than a plain list edit, because the operation behind them is heavier.
 *
 * A rewrite that stopped part way is never shown as a success. The result panel
 * says the memory may be restored incompletely, and offers to finish restoring
 * it; the backend completes any interrupted restore before it runs the retry.
 *
 * House standard: zero emojis, zero decorative unicode, a confirmation for
 * every destructive control, and an honest state for loading, empty, error and
 * feature-disabled.
 */

import { useRef, useState, type ReactNode } from 'react'
import { useMutation } from '@tanstack/react-query'
import {
  AlertTriangle,
  Bot,
  Brain,
  Briefcase,
  ChevronDown,
  FolderOpen,
  Loader2,
  MessageSquare,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Star,
  Tag,
  Trash2,
  User,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { extractError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { cn } from '@/lib/utils'
import {
  deleteMemoryCategory,
  deleteMemoryFacts,
  replaceMemoryFact,
  type MemoryFact,
  type MemoryFactsReason,
  type MemoryReconcileResult,
} from '@/hooks/useAgentMemory'
import {
  groupFactsByCategory,
  type FactCategory,
} from '@/lib/agentMemory'

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
  other: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
}

const MAX_FACT_LENGTH = 2000

/** One change the panel can ask for, kept so a partial restore can be finished. */
type ReconcileAction =
  | { kind: 'texts'; texts: string[] }
  | { kind: 'category'; category: FactCategory; label: string; count: number }
  | { kind: 'replace'; oldText: string; newText: string }

interface MemoryFactsPanelProps {
  facts: MemoryFact[]
  reason: MemoryFactsReason
  source: 'walrus' | 'none'
  loading: boolean
  failed: boolean
  retrying: boolean
  onRetry: () => void
  onReconciled: () => void
  onOpenAgent: () => void
}

export function MemoryFactsPanel({
  facts,
  reason,
  source,
  loading,
  failed,
  retrying,
  onRetry,
  onReconciled,
  onOpenAgent,
}: MemoryFactsPanelProps) {
  // Hooks run before every early return: the panel is rendered while loading,
  // then with facts, and the state must keep its slot across those renders.
  const [expandedGroups, setExpandedGroups] = useState<Set<FactCategory>>(
    new Set(),
  )
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [editing, setEditing] = useState<{
    text: string
    draft: string
    error: string | null
  } | null>(null)
  const [pending, setPending] = useState<ReconcileAction | null>(null)
  const [outcome, setOutcome] = useState<{
    result: MemoryReconcileResult
    action: ReconcileAction
  } | null>(null)
  const submittingRef = useRef(false)

  const reconcile = useMutation({
    mutationFn: (action: ReconcileAction): Promise<MemoryReconcileResult> => {
      if (action.kind === 'texts') return deleteMemoryFacts(action.texts)
      if (action.kind === 'category') {
        return deleteMemoryCategory(action.category)
      }
      return replaceMemoryFact(action.oldText, action.newText)
    },
    onSuccess: (result, action) => {
      setPending(null)
      setEditing(null)
      setSelected(new Set())
      setOutcome({ result, action })
      if (result.ok) toast.success(result.detail)
      else toast.error(result.detail)
      // The namespace was rewritten, so the list is re-read rather than patched.
      onReconciled()
    },
    onError: (error: unknown, action) => {
      // No answer is not the same as nothing happening: the request may have
      // run. Say the memory may be restored incompletely and keep the action so
      // the reader can finish, instead of claiming success or a clean failure.
      const result: MemoryReconcileResult = {
        ok: false,
        reason: 'unavailable',
        removed: 0,
        restored: 0,
        remaining: null,
        partial: true,
        recovered: false,
        detail:
          'We did not get an answer from Gigr, so we cannot confirm whether your memory changed. Reload the page to see what is stored, then try again to finish restoring it.',
      }
      setPending(null)
      setOutcome({ result, action })
      toast.error(extractError(error, result.detail))
      onReconciled()
    },
  })

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

  const outcomeNotice = outcome ? (
    <ReconcileNotice
      result={outcome.result}
      busy={reconcile.isPending}
      onFinish={
        outcome.result.partial
          ? () => {
              reconcile.mutate(outcome.action)
            }
          : undefined
      }
      onDismiss={() => setOutcome(null)}
    />
  ) : null

  if (loading) return <LoadingState />

  if (failed) {
    return (
      <section className="space-y-3">
        {outcomeNotice}
        <MemoryNotice
          warning
          title="We could not read Walrus Memory"
          body="Nothing has changed. The sentences Gigr stores are safe. Check your connection, then try again."
          action={retryButton('Try again')}
        />
      </section>
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
    return (
      <section className="space-y-3">
        {outcomeNotice}
        <EmptyState onOpenAgent={onOpenAgent} />
      </section>
    )
  }

  const factGroups = groupFactsByCategory(facts)
  const selectedFacts = facts.filter((fact) => selected.has(fact.text))
  const selectedCount = selectedFacts.length
  const allExpanded =
    factGroups.length > 0 &&
    factGroups.every((group) => expandedGroups.has(group.id))

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

  const toggleSelected = (text: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(text)) next.delete(text)
      else next.add(text)
      return next
    })
  }

  const changeDraft = (value: string) => {
    setEditing((current) =>
      current ? { ...current, draft: value, error: null } : current,
    )
  }

  const reviewEdit = () => {
    if (!editing) return
    const draft = editing.draft.trim()
    if (!draft) {
      setEditing({ ...editing, error: 'Enter the replacement text.' })
      return
    }
    if (draft.length > MAX_FACT_LENGTH) {
      setEditing({
        ...editing,
        error: `Keep the text to ${MAX_FACT_LENGTH} characters or fewer.`,
      })
      return
    }
    if (draft === editing.text) {
      setEditing({
        ...editing,
        error: 'The new text is the same as the old text, so nothing would change.',
      })
      return
    }
    setPending({ kind: 'replace', oldText: editing.text, newText: draft })
  }

  const confirmation = confirmCopy(pending)

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            What Gigr remembers
          </h2>
          <p className="text-sm text-gray-500 mt-1">
            {facts.length} {facts.length === 1 ? 'thing' : 'things'} Gigr
            remembers, grouped by what each sentence is about. Select memories
            to delete them, or edit one in place.
          </p>
          <p className="text-xs text-gray-400 mt-1 max-w-xl">
            Every change rewrites the memories you keep, because Walrus Memory
            can only delete a whole namespace at a time. The rewrite saves them
            again with today&apos;s date.
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

      {outcomeNotice}

      {selectedCount > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-200 bg-red-50/60 px-4 py-2.5 dark:border-red-900/60 dark:bg-red-950/20">
          <p className="text-sm font-medium text-red-800 dark:text-red-200">
            {selectedCount} selected
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              className="h-8 px-2 text-xs"
              disabled={reconcile.isPending}
              onClick={() => setSelected(new Set())}
            >
              <X className="w-3 h-3" />
              Clear selection
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-8 px-2.5 text-xs"
              disabled={reconcile.isPending}
              onClick={() =>
                setPending({
                  kind: 'texts',
                  texts: selectedFacts.map((fact) => fact.text),
                })
              }
            >
              <Trash2 className="w-3 h-3" />
              Delete selected
            </Button>
          </div>
        </div>
      )}

      <div className="space-y-3">
        {factGroups.map((group) => {
          const isExpanded = expandedGroups.has(group.id)
          return (
            <div
              key={group.id}
              className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-sm overflow-hidden"
            >
              <div className="flex items-stretch">
                <button
                  type="button"
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={isExpanded}
                  aria-controls={`fact-group-${group.id}`}
                  className="min-w-0 flex-1 flex items-center gap-3 px-4 py-3.5 text-left hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-violet-500/40"
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
                <div className="flex items-center pr-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 px-2 text-[11px] text-red-600 hover:text-red-700 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/30"
                    disabled={reconcile.isPending}
                    aria-label={`Delete all memories in ${group.label}`}
                    onClick={() =>
                      setPending({
                        kind: 'category',
                        category: group.id,
                        label: group.label,
                        count: group.entries.length,
                      })
                    }
                  >
                    <Trash2 className="w-3 h-3" />
                    Delete category
                  </Button>
                </div>
              </div>

              {isExpanded && (
                <ol
                  id={`fact-group-${group.id}`}
                  className="px-4 pb-3 divide-y divide-gray-100 dark:divide-gray-800 animate-in fade-in duration-200"
                >
                  {group.entries.map((fact) => {
                    const isEditing = editing?.text === fact.text
                    return (
                      <li key={`${group.id}-${fact.text}`} className="py-3">
                        {isEditing ? (
                          <div className="space-y-2">
                            <label
                              className="block text-[11px] font-medium text-gray-500"
                              htmlFor={`edit-memory-${group.id}`}
                            >
                              New text for this memory
                            </label>
                            <textarea
                              id={`edit-memory-${group.id}`}
                              value={editing.draft}
                              onChange={(event) =>
                                changeDraft(event.target.value)
                              }
                              rows={2}
                              maxLength={MAX_FACT_LENGTH}
                              className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-200 dark:border-gray-700 dark:bg-gray-950 dark:text-gray-100 dark:focus:ring-violet-900/60"
                            />
                            {editing.error && (
                              <p className="text-xs text-red-600 dark:text-red-400">
                                {editing.error}
                              </p>
                            )}
                            <div className="flex items-center justify-end gap-2">
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-8 text-xs"
                                disabled={reconcile.isPending}
                                onClick={() => setEditing(null)}
                              >
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                className="h-8 text-xs"
                                disabled={reconcile.isPending}
                                onClick={reviewEdit}
                              >
                                Save edit
                              </Button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start gap-3">
                            <input
                              type="checkbox"
                              className="mt-1 h-4 w-4 shrink-0 rounded border-gray-300 text-violet-600 focus:ring-violet-500 dark:border-gray-600 dark:bg-gray-800"
                              checked={selected.has(fact.text)}
                              disabled={reconcile.isPending}
                              aria-label={`Select this memory: ${fact.text}`}
                              onChange={() => toggleSelected(fact.text)}
                            />
                            <p className="min-w-0 flex-1 text-sm leading-relaxed text-gray-800 dark:text-gray-200 whitespace-pre-wrap break-words">
                              {fact.text}
                            </p>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 px-2 text-xs text-gray-500 hover:text-violet-700 dark:text-gray-400 dark:hover:text-violet-300"
                              disabled={reconcile.isPending}
                              aria-label={`Edit this memory: ${fact.text}`}
                              onClick={() =>
                                setEditing({
                                  text: fact.text,
                                  draft: fact.text,
                                  error: null,
                                })
                              }
                            >
                              <Pencil className="w-3 h-3" />
                              Edit
                            </Button>
                          </div>
                        )}
                      </li>
                    )
                  })}
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

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !reconcile.isPending) setPending(null)
        }}
        title={confirmation.title}
        description={confirmation.description}
        confirmLabel={confirmation.confirmLabel}
        cancelLabel="Cancel"
        destructive
        loading={reconcile.isPending}
        onConfirm={() => {
          if (!pending || submittingRef.current) return
          submittingRef.current = true
          reconcile.mutate(pending, {
            onSettled: () => {
              submittingRef.current = false
            },
          })
        }}
      />
    </section>
  )
}

/**
 * The confirmation text for one change.
 *
 * Every one of these states what is removed, that it cannot be undone, and that
 * the kept memories are rewritten: the last part is what a reader would not
 * expect from a delete, and hiding it would be dishonest about the operation.
 */
function confirmCopy(action: ReconcileAction | null): {
  title: string
  description: string
  confirmLabel: string
} {
  if (action === null) {
    return {
      title: 'Change this memory?',
      description: '',
      confirmLabel: 'Continue',
    }
  }
  if (action.kind === 'texts') {
    const count = action.texts.length
    const noun = count === 1 ? 'memory' : 'memories'
    return {
      title: `Delete ${count} selected ${noun}?`,
      description:
        `This removes ${count} ${noun} from Walrus Memory. It cannot be undone. ` +
        'The memories you keep are rewritten as part of the change, because Walrus Memory ' +
        'can only delete a whole namespace at a time. The rewritten memories are saved again ' +
        "with today's date.",
      confirmLabel: `Delete ${count} ${noun}`,
    }
  }
  if (action.kind === 'category') {
    const noun = action.count === 1 ? 'memory' : 'memories'
    return {
      title: `Delete every memory in ${action.label}?`,
      description:
        `This removes every memory in ${action.label}: the ${action.count} listed here, ` +
        'and any other that belongs to the same group, from Walrus Memory. It cannot be ' +
        'undone. The memories you keep are rewritten as part of the change, because Walrus ' +
        'Memory can only delete a whole namespace at a time. The rewritten memories are ' +
        "saved again with today's date.",
      confirmLabel: `Delete ${action.count} ${noun}`,
    }
  }
  return {
    title: 'Replace this memory?',
    description:
      'This removes the old sentence and saves the new one in its place. It cannot be ' +
      'undone. Every other memory is rewritten as part of the change, because Walrus Memory ' +
      'can only delete a whole namespace at a time. The rewritten memories are saved again ' +
      "with today's date.",
    confirmLabel: 'Replace memory',
  }
}

function ReconcileNotice({
  result,
  busy,
  onFinish,
  onDismiss,
}: {
  result: MemoryReconcileResult
  busy: boolean
  onFinish?: () => void
  onDismiss: () => void
}) {
  const partial = result.partial
  // A no-op is a success, but nothing was updated, and the title must not say
  // otherwise.
  const noop =
    result.reason === 'nothing_to_remove' ||
    result.reason === 'nothing_to_replace' ||
    result.reason === 'unchanged'
  const title = partial
    ? 'Your memory may be restored incompletely'
    : result.ok
      ? noop
        ? 'Nothing to change'
        : 'Memory updated'
      : 'The change did not run'
  const tone = partial
    ? 'border-red-200 bg-red-50/60 dark:border-red-900/60 dark:bg-red-950/20'
    : result.ok
      ? 'border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/60 dark:bg-emerald-950/20'
      : 'border-amber-200 bg-amber-50/60 dark:border-amber-900/60 dark:bg-amber-950/20'
  const iconTone = partial
    ? 'text-red-600 dark:text-red-400'
    : result.ok
      ? 'text-emerald-600 dark:text-emerald-400'
      : 'text-amber-600 dark:text-amber-400'

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn('rounded-xl border p-4', tone)}
    >
      <div className="flex gap-3">
        <div className="shrink-0 pt-0.5">
          {result.ok && !partial ? (
            <ShieldCheck className={cn('w-5 h-5', iconTone)} />
          ) : (
            <AlertTriangle className={cn('w-5 h-5', iconTone)} />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </p>
          <p className="mt-1 text-sm text-gray-700 dark:text-gray-300">
            {result.detail}
          </p>
          {result.recovered && (
            <p className="mt-1 text-xs text-gray-500">
              An interrupted change was finished first; the memories it kept are
              stored again.
            </p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {partial && onFinish && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={busy}
                onClick={onFinish}
              >
                {busy ? (
                  <Loader2 className="w-3 h-3 animate-spin" />
                ) : (
                  <RefreshCw className="w-3 h-3" />
                )}
                Finish restoring
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs"
              disabled={busy}
              onClick={onDismiss}
            >
              Dismiss
            </Button>
          </div>
        </div>
      </div>
    </div>
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
          <h2 className="font-semibold text-gray-900 dark:text-gray-100">
            {title}
          </h2>
          <p className="text-sm text-gray-500 mt-1">{body}</p>
          {action && <div className="mt-3">{action}</div>}
        </div>
      </div>
    </div>
  )
}

function LoadingState() {
  return (
    <div className="space-y-4" aria-busy="true">
      <p className="text-sm text-gray-500">
        Loading what Gigr remembers...
      </p>
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

function EmptyState({ onOpenAgent }: { onOpenAgent: () => void }) {
  return (
    <div className="text-center py-14 px-4 border border-dashed border-gray-200 dark:border-gray-800 rounded-xl bg-gray-50 dark:bg-gray-900/40">
      <div className="w-12 h-12 rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center mx-auto">
        <Brain className="w-6 h-6 text-gray-400" />
      </div>
      <p className="font-medium mt-3">Nothing remembered yet</p>
      <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
        Gigr has not stored anything about you. When the agent learns a
        preference from a task, or you ask it to remember something, it appears
        here.
      </p>
      <Button variant="outline" size="sm" className="mt-4" onClick={onOpenAgent}>
        Open the agent
      </Button>
    </div>
  )
}
