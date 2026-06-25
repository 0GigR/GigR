import { useEffect, useRef, useCallback } from 'react'
import { getToken } from '@/lib/api'
import type { components } from '@/types/api'

type Message = components['schemas']['MessageOut']

interface UseWebSocketMessagesOptions {
  jobIds: string[] | undefined
  onNewMessage: (message: Message) => void
  enabled?: boolean
}

const WS_BASE = import.meta.env.VITE_WS_URL || 'ws://localhost:8000'

export function useWebSocketMessages({
  jobIds,
  onNewMessage,
  enabled = true,
}: UseWebSocketMessagesOptions) {
  // Map of jobId -> WebSocket connection
  const connectionsRef = useRef<Map<string, WebSocket>>(new Map())
  const reconnectTimeoutsRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map())
  const onNewMessageRef = useRef(onNewMessage)

  // Keep callback ref up to date
  onNewMessageRef.current = onNewMessage

  const connectToRoom = useCallback((jobId: string) => {
    const token = getToken()
    if (!token) return

    // Close any existing connection for this job
    const existing = connectionsRef.current.get(jobId)
    if (existing) {
      existing.close()
      connectionsRef.current.delete(jobId)
    }

    const url = `${WS_BASE}/ws/messages/${jobId}?token=${encodeURIComponent(token)}`
    const ws = new WebSocket(url)
    connectionsRef.current.set(jobId, ws)

    ws.onopen = () => {
      console.log('[WS] Connected to messages room:', jobId)
    }

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
      // Auto-reconnect after 3 seconds (unless intentionally closed)
      if (event.code !== 4001 && enabled) {
        const timeout = setTimeout(() => {
          connectToRoom(jobId)
        }, 3000)
        reconnectTimeoutsRef.current.set(jobId, timeout)
      }
    }

    ws.onerror = () => {
      ws.close()
    }
  }, [enabled])

  // Connect to all rooms when jobIds change
  useEffect(() => {
    if (!enabled || !jobIds || jobIds.length === 0) return

    const currentJobIds = new Set(jobIds)
    const connectedJobIds = new Set(connectionsRef.current.keys())

    // Connect to new rooms
    for (const jobId of jobIds) {
      if (!connectedJobIds.has(jobId)) {
        connectToRoom(jobId)
      }
    }

    // Disconnect from rooms no longer in the list
    for (const connectedId of connectedJobIds) {
      if (!currentJobIds.has(connectedId)) {
        const ws = connectionsRef.current.get(connectedId)
        if (ws) {
          ws.close()
          connectionsRef.current.delete(connectedId)
        }
        const timeout = reconnectTimeoutsRef.current.get(connectedId)
        if (timeout) {
          clearTimeout(timeout)
          reconnectTimeoutsRef.current.delete(connectedId)
        }
      }
    }

    return () => {
      // Cleanup all connections on unmount
      for (const [, timeout] of reconnectTimeoutsRef.current.entries()) {
        clearTimeout(timeout)
      }
      reconnectTimeoutsRef.current.clear()
      for (const [, ws] of connectionsRef.current.entries()) {
        ws.close()
      }
      connectionsRef.current.clear()
    }
  }, [jobIds, enabled, connectToRoom])
}