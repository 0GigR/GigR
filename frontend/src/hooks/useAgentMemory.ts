/**
 * useAgentMemory.ts - the memory map, the Walrus fact list, and the two calls
 * that act on the map.
 *
 * There is no GET /ai/memory returning the map. Memory is a sub-document of
 * ``users.ai_settings`` and is already returned by GET /ai/settings, which the
 * agent store uses for the same purpose. Reading it there keeps the existing
 * contract untouched.
 *
 * GET /ai/memory/facts is the read-only view of the sentences Walrus Memory
 * holds. It returns a bounded, query-driven recall, so its count is what this
 * read returned rather than a total.
 *
 * PATCH /ai/memory and DELETE /ai/memory/{key} do exist and return the whole
 * remaining memory map, which is what lets an entry disappear without a reload.
 * DELETE /ai/memory/{key} removes one JSONB key only: Walrus Memory has no
 * per-fact delete, so the sentence already written for that key can remain.
 *
 * DELETE /ai/memory is the separate namespace wipe. It deletes everything
 * Walrus Memory holds for the caller, is behind FEATURE_AGENT_WALRUS_MEMORY,
 * and answers with ok/reason instead of failing the page.
 *
 * DELETE /ai/memory/facts and PATCH /ai/memory/facts are the per-fact controls.
 * Walrus Memory has no per-fact delete or edit, so the backend implements both
 * by reading the namespace, wiping it and writing the kept sentences back. Both
 * answer with a typed result: `ok` is true only when the rewrite finished, and
 * `partial` marks a rewrite that stopped part way, so the page can say the
 * memory may be restored incompletely instead of claiming success.
 */

import { useQuery } from '@tanstack/react-query'
import api from '@/lib/api'
import { asFactCategory, type FactCategory } from '@/lib/agentMemory'

export interface AgentMemorySnapshot {
  memory: Record<string, unknown>
  /** False when the server says the agent is disabled in this environment. */
  agentEnabled: boolean
}

function asMemoryMap(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

async function fetchAgentMemory(): Promise<AgentMemorySnapshot> {
  const settingsResponse = await api.get('/ai/settings')
  return {
    memory: asMemoryMap(settingsResponse.data?.ai_settings?.memory),
    agentEnabled: settingsResponse.data?.agent_enabled !== false,
  }
}

export function useAgentMemory(enabled = true) {
  return useQuery<AgentMemorySnapshot>({
    queryKey: ['agent', 'memory'],
    queryFn: fetchAgentMemory,
    enabled,
    staleTime: 30 * 1000,
  })
}

/** Forget one key. Returns the memory the server says remains. */
export async function forgetAgentMemoryKey(key: string): Promise<Record<string, unknown> | null> {
  const deleteResponse = await api.delete(`/ai/memory/${encodeURIComponent(key)}`)
  const remaining = deleteResponse.data?.memory
  if (remaining && typeof remaining === 'object' && !Array.isArray(remaining)) {
    return remaining as Record<string, unknown>
  }
  return null
}

/**
 * The outcome of the namespace wipe, as the endpoint reports it.
 *
 * "ok" is true only when the relayer deleted the caller's rows (or a
 * verification read proved they were already gone). Every other case carries a
 * reason, and the page shows it instead of pretending the wipe happened.
 */
export interface NamespaceForgetResult {
  ok: boolean
  /** Rows the relayer reported deleting, or null when it reported no count. */
  deleted: number | null
  reason: string
}

const FORGET_REASONS = new Set<string>([
  'ok',
  'feature_disabled',
  'not_configured',
  'relayer_busy',
  'relayer_timeout',
  'relayer_unavailable',
])

/**
 * Delete this user's entire Walrus Memory namespace.
 *
 * The request carries no user or namespace: the backend derives both from the
 * authenticated session, so this can only ever delete the caller's own memory.
 * A slow relayer is bounded by the backend (8s), so the request budget sits
 * above it.
 */
export async function forgetAgentMemoryNamespace(): Promise<NamespaceForgetResult> {
  const response = await api.delete('/ai/memory', { timeout: 20000 })
  const raw =
    response.data && typeof response.data === 'object'
      ? (response.data as Record<string, unknown>)
      : {}
  const reason = typeof raw.reason === 'string' && FORGET_REASONS.has(raw.reason)
    ? raw.reason
    : 'relayer_unavailable'
  return {
    ok: raw.ok === true,
    deleted: typeof raw.deleted === 'number' ? raw.deleted : null,
    reason,
  }
}

/** One stored sentence, exactly as Walrus Memory returned it. */
export interface MemoryFact {
  text: string
  category: FactCategory
}

/**
 * Why a facts read returned what it did. "ok" means the relayer answered;
 * every other value is a calm state the page renders instead of an error.
 */
export type MemoryFactsReason =
  | 'ok'
  | 'feature_disabled'
  | 'not_configured'
  | 'relayer_busy'
  | 'relayer_timeout'
  | 'relayer_unavailable'
  | 'unavailable'

export interface AgentMemoryFacts {
  facts: MemoryFact[]
  /**
   * The number of sentences actually listed. Derived from the list, never
   * copied from the body, so the page can never print a count it is not
   * showing.
   */
  count: number
  source: 'walrus' | 'none'
  reason: MemoryFactsReason
}

const FACTS_REASONS = new Set<MemoryFactsReason>([
  'ok',
  'feature_disabled',
  'not_configured',
  'relayer_busy',
  'relayer_timeout',
  'relayer_unavailable',
])

/**
 * Coerce an unknown response body into the strict shape above.
 *
 * A malformed body becomes an empty list with an "unavailable" reason, which
 * the page shows as a calm note. It can never produce a fact that was not
 * returned.
 */
export function normalizeMemoryFacts(body: unknown): AgentMemoryFacts {
  const raw = body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const facts = Array.isArray(raw.facts)
    ? raw.facts.flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return []
        const record = entry as Record<string, unknown>
        const text = record.text
        if (typeof text !== 'string' || !text.trim()) return []
        return [{ text, category: asFactCategory(record.category) }]
      })
    : []
  const reason =
    typeof raw.reason === 'string' && FACTS_REASONS.has(raw.reason as MemoryFactsReason)
      ? (raw.reason as MemoryFactsReason)
      : 'unavailable'
  return {
    facts,
    count: facts.length,
    source: raw.source === 'walrus' ? 'walrus' : 'none',
    reason,
  }
}

