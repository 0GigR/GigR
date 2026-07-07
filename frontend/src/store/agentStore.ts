/**
 * agentStore.ts — The single consolidated frontend AI file.
 *
 * Everything AI-agent related on the frontend lives here:
 *   - Zustand store state (tasks, logs, unreadCount, panel visibility)
 *   - API calls (submit command, fetch tasks, fetch logs, cancel task)
 *   - Polling management (startPolling / stopPolling)
 *   - AI settings persistence (stored in localStorage until a user-settings API is added)
 *
 * The AgentBell and AgentActivityPanel components consume this store.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import api, { getToken } from '@/lib/api'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface AgentLog {
  id: string
  task_id: string
  level: 'info' | 'action' | 'success' | 'error' | 'warning'
  message: string
  data?: Record<string, unknown> | null
  created_at: string
}

export interface AgentTask {
  id: string
  user_id: string
  command_text: string
  task_type: 'search' | 'find_service' | 'find_job' | 'negotiate' | 'post_job' | 'post_service' | 'navigate' | 'pay' | 'reply_message' | 'generic' | 'pending'
  params: Record<string, unknown> | null
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting_reply'
  result: Record<string, unknown> | null
  created_at: string
  updated_at: string | null
  completed_at: string | null
  logs: AgentLog[]
}

export interface AISettings {
  /** Allow the agent to send negotiation messages to providers on the user's behalf */
  aiNegotiateEnabled: boolean
  /** Allow the agent to automatically reply to incoming messages */
  aiAutoReplyEnabled: boolean
  /** Whether the mic button is shown on all dashboard pages */
  voiceEnabled: boolean
  /** Speech recognition language code */
  voiceLanguage: string
}

interface AgentState {
  // Task data
  tasks: AgentTask[]
  unreadCount: number
  isPanelOpen: boolean

  // AI engine info (fetched from backend)
  engineInfo: {
    groq_enabled: boolean
    groq_model: string | null
    agent_enabled: boolean
    nlp_engine: 'groq' | 'rule-based'
  } | null

  // User AI settings (persisted in localStorage)
  aiSettings: AISettings

  // Polling control
  _pollTimer: ReturnType<typeof setInterval> | null

  // ── Actions ────────────────────────────────────────────────────────────────

  /** Submit a voice or text command to the agent */
  submitCommand: (text: string) => Promise<AgentTask | null>

  /** Fetch all tasks for the current user */
  fetchTasks: () => Promise<void>

  /** Cancel a queued or running task */
  cancelTask: (taskId: string) => Promise<void>

  /** Open / close the activity panel */
  openPanel: () => void
  closePanel: () => void
  togglePanel: () => void

  /** Mark all tasks as read (clears badge) */
  markAllRead: () => void

  /** Fetch AI engine info from backend */
  fetchEngineInfo: () => Promise<void>

  /** Update a single AI setting */
  updateAISetting: <K extends keyof AISettings>(key: K, value: AISettings[K]) => void

  /** Clear all task history for the user */
  clearHistory: () => Promise<void>

  /** Respond to an interactive agent dialog */
  respondToDialog: (taskId: string, action: string) => Promise<void>

  /** Tasks that have an unresolved action_payload in their last log */
  pendingDialogTaskIds: Set<string>

  /** Start the polling loop */
  startPolling: () => void

  /** Stop the polling loop */
  stopPolling: () => void

  /** Open the agent push WS so task updates arrive instantly */
  connectAgentWS: (userId: string) => void

  /** Close the agent push WS */
  disconnectAgentWS: () => void

  _agentWS: WebSocket | null
}

// ─── Default settings ─────────────────────────────────────────────────────────

