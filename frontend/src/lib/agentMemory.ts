/**
 * agentMemory.ts - reading, grouping and describing the agent's durable memory.
 *
 * The backend stores memory as a free-form JSON object under
 * ``users.ai_settings.memory``. Keys are written by the agent, so this module
 * treats them as data: it never drops an entry it does not recognise, and it
 * never invents a timestamp the server does not send.
 *
 * Verification is advisory. The types here mirror
 * backend/app/services/memory_verification_service.py and this module refuses
 * to report "verified" unless the server said both available and verified.
 *
 * House standard: zero emojis, zero decorative unicode.
 */

export interface MemoryEntry {
  key: string
  value: unknown
}

export interface MemoryGroup {
  id: string
  label: string
  entries: MemoryEntry[]
}

/** The categories the backend assigns to one recalled sentence. */
export type FactCategory =
  | 'about'
  | 'jobs'
  | 'services'
  | 'messages'
  | 'ratings'
  | 'other'

export interface FactEntry {
  text: string
  category: FactCategory
}

export interface FactGroup {
  id: FactCategory
  label: string
  entries: FactEntry[]
}

const FACT_CATEGORY_LABELS: Record<FactCategory, string> = {
  about: 'About you',
  jobs: 'Work and jobs',
  services: 'Services and rates',
  messages: 'Messages and activity',
  ratings: 'Ratings and disputes',
  other: 'Other details',
}

// The order the page reads: who the person is, what they did, what they offer,
// how they talk, how they were rated, and anything the rule did not recognise.
const FACT_CATEGORY_ORDER: readonly FactCategory[] = [
  'about',
  'jobs',
  'services',
  'messages',
  'ratings',
  'other',
]

const FACT_CATEGORIES = new Set<string>(Object.keys(FACT_CATEGORY_LABELS))

/**
 * Coerce an unknown category into one this page can render.
 *
 * A missing or unknown value becomes "other" rather than disappearing: the
 * sentence is real memory and must still be shown, even when its category is
 * not one this build knows.
 */
export function asFactCategory(value: unknown): FactCategory {
  return typeof value === 'string' && FACT_CATEGORIES.has(value)
    ? (value as FactCategory)
    : 'other'
}

/**
 * Group facts by category, in the page's fixed order.
 *
 * Entries keep the order the server sent them (the relayer's relevance order),
 * so grouping never reshuffles a section. An empty category is omitted instead
 * of rendering a heading with no rows.
 */
export function groupFactsByCategory(facts: FactEntry[]): FactGroup[] {
  return FACT_CATEGORY_ORDER.map((id) => ({
    id,
    label: FACT_CATEGORY_LABELS[id],
    entries: facts.filter((fact) => fact.category === id),
  })).filter((group) => group.entries.length > 0)
}

/** The four keys the agent's own guardrails currently write. */
const KNOWN_LABELS: Record<string, string> = {
  location_name: 'Preferred location',
  usual_price_job: 'Typical job budget',
  preferred_categories: 'Preferred categories',
  last_search: 'Last search',
}

/**
 * A readable label for a memory key without hiding the key itself. Known keys
 * get a sentence-case label; anything else is split on its separators and
 * camel-case boundaries, with only the first letter capitalised so values such
 * as "USD" survive.
 */
export function humanizeMemoryKey(key: string): string {
  const known = KNOWN_LABELS[key]
  if (known) return known
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!spaced) return key
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

interface GroupRule {
  id: string
  label: string
  pattern: RegExp
}

// Order is the display order. The first matching rule wins, so a key such as
// "preferred_location" lands under Location rather than Preferences.
const GROUP_RULES: readonly GroupRule[] = [
  { id: 'location', label: 'Location', pattern: /location|city|country|address|area|radius|geograph/i },
  { id: 'preferences', label: 'Preferences', pattern: /prefer|categor|interest|language|style|taste/i },
  { id: 'budgets', label: 'Budgets and pricing', pattern: /price|budget|currency|cost|amount|spend|rate/i },
  { id: 'activity', label: 'Recent activity', pattern: /last|recent|search|query|history|activity/i },
  { id: 'chain', label: 'On-chain references', pattern: /sui|walrus|blob|object|chain|wallet|tx|digest|hash/i },
]

