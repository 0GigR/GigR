/**
 * providerPicker.ts - the provider list the Agent access picker shows, and the
 * rules that move through it.
 *
 * An external agent has no Gigr account and no job of its own, so the thing it
 * chooses is a provider. These functions are pure so the matching, the keyboard
 * wrap-around and the label wording can be tested without a DOM: the combobox is
 * a thin renderer over them.
 *
 * A row without a usable provider id or job id is dropped rather than rendered.
 * The job id is the one the quote and the purchase are asked for, so a row that
 * cannot name a job is not an option: offering it would promise a brief that
 * cannot be bought.
 */

import { isJobId } from './x402Challenge'

/** One provider the brief can be bought about, as the endpoint sent it. */
export interface BriefProvider {
  providerId: string
  name: string
  category: string | null
  ratingCount: number
  ratingAverage: number | null
  completedJobs: number
  /** That provider's most recent completed job: what the brief is priced for. */
  jobId: string
  jobTitle: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

function asCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.trunc(value))
    : 0
}

function asAverage(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Read the provider list out of the endpoint's body.
 *
 * A body that is not `{providers: [...]}` reads as an empty list: the picker then
 * says no provider is available, which is honest, instead of failing the page.
 * Individual rows are validated one by one, so one bad row does not hide the
 * others.
 */
export function parseBriefProviders(body: unknown): BriefProvider[] {
  const record = asRecord(body)
  const rows = Array.isArray(record?.providers) ? record.providers : []
  const providers: BriefProvider[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const entry = asRecord(row)
    if (!entry) continue
    const providerId = asText(entry.provider_id)
    const jobId = asText(entry.job_id)
    const name = asText(entry.name)
    if (!providerId || !jobId || !name) continue
    if (!isJobId(jobId) || seen.has(providerId)) continue
    seen.add(providerId)
    providers.push({
      providerId,
      name,
      category: asText(entry.category),
      ratingCount: asCount(entry.rating_count),
      ratingAverage: asAverage(entry.rating_average),
      completedJobs: asCount(entry.completed_jobs),
      jobId,
      jobTitle: asText(entry.job_title) ?? 'Untitled job',
    })
  }

  return providers
}

/**
 * The providers whose name or category contains the query.
 *
 * Case-insensitive and whitespace-tolerant, because the query comes from a field
 * someone is typing in. An empty query is every provider, not none: the list is
 * the picker's content, and hiding it until a key is pressed would look broken.
 */
export function filterProviders(
  providers: BriefProvider[],
  query: string,
): BriefProvider[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return providers
  return providers.filter((provider) => {
    const haystack = `${provider.name} ${provider.category ?? ''}`.toLowerCase()
    return haystack.includes(needle)
  })
}

/**
 * Where the highlight lands after moving `delta` rows, wrapping at both ends.
 *
 * Returns -1 for an empty list so the caller has no index to aim at. Starting
 * from no highlight (-1), moving down enters at the top and moving up enters at
 * the bottom, which is what a reader expects from a list that has no selection.
 */
export function moveActiveIndex(
  index: number,
  delta: number,
  length: number,
): number {
  if (length <= 0) return -1
  if (index < 0 || index >= length) {
    return delta > 0 ? 0 : length - 1
  }
  return (index + delta + length) % length
}

/** The rating as a sentence fragment; a provider with no ratings says so. */
export function providerRatingLabel(provider: BriefProvider): string {
  if (provider.ratingAverage === null || provider.ratingCount === 0) {
    return 'No ratings yet'
  }
  const average = provider.ratingAverage.toFixed(2)
  const noun = provider.ratingCount === 1 ? 'rating' : 'ratings'
  return `${average} from ${provider.ratingCount} ${noun}`
}

/** The provider's category, or a plain word when the marketplace has none. */
export function providerCategoryLabel(provider: BriefProvider): string {
  return provider.category ?? 'No category recorded'
}

/** The line under the name: the category, then the rating. */
export function providerMetaLabel(provider: BriefProvider): string {
  return `${providerCategoryLabel(provider)} - ${providerRatingLabel(provider)}`
}