async function fetchAgentMemoryFacts(): Promise<AgentMemoryFacts> {
  // A review recall downloads and decrypts one entry per fact, which can take
  // longer than the shared 15s API timeout. The backend bounds the recall at
  // 20s, so the request budget sits above it.
  const factsResponse = await api.get('/ai/memory/facts', { timeout: 30000 })
  return normalizeMemoryFacts(factsResponse.data)
}

/** The read-only view of the sentences Walrus Memory holds for this user. */
export function useAgentMemoryFacts(enabled = true) {
  return useQuery<AgentMemoryFacts>({
    queryKey: ['agent', 'memory', 'facts'],
    queryFn: fetchAgentMemoryFacts,
    enabled,
    staleTime: 5 * 60 * 1000,
    // No automatic retry: one recall already costs the relayer budget, and the
    // page offers an explicit Try again button. A 429 must not be widened by a
    // silent second attempt.
    retry: 0,
  })
}

/** Advisory, read-only Sui verification. Never used to change a memory. */
export async function verifyMemoryReference(reference: string): Promise<unknown> {
  const verificationResponse = await api.get('/ai/memory/verification', {
    params: { reference },
  })
  return verificationResponse.data
}

/**
 * Why one per-fact change returned what it did.
 *
 * "ok" means the namespace was rewritten and holds exactly the memories that
 * should remain. "nothing_to_remove", "nothing_to_replace" and "unchanged" are
 * clean no-ops: nothing was wiped. "restore_incomplete" is the loud one: the
 * wipe ran and the rewrite did not finish.
 */
export type MemoryReconcileReason =
  | 'ok'
  | 'nothing_to_remove'
  | 'nothing_to_replace'
  | 'unchanged'
  | 'invalid_text'
  | 'feature_disabled'
  | 'not_configured'
  | 'relayer_busy'
  | 'relayer_timeout'
  | 'relayer_unavailable'
  | 'memory_too_large'
  | 'journal_failed'
  | 'restore_incomplete'
  | 'unavailable'

/**
 * What one delete or edit did, as the endpoint reports it.
 *
 * `partial` is never combined with `ok`: a rewrite that stopped part way may
 * have left the namespace holding only some of the user's memories, and the
 * page must say so rather than report a success. `remaining` is null whenever
 * the backend cannot trust the count, and the page then prints no count.
 */
export interface MemoryReconcileResult {
  ok: boolean
  reason: MemoryReconcileReason
  removed: number
  restored: number
  remaining: number | null
  partial: boolean
  /** True when an earlier interrupted rewrite was completed first. */
  recovered: boolean
  detail: string
}

const RECONCILE_REASONS = new Set<MemoryReconcileReason>([
  'ok',
  'nothing_to_remove',
  'nothing_to_replace',
  'unchanged',
  'invalid_text',
  'feature_disabled',
  'not_configured',
  'relayer_busy',
  'relayer_timeout',
  'relayer_unavailable',
  'memory_too_large',
  'journal_failed',
  'restore_incomplete',
  'unavailable',
])