const OTHER_GROUP: GroupRule = { id: 'other', label: 'Other details', pattern: /$^/ }

function groupFor(key: string): GroupRule {
  for (const rule of GROUP_RULES) {
    if (rule.pattern.test(key)) return rule
  }
  return OTHER_GROUP
}

/**
 * Group every memory entry exactly once. Unknown keys are not discarded; they
 * fall into "Other details" so a new key the agent learns still shows up.
 */
export function groupMemory(memory: Record<string, unknown>): MemoryGroup[] {
  const buckets = new Map<string, MemoryEntry[]>()

  for (const [key, value] of Object.entries(memory)) {
    const group = groupFor(key)
    const entries = buckets.get(group.id) ?? []
    entries.push({ key, value })
    buckets.set(group.id, entries)
  }

  const ordered = [...GROUP_RULES, OTHER_GROUP]
  return ordered
    .map((rule) => ({
      id: rule.id,
      label: rule.label,
      entries: (buckets.get(rule.id) ?? []).sort((a, b) =>
        humanizeMemoryKey(a.key).localeCompare(humanizeMemoryKey(b.key)),
      ),
    }))
    .filter((group) => group.entries.length > 0)
}

export type MemoryValueView =
  | { kind: 'empty'; text: string }
  | { kind: 'text'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'json'; text: string }

/**
 * A rendering decision, not a transformation: the value is never edited before
 * it is shown, so what the user reads is what the agent stored.
 */
export function formatMemoryValue(value: unknown): MemoryValueView {
  if (value === null || value === undefined || value === '') {
    return { kind: 'empty', text: 'Not set' }
  }
  if (typeof value === 'string') {
    return { kind: 'text', text: value }
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return { kind: 'text', text: String(value) }
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { kind: 'empty', text: 'No items' }
    const simple = value.every(
      (item) =>
        typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
    )
    if (simple) return { kind: 'list', items: value.map((item) => String(item)) }
  }
  if (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  ) {
    return { kind: 'empty', text: 'Not set' }
  }
  try {
    const text = JSON.stringify(value, null, 2)
    return { kind: 'json', text: text ?? String(value) }
  } catch {
    return { kind: 'text', text: String(value) }
  }
}

// A Sui object id: 0x followed by 1-64 hex characters. Mirrors the backend.
const OBJECT_ID = /^0x[0-9a-fA-F]{1,64}$/

function stripReferencePrefix(raw: string): string | null {
  const trimmed = raw.trim()
  if (OBJECT_ID.test(trimmed)) return trimmed
  const lowered = trimmed.toLowerCase()
  for (const prefix of ['sui:', 'object:']) {
    if (lowered.startsWith(prefix)) {
      const candidate = trimmed.slice(prefix.length).trim()
      if (OBJECT_ID.test(candidate)) return candidate
    }
  }
  return null
}

/**
 * The Sui object id a value points at, when there is exactly one candidate.
 *
 * An ambiguous value (two different ids) returns null: showing a "Verify"
 * button that silently checked one of several ids would be a guess.
 */
export function findSuiReference(value: unknown): string | null {
  if (typeof value === 'string') {
    const direct = stripReferencePrefix(value)
    if (direct) return direct
  }

  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''
  } catch {
    return null
  }

  const matches = text.match(/\b0x[0-9a-fA-F]{1,64}\b/g)
  if (!matches || matches.length === 0) return null
  const unique = Array.from(new Set(matches))
  return unique.length === 1 ? unique[0] : null
}

export interface MemoryVerification {
  reference: string
  advisory?: boolean
  available: boolean
  checked: boolean
  verified: boolean
  reason: string
  object_id?: string | null
  object_type?: string | null
  object_version?: number | null
  owner_kind?: string | null
  certified_epoch?: number | null
  end_epoch?: number | null
  deletable?: boolean | null
}

export type VerificationTone = 'verified' | 'unverified' | 'unavailable'

const UNAVAILABLE_REASONS = new Set([
  'feature_disabled',
  'tatum_not_configured',
  'empty_reference',
  'unrecognised_reference',
  'blob_id_not_resolvable_without_indexer',
  'verification_unavailable',
  'grpc_timeout',
  'grpc_transport_error',
  'rpc_error',
  'request_failed',
])

/**
 * verified: the server confirmed a certified Walrus blob.
 * unverified: the server checked and the answer was no.
 * unavailable: the check never produced an answer (feature off, not
 * configured, unreachable, or an input the check cannot resolve).
 */
export function verificationTone(result: MemoryVerification): VerificationTone {
  if (result.available === true && result.verified === true) return 'verified'
  if (result.available !== true) return 'unavailable'
  if (result.checked !== true) return 'unavailable'
  if (UNAVAILABLE_REASONS.has(result.reason)) return 'unavailable'
  return 'unverified'
}

export function verificationLabel(tone: VerificationTone): string {
  if (tone === 'verified') return 'Verified'
  if (tone === 'unverified') return 'Not verified'
  return 'Unavailable'
}

const REASON_TEXT: Record<string, string> = {
  feature_disabled: 'Sui verification is turned off in this environment.',
  tatum_not_configured: 'Sui verification is not configured in this environment.',
  empty_reference: 'This memory has no reference to check.',
  unrecognised_reference: 'This value is not a Sui object id, so there is nothing to look up.',
  blob_id_not_resolvable_without_indexer:
    'This is a Walrus blob id. Resolving it to a Sui object needs the Walrus indexer, which this check does not use.',
  verification_unavailable:
    'We could not reach Sui just now. The memory is unchanged. Try again in a moment.',
  grpc_timeout: 'Sui did not answer within the time limit. Nothing was changed. Try again.',
  grpc_transport_error:
    'We could not reach the Sui gRPC endpoint. Nothing was changed. Try again in a moment.',
  request_failed:
    'The check could not run just now. The memory is unchanged. Try again in a moment.',
  object_not_found:
    'No Sui object with this id was found. The memory may point at an object that no longer exists.',
  rpc_error: 'Sui did not answer the lookup. The memory is unchanged. Try again in a moment.',
  not_a_walrus_blob: 'That Sui object exists but is not a Walrus blob.',
  blob_not_certified: 'The Walrus blob exists but is not certified yet.',
  certified_blob: 'Certified Walrus blob on Sui.',
}

/** The reason in plain language. Never exposes a code or an internal detail. */
export function verificationReasonText(result: MemoryVerification): string {
  if (verificationTone(result) === 'verified') {
    const epoch = result.certified_epoch
    if (typeof epoch === 'number') {
      return `Certified Walrus blob on Sui in epoch ${epoch}.`
    }
    return REASON_TEXT.certified_blob
  }
  // A certified reason without a verified answer is contradictory. Do not echo
  // "certified" next to a badge that says it was not confirmed.
  if (result.reason === 'certified_blob') {
    return 'The check did not confirm this reference.'
  }
  const known = REASON_TEXT[result.reason]
  if (known) return known
  // A reason this build does not know is still named, so the reader and the
  // person debugging both see what the backend said instead of a generic line.
  return `The check did not confirm this reference (reason: ${result.reason}).`
}

function asOptionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Coerce an unknown response body into the strict shape above.
 *
 * Anything missing or malformed becomes the safe answer: not available, not
 * checked, not verified, with an unavailable reason. A malformed body can never
 * produce a verified badge.
 */
export function normalizeVerification(
  body: unknown,
  reference: string,
): MemoryVerification {
  const raw =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {}

  return {
    reference: typeof raw.reference === 'string' ? raw.reference : reference,
    advisory: raw.advisory === true,
    available: raw.available === true,
    checked: raw.checked === true,
    verified: raw.verified === true,
    reason: typeof raw.reason === 'string' ? raw.reason : 'verification_unavailable',
    object_id: typeof raw.object_id === 'string' ? raw.object_id : null,
    object_type: typeof raw.object_type === 'string' ? raw.object_type : null,
    object_version: asOptionalNumber(raw.object_version),
    owner_kind: typeof raw.owner_kind === 'string' ? raw.owner_kind : null,
    certified_epoch: asOptionalNumber(raw.certified_epoch),
    end_epoch: asOptionalNumber(raw.end_epoch),
    deletable: typeof raw.deletable === 'boolean' ? raw.deletable : null,
  }
}

/** The local answer when the request itself failed. Never marks verified. */
export function failedVerification(reference: string): MemoryVerification {
  return {
    reference,
    available: false,
    checked: false,
    verified: false,
    reason: 'request_failed',
  }
}
