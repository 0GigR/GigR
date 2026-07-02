import { useEffect, useRef, useCallback } from 'react'
import { getToken } from '@/lib/api'
import api from '@/lib/api'
import type { components } from '@/types/api'

type Message = components['schemas']['MessageOut']

interface UseWebSocketMessagesOptions {
  jobIds: string[] | undefined
  onNewMessage: (message: Message) => void
  enabled?: boolean
}

// ─── Transport detection ──────────────────────────────────────────────────────
// Use polling when:
//   - VITE_USE_POLLING=true is set explicitly, OR
//   - VITE_WS_URL is empty AND VITE_API_URL points to a serverless host (Vercel)
//     because Vercel doesn't support persistent WebSocket connections.
function shouldUsePoll(): boolean {
  if (import.meta.env.VITE_USE_POLLING === 'true') return true
  const apiUrl = import.meta.env.VITE_API_URL || ''
  if (apiUrl.includes('vercel.app') || apiUrl.includes('vercel.com')) return true
  return false
}

const USE_POLLING = shouldUsePoll()
const POLL_INTERVAL_MS = 3000  // how often to poll when WebSocket is unavailable

// ─── WebSocket base URL (only used when USE_POLLING = false) ──────────────────
function getWsBase(): string {
  if (import.meta.env.VITE_WS_URL) return import.meta.env.VITE_WS_URL
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL
      .replace(/\/api\/v1\/?$/, '')
      .replace(/^https:/, 'wss:')
      .replace(/^http:/, 'ws:')
  }
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${window.location.host}`
}

const WS_BASE = getWsBase()

// ─── Main hook ────────────────────────────────────────────────────────────────
export function useWebSocketMessages({
  jobIds,
  onNewMessage,
  enabled = true,
}: UseWebSocketMessagesOptions) {
  const onNewMessageRef = useRef(onNewMessage)
  onNewMessageRef.current = onNewMessage

  // Use the appropriate transport
  usePollingMessages({ jobIds, onNewMessageRef, enabled: enabled && USE_POLLING })
  useWebSocketMessagesInternal({ jobIds, onNewMessageRef, enabled: enabled && !USE_POLLING })
}

// ─── HTTP Polling transport ───────────────────────────────────────────────────
function usePollingMessages({
  jobIds,
  onNewMessageRef,
  enabled,
}: {
  jobIds: string[] | undefined
  onNewMessageRef: React.MutableRefObject<(m: Message) => void>
  enabled: boolean
}) {
  // Track the latest message ID we've seen per job so we only emit NEW ones
  const lastSeenIdRef = useRef<Map<string, string>>(new Map())

  const poll = useCallback(async (jobId: string) => {
    try {
      const sinceId = lastSeenIdRef.current.get(jobId)
      const params: Record<string, string> = {}
      if (sinceId) params.since_id = sinceId

      const { data } = await api.get<Message[]>(`/messages/${jobId}`, { params })

      if (data && data.length > 0) {
        // Update the cursor to the latest message
        lastSeenIdRef.current.set(jobId, data[data.length - 1].id)

        // If we had a since_id, every returned message is genuinely new
        // If this is the initial load (no since_id), only store the cursor, don't fire
        if (sinceId) {
          data.forEach((msg) => onNewMessageRef.current(msg))
        }
      }
    } catch {
      // Silently ignore — user might have navigated away
    }
  }, [onNewMessageRef])

  useEffect(() => {
    if (!enabled || !jobIds || jobIds.length === 0) return

    // Initial seed — just set cursors, don't fire onNewMessage
    jobIds.forEach((id) => poll(id))

    const timer = setInterval(() => {
      jobIds.forEach((id) => poll(id))
    }, POLL_INTERVAL_MS)

    return () => clearInterval(timer)
  }, [enabled, jobIds, poll])
}

// ─── WebSocket transport ──────────────────────────────────────────────────────
function useWebSocketMessagesInternal({
  jobIds,
  onNewMessageRef,
  enabled,
}: {
  jobIds: string[] | undefined
  onNewMessageRef: React.MutableRefObject<(m: Message) => void>
  enabled: boolean
}) {
  const connectionsRef = useRef<Map<string, WebSocket>>(new Map())
  const reconnectTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())

  const connectToRoom = useCallback((jobId: string) => {
    const token = getToken()
    if (!token) return

    const existing = connectionsRef.current.get(jobId)
    if (existing) {
      existing.close()
      connectionsRef.current.delete(jobId)
    }

    const url = `${WS_BASE}/ws/messages/${jobId}?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(url)
    connectionsRef.current.set(jobId, ws)

    ws.onopen = () => console.log('[WS] Connected to messages room:', jobId)

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'new_message' && data.message) {
          onNewMessageRef.current(data.message)
        }
      } catch (err) {
        console.error('[WS] Failed to parse message:', err)
      }
    }

    ws.onclose = (event) => {
      console.log('[WS] Disconnected from room', jobId, ':', event.code, event.reason)
      connectionsRef.current.delete(jobId)
      if (event.code !== 4001 && enabled) {
        const timeout = setTimeout(() => connectToRoom(jobId), 3000)
        reconnectTimeoutsRef.current.set(jobId, timeout)
      }
    }

    ws.onerror = () => ws.close()
  }, [enabled, onNewMessageRef])

  useEffect(() => {
    if (!enabled || !jobIds || jobIds.length === 0) return

    const currentJobIds = new Set(jobIds)
    const connectedJobIds = new Set(connectionsRef.current.keys())

    for (const jobId of jobIds) {
      if (!connectedJobIds.has(jobId)) connectToRoom(jobId)
    }

    for (const connectedId of connectedJobIds) {
      if (!currentJobIds.has(connectedId)) {
        connectionsRef.current.get(connectedId)?.close()
        connectionsRef.current.delete(connectedId)
        const timeout = reconnectTimeoutsRef.current.get(connectedId)
        if (timeout) {
          clearTimeout(timeout)
          reconnectTimeoutsRef.current.delete(connectedId)
        }
      }
    }

    return () => {
      for (const [, timeout] of reconnectTimeoutsRef.current.entries()) clearTimeout(timeout)
      reconnectTimeoutsRef.current.clear()
      for (const [, ws] of connectionsRef.current.entries()) ws.close()
      connectionsRef.current.clear()
    }
  }, [jobIds, enabled, connectToRoom])
}