/**
 * useAgentMemory.ts - the memory map and the two calls that act on it.
 *
 * The backend has no GET /ai/memory endpoint. Memory is a sub-document of
 * ``users.ai_settings`` and is already returned by GET /ai/settings, which the
 * agent store uses for the same purpose. Reading it there keeps the existing
 * contract untouched.
 *
 * PATCH /ai/memory and DELETE /ai/memory/{key} do exist and return the whole
 * remaining memory map, which is what lets an entry disappear without a reload.
 */

import { useQuery } from '@tanstack/react-query'
import api from '@/lib/api'

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

/** Advisory, read-only Sui verification. Never used to change a memory. */
export async function verifyMemoryReference(reference: string): Promise<unknown> {
  const verificationResponse = await api.get('/ai/memory/verification', {
    params: { reference },
  })
  return verificationResponse.data
}
