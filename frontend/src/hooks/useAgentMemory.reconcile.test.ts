/**
 * useAgentMemory.reconcile.test.ts - the per-fact delete and edit requests, and
 * the strict reading of the result the backend sends.
 *
 * The page decides what to tell the user from `ok` and `partial`, so those two
 * fields are what these tests pin. A body that claims success while reporting a
 * partial rewrite must read as a failure, and the request must carry no user and
 * no namespace: the backend takes both from the authenticated session.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { deleteMock, patchMock } = vi.hoisted(() => ({
  deleteMock: vi.fn(),
  patchMock: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  default: { delete: deleteMock, patch: patchMock },
}))

import {
  deleteMemoryCategory,
  deleteMemoryFacts,
  normalizeReconcileResult,
  reconcileDetailFallback,
  replaceMemoryFact,
} from './useAgentMemory'

beforeEach(() => {
  deleteMock.mockReset()
  patchMock.mockReset()
})

describe('the per-fact requests', () => {
  it('deletes the selected sentences with no user or namespace in the request', async () => {
    deleteMock.mockResolvedValue({ data: { ok: true, removed: 2 } })

    await deleteMemoryFacts(['Kosi is based in Yaba.', 'Kosi lists a sink.'])

    expect(deleteMock).toHaveBeenCalledTimes(1)
    const [path, options] = deleteMock.mock.calls[0]
    expect(path).toBe('/ai/memory/facts')
    // Exactly the sentences and the timeout: the backend derives the user and
    // the namespace from the session, so the client cannot name either.
    expect(options).toEqual({
      data: { texts: ['Kosi is based in Yaba.', 'Kosi lists a sink.'] },
      timeout: 120000,
    })
  })

  it('deletes one category by its stable identifier', async () => {
    deleteMock.mockResolvedValue({ data: { ok: true } })

    await deleteMemoryCategory('jobs')

    const [path, options] = deleteMock.mock.calls[0]
    expect(path).toBe('/ai/memory/facts')
    expect(options).toEqual({ data: { category: 'jobs' }, timeout: 120000 })
  })

  it('sends an edit as the old text and the new text', async () => {
    patchMock.mockResolvedValue({ data: { ok: true } })

    await replaceMemoryFact('old sentence', 'new sentence')

    expect(patchMock).toHaveBeenCalledTimes(1)
    const [path, body, options] = patchMock.mock.calls[0]
    expect(path).toBe('/ai/memory/facts')
    expect(body).toEqual({ old_text: 'old sentence', new_text: 'new sentence' })
    expect(options).toEqual({ timeout: 120000 })
  })
})

describe('normalizeReconcileResult', () => {
  it('keeps a completed result a success and passes its counts through', () => {
    expect(
      normalizeReconcileResult({
        status: 'ok',
        ok: true,
        reason: 'ok',
        removed: 2,
        restored: 3,
        remaining: 3,
        partial: false,
        recovered: false,
        detail: 'Removed 2 memories.',
      }),
    ).toEqual({
      ok: true,
      reason: 'ok',
      removed: 2,
      restored: 3,
      remaining: 3,
      partial: false,
      recovered: false,
      detail: 'Removed 2 memories.',
    })
  })

  it('never reports a partial restore as a success', () => {
    const result = normalizeReconcileResult({
      status: 'partial',
      ok: false,
      reason: 'restore_incomplete',
      removed: 1,
      restored: 2,
      remaining: null,
      partial: true,
      recovered: false,
      detail: 'Your memory may be restored incompletely.',
    })

    expect(result.ok).toBe(false)
    expect(result.partial).toBe(true)
    expect(result.remaining).toBeNull()
    expect(result.detail).toContain('restored incompletely')
  })

  it('reads a contradictory body as partial, never as success', () => {
    // A proxy or a future backend could send ok true with partial true. The
    // safe reading is the one that does not claim the memory is intact.
    const result = normalizeReconcileResult({
      ok: true,
      partial: true,
      reason: 'ok',
      detail: 'Rewritten.',
    })

    expect(result.ok).toBe(false)
    expect(result.partial).toBe(true)
  })

  it('normalises an unknown reason and an empty body to the uncertain state', () => {
    const result = normalizeReconcileResult({ reason: 'teapot' })

    expect(result.ok).toBe(false)
    expect(result.reason).toBe('unavailable')
    expect(result.detail).toContain('cannot confirm')
    expect(result.remaining).toBeNull()
  })

  it('drops counts that are not usable numbers', () => {
    const result = normalizeReconcileResult({
      ok: true,
      reason: 'ok',
      removed: -3,
      restored: 'many',
      remaining: Number.NaN,
    })

    expect(result.removed).toBe(0)
    expect(result.restored).toBe(0)
    expect(result.remaining).toBeNull()
  })

  it('passes the recovered flag through', () => {
    const result = normalizeReconcileResult({
      ok: true,
      reason: 'nothing_to_remove',
      recovered: true,
    })

    expect(result.recovered).toBe(true)
    expect(result.ok).toBe(true)
  })
})

describe('reconcileDetailFallback', () => {
  it('says the memory may be restored incompletely for a partial result', () => {
    expect(reconcileDetailFallback('relayer_busy', true)).toContain(
      'restored incompletely',
    )
  })

  it('gives a no-op its own sentence rather than a failure', () => {
    expect(reconcileDetailFallback('nothing_to_remove')).toContain(
      'not in Walrus Memory any more',
    )
  })
})
