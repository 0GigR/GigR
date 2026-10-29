/**
 * useAgentBrief.ts - the two reads the Agent payments panel needs.
 *
 * `requestAgentBriefQuote` asks the paid-brief endpoint for its terms and stops
 * there. It never sends an X-PAYMENT header, so it cannot buy anything: the
 * 402 challenge is the answer this panel is built around. A 402 or 404 is a
 * normal answer, not an exception, which is why the request accepts every
 * status and classifies the body instead of letting axios throw.
 *
 * `fetchAgentBriefJobs` lists the caller's own jobs so a job id can be picked,
 * and is best effort: pasting an id must keep working when the list cannot be
 * read, so a failed side is skipped rather than failing the picker.
 */

import api from '@/lib/api'
import { classifyBriefResponse, type BriefOutcome } from '@/lib/x402Challenge'

/** A brief recall does a database read; the shared 15s timeout is close. */
export const BRIEF_REQUEST_TIMEOUT_MS = 20000

export interface AgentBriefJob {
  id: string
  title: string
  status: string
}

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ECONNABORTED'
  )
}

/**
 * Ask for a brief's terms. Returns the classified answer, never throws.
 *
 * With no payment attached the endpoint answers 402; with the feature off it
 * answers 404. Both are answered here as outcomes so the panel can say which
 * one happened.
 */
export async function requestAgentBriefQuote(jobId: string): Promise<BriefOutcome> {
  try {
    const response = await api.get('/agent/brief', {
      params: { job_id: jobId },
      timeout: BRIEF_REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    })
    return classifyBriefResponse(response.status, response.data)
  } catch (error) {
    if (isTimeout(error)) {
      return {
        kind: 'error',
        detail: 'The agent brief endpoint took too long to answer. Nothing was charged.',
      }
    }
    return {
      kind: 'error',
      detail: 'We could not reach the agent brief endpoint. Check your connection and try again.',
    }
  }
}

/**
 * The caller's jobs, clients and providers together, deduplicated by id.
 *
 * The two lists can overlap (a job where the caller is both sides), so the
 * first row for an id wins. Rows without a usable id or title are skipped
 * rather than rendered as blanks.
 */
export async function fetchAgentBriefJobs(): Promise<AgentBriefJob[]> {
  const settled = await Promise.allSettled([
    api.get('/jobs/', { params: { my: 'client', limit: 20 }, timeout: 15000 }),
    api.get('/jobs/', { params: { my: 'provider', limit: 20 }, timeout: 15000 }),
  ])

  const byId = new Map<string, AgentBriefJob>()
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    const rows = Array.isArray(result.value.data) ? result.value.data : []
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      const record = row as Record<string, unknown>
      const id = typeof record.id === 'string' ? record.id : null
      if (!id || byId.has(id)) continue
      byId.set(id, {
        id,
        title: typeof record.title === 'string' && record.title.trim() ? record.title : 'Untitled job',
        status: typeof record.status === 'string' ? record.status : 'unknown',
      })
    }
  }
  return Array.from(byId.values())
}