const DEFAULT_AI_SETTINGS: AISettings = {
  aiNegotiateEnabled: false,  // must be explicitly turned on by user
  aiAutoReplyEnabled: false,  // must be explicitly turned on by user
  voiceEnabled: true,
  voiceLanguage: 'en-US',
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useAgentStore = create<AgentState>()(
  persist(
    (set, get) => ({
      tasks: [],
      unreadCount: 0,
      isPanelOpen: false,
      engineInfo: null,
      aiSettings: DEFAULT_AI_SETTINGS,
      _pollTimer: null,
      _agentWS: null,

      submitCommand: async (text: string) => {
        try {
          const { data } = await api.post<AgentTask>('/ai/command', { text })
          set((s) => ({
            tasks: [data, ...s.tasks],
            unreadCount: s.unreadCount + 1,
          }))
          return data
        } catch (err: any) {
          console.error('[agentStore] submitCommand error:', err)
          return null
        }
      },

      fetchTasks: async () => {
        try {
          const { data } = await api.get<AgentTask[]>('/ai/tasks', { params: { limit: 50 } })
          const prev = get().tasks

          // Count newly completed/failed tasks as unread
          const newUnread = data.filter((t) => {
            const existing = prev.find((p) => p.id === t.id)
            const justFinished = existing &&
              existing.status !== t.status &&
              (t.status === 'completed' || t.status === 'failed')
            return justFinished
          }).length

          set((s) => ({
            tasks: data,
            unreadCount: s.isPanelOpen ? 0 : s.unreadCount + newUnread,
          }))
        } catch (err) {
          // Silently fail — user might not be logged in
        }
      },

      cancelTask: async (taskId: string) => {
        try {
          await api.delete(`/ai/tasks/${taskId}`)
          // Optimistic update
          set((s) => ({
            tasks: s.tasks.map((t) =>
              t.id === taskId ? { ...t, status: 'cancelled' as const } : t
            ),
          }))
        } catch (err: any) {
          console.error('[agentStore] cancelTask error:', err)
        }
      },

      openPanel: () => {
        set({ isPanelOpen: true, unreadCount: 0 })
        // Refresh tasks when opening panel
        get().fetchTasks()
      },

      closePanel: () => set({ isPanelOpen: false }),

      togglePanel: () => {
        const { isPanelOpen, openPanel, closePanel } = get()
        if (isPanelOpen) closePanel()
        else openPanel()
      },

      markAllRead: () => set({ unreadCount: 0 }),

      fetchEngineInfo: async () => {
        try {
          const { data } = await api.get('/ai/settings')
          set({ engineInfo: data })
        } catch {
          // Backend might not have AI settings endpoint yet
        }
      },

      updateAISetting: (key, value) => {
        set((s) => {
          const newSettings = { ...s.aiSettings, [key]: value };
          // Sync with backend async
          api.patch('/users/me', { ai_settings: newSettings }).catch(err => {
            console.error('[agentStore] Failed to sync AI settings with backend:', err)
          })
          return { aiSettings: newSettings }
        })
      },

      clearHistory: async () => {
        try {
          await api.delete('/ai/tasks')
          set({ tasks: [], unreadCount: 0 })
        } catch (err) {
          console.error('[agentStore] clearHistory error:', err)
        }
      },

      respondToDialog: async (taskId: string, action: string) => {
        try {
          await api.post(`/ai/tasks/${taskId}/respond`, { action })
          // Immediately refresh tasks so the dialog disappears
          await get().fetchTasks()
        } catch (err) {
          console.error('[agentStore] respondToDialog error:', err)
        }
      },

      get pendingDialogTaskIds() {
        return new Set(
          get().tasks
            .filter((task) => {
              const lastLog = task.logs?.[task.logs.length - 1]
              return !!lastLog?.data?.action_payload
            })
            .map((t) => t.id)
        )
      },

      connectAgentWS: (userId: string) => {
        const existing = get()._agentWS
        if (existing && existing.readyState <= WebSocket.OPEN) return

        const token = getToken()
        if (!token) return

        const base = import.meta.env.VITE_API_URL
          ? import.meta.env.VITE_API_URL
              .replace(/\/api\/v1\/?$/, '')
              .replace(/^https:/, 'wss:')
              .replace(/^http:/, 'ws:')
          : `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}`

        const ws = new WebSocket(`${base}/ws/agent/${userId}?token=${encodeURIComponent(token)}`)
        ws.onmessage = () => {
          // Any push from the server means a task changed — refetch immediately
          get().fetchTasks()
        }
        ws.onclose = () => {
          set({ _agentWS: null })
          // Reconnect after 5 s
          setTimeout(() => {
            if (get()._agentWS === null) get().connectAgentWS(userId)
          }, 5000)
        }
        ws.onerror = () => ws.close()
        set({ _agentWS: ws })
      },

      disconnectAgentWS: () => {
        const ws = get()._agentWS
        if (ws) { ws.onclose = null; ws.close() }
        set({ _agentWS: null })
      },

      startPolling: () => {
        const { _pollTimer, fetchTasks } = get()
        if (_pollTimer) return // already polling

        fetchTasks() // immediate first fetch

        const pollMs = parseInt(import.meta.env.VITE_AI_AGENT_POLL_MS || '10000', 10)
        const timer = setInterval(() => {
          fetchTasks()
        }, pollMs)

        set({ _pollTimer: timer })
      },

      stopPolling: () => {
        const { _pollTimer } = get()
        if (_pollTimer) {
          clearInterval(_pollTimer)
          set({ _pollTimer: null })
        }
      },
    }),
    {
      name: 'gigr-agent-settings',
      // Only persist user settings and unread count — not tasks or WS state
      partialize: (s) => ({
        aiSettings: s.aiSettings,
        unreadCount: s.unreadCount,
      }),
    }
  )
)
