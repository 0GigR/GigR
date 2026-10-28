/**
 * useAgentMemory.test.ts - the namespace wipe's request and response handling.
 *
 * The page decides what to tell the user from `ok` and `reason`, so those two
 * fields are what this test pins. A wipe that failed must never be reported as
 * a success, and the request must carry no user or namespace: the backend takes
 * both from the authenticated session.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

const { deleteMock } = vi.hoisted(() => ({ deleteMock: vi.fn() }))

vi.mock('@/lib/api', () => ({
  default: { delete: deleteMock },
}))

import { forgetAgentMemoryNamespace } from './useAgentMemory'

beforeEach(() => {
  deleteMock.mockReset()
})

describe('forgetAgentMemoryNamespace', () => {
  it('asks the namespace endpoint and nothing more specific', async () => {
    deleteMock.mockResolvedValue({ data: { ok: true, deleted: 4, reason: 'ok' } })

    await forgetAgentMemoryNamespace()

    expect(deleteMock).toHaveBeenCalledTimes(1)
    const [path, options] = deleteMock.mock.calls[0]
    expect(path).toBe('/ai/memory')
    // No user id, no namespace: the backend derives both from the session.
    expect(options).toEqual({ timeout: 20000 })
  })

  it('reports the row count the relayer returned', async () => {
    deleteMock.mockResolvedValue({ data: { ok: true, deleted: 12, reason: 'ok' } })

    await expect(forgetAgentMemoryNamespace()).resolves.toEqual({
      ok: true,
      deleted: 12,
      reason: 'ok',
    })
  })

  it('keeps a failure a failure and passes its reason through', async () => {
    deleteMock.mockResolvedValue({
      data: { ok: false, deleted: null, reason: 'relayer_busy' },
    })

    await expect(forgetAgentMemoryNamespace()).resolves.toEqual({
      ok: false,
      deleted: null,
      reason: 'relayer_busy',
    })
  })

  it('does not treat a missing ok field as success', async () => {
    // A proxy or an older backend answers without the field. Anything that is
    // not an explicit true must read as "not deleted", never as a quiet success.
    deleteMock.mockResolvedValue({ data: { deleted: 3 } })

    await expect(forgetAgentMemoryNamespace()).resolves.toEqual({
      ok: false,
      deleted: 3,
      reason: 'relayer_unavailable',
    })
  })

  it('normalises an unknown reason to the unavailable state', async () => {
    deleteMock.mockResolvedValue({ data: { ok: false, reason: 'teapot' } })

    await expect(forgetAgentMemoryNamespace()).resolves.toEqual({
      ok: false,
      deleted: null,
      reason: 'relayer_unavailable',
    })
  })
})