/**
 * The local sentence for a reason the server did not describe itself.
 *
 * A partial result always says the memory may be restored incompletely, even
 * when the reason is a relayer one: what matters to the reader then is that the
 * rewrite stopped, not which call stopped it.
 */
export function reconcileDetailFallback(
  reason: MemoryReconcileReason,
  partial = false,
): string {
  if (partial) {
    return 'Your memory may be restored incompletely. Try again to finish restoring it.'
  }
  switch (reason) {
    case 'ok':
      return 'Your memory was updated.'
    case 'nothing_to_remove':
      return 'Those memories are not in Walrus Memory any more, so nothing was removed.'
    case 'nothing_to_replace':
      return 'That memory is not in Walrus Memory any more, so nothing was changed.'
    case 'unchanged':
      return 'The new text is the same as the old text, so nothing was changed.'
    case 'invalid_text':
      return 'That text cannot be used. Check it and try again.'
    case 'feature_disabled':
      return 'Memory is turned off in this environment, so nothing was changed.'
    case 'not_configured':
      return 'Walrus Memory is not set up in this environment, so nothing was changed.'
    case 'relayer_busy':
      return 'Walrus Memory is busy right now. Nothing was removed. Wait a minute, then try again.'
    case 'relayer_timeout':
      return 'Walrus Memory took too long to answer. Nothing was removed. Try again in a moment.'
    case 'relayer_unavailable':
      return 'We could not reach Walrus Memory. Nothing was removed. Try again in a moment.'
    case 'memory_too_large':
      return 'Walrus Memory holds more memories than this control reads in one pass, so nothing was removed.'
    case 'journal_failed':
      return 'We could not prepare the change safely, so nothing was removed. Try again in a moment.'
    case 'restore_incomplete':
      return 'Your memory may be restored incompletely. Try again to finish restoring it.'
    default:
      return 'We did not get a clear answer, so we cannot confirm your memory changed. Reload the page to see what is stored.'
  }
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0
}

/**
 * Coerce an unknown response body into the strict result above.
 *
 * A body that claims success while also reporting a partial rewrite is read as
 * a partial failure: the safe reading is the one that does not tell the user
 * their memory is intact.
 */
export function normalizeReconcileResult(body: unknown): MemoryReconcileResult {
  const raw =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  const reason =
    typeof raw.reason === 'string' &&
    RECONCILE_REASONS.has(raw.reason as MemoryReconcileReason)
      ? (raw.reason as MemoryReconcileReason)
      : 'unavailable'
  const partial = raw.partial === true
  const detail =
    typeof raw.detail === 'string' && raw.detail.trim()
      ? raw.detail.trim()
      : reconcileDetailFallback(reason, partial)
  return {
    ok: raw.ok === true && !partial,
    reason,
    removed: asCount(raw.removed),
    restored: asCount(raw.restored),
    remaining:
      typeof raw.remaining === 'number' &&
      Number.isFinite(raw.remaining) &&
      raw.remaining >= 0
        ? Math.floor(raw.remaining)
        : null,
    partial,
    recovered: raw.recovered === true,
    detail,
  }
}

// A reconcile reads the namespace, wipes it and writes every kept memory back,
// one relayer call each. The backend bounds the read at 30s and each write at
// the dependency's timeout, so the request budget sits well above one read.
const RECONCILE_TIMEOUT_MS = 120000

/**
 * Delete the named memories. The request carries no user and no namespace: the
 * backend derives both from the authenticated session, so this can only ever
 * rewrite the caller's own memory.
 */
export async function deleteMemoryFacts(
  texts: string[],
): Promise<MemoryReconcileResult> {
  const response = await api.delete('/ai/memory/facts', {
    data: { texts },
    timeout: RECONCILE_TIMEOUT_MS,
  })
  return normalizeReconcileResult(response.data)
}

/** Delete every memory in one displayed category. */
export async function deleteMemoryCategory(
  category: FactCategory,
): Promise<MemoryReconcileResult> {
  const response = await api.delete('/ai/memory/facts', {
    data: { category },
    timeout: RECONCILE_TIMEOUT_MS,
  })
  return normalizeReconcileResult(response.data)
}

/**
 * Replace one stored memory with new text.
 *
 * This is a delete plus a re-add over the whole namespace, which is why the
 * page presents it as an edit and says that the remaining memories are
 * rewritten.
 */
export async function replaceMemoryFact(
  oldText: string,
  newText: string,
): Promise<MemoryReconcileResult> {
  const response = await api.patch(
    '/ai/memory/facts',
    { old_text: oldText, new_text: newText },
    { timeout: RECONCILE_TIMEOUT_MS },
  )
  return normalizeReconcileResult(response.data)
}
