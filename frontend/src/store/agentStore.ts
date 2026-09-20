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
  task_type: 'search' | 'find_service' | 'find_job' | 'negotiate' | 'post_job' | 'post_service' | 'navigate' | 'pay' | 'reply_message' | 'auto_reply' | 'apply_job' | 'generic' | 'pending'
  params: Record<string, unknown> | null
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting_reply'
  result: Record<string, unknown> | null
  created_at: string
  updated_at: string | null
  completed_at: string | null
  logs: AgentLog[]
}

export interface AISettings {
  /** 
   * Global Autonomy Level for the AI Agent:
   * 'off': No autonomous actions.
   * 'low': Auto-reply to incoming messages.
   * 'medium': Auto-reply + Auto-negotiate on behalf.
   * 'high': Medium + Auto-apply to matching jobs.
   * 'total': High + Proactively request services for user's needs.
   */
  autonomyLevel: 'off' | 'low' | 'medium' | 'high' | 'total'
  /** Whether the mic button is shown on all dashboard pages */
  voiceEnabled: boolean
  /** Speech recognition language code */
  voiceLanguage: string
}

// ─── Voice-call settings (server state: ai_settings.call + user.phone_number) ───

export interface CallTriggers {
  /** Call when the agent finds a matching service/provider */
  item_found: boolean
  /** Call when the agent finishes negotiating */
  negotiation_done: boolean
  /** Call when the agent posts a job for you */
  job_posted: boolean
  /** Call when a task fails */
  task_failed: boolean
}

export interface CallPrefs {
  enabled: boolean
  triggers: CallTriggers
  reminderDismissed: boolean
}

export interface VoiceSettings {
  phone_number: string | null
  call: CallPrefs
  /** True when the server has Twilio credentials + a public URL configured */
  twilio_configured: boolean
  /** The number calls come from (so users can save it as a contact) */
  from_number: string | null
  triggers_available: string[]
}

/** Partial patch accepted by PATCH /voice/settings */
export interface VoiceSettingsPatch {
  phone_number?: string
  enabled?: boolean
  triggers?: Partial<CallTriggers>
  reminderDismissed?: boolean
}

interface AgentState {
  // Task data
  tasks: AgentTask[]
  unreadCount: number
  isPanelOpen: boolean
  isSubmitting: boolean

  // AI engine info (fetched from backend)
  engineInfo: {
    groq_enabled: boolean
    groq_model: string | null
    agent_enabled: boolean
    nlp_engine: 'groq' | 'rule-based'
    /** The server's copy of this user's agent settings (authoritative). */
    ai_settings?: Record<string, unknown>
    autonomy_level?: string
  } | null

  // User AI settings (persisted in localStorage)
  aiSettings: AISettings

  // Voice-call settings fetched from the backend (null until fetched)
  voiceSettings: VoiceSettings | null

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

  /** Fetch the user's voice-call settings (phone + triggers) from the backend */
  fetchVoiceSettings: () => Promise<void>

  /** Patch voice-call settings (phone number and/or call preferences) */
  updateVoiceSettings: (patch: VoiceSettingsPatch) => Promise<VoiceSettings | null>

  /** Place a one-off test call to the user's saved number */
  placeTestCall: (message?: string) => Promise<{ status: string } | null>

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
  autonomyLevel: 'off',
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
      isSubmitting: false,
      engineInfo: null,
      aiSettings: DEFAULT_AI_SETTINGS,
      voiceSettings: null,
      _pollTimer: null,
      _agentWS: null,

      submitCommand: async (text: string) => {
        if (get().isSubmitting) return null
        set({ isSubmitting: true })
        try {
          // /ai/command just queues a task (parsing happens in the background loop),
          // but the DB round-trip can occasionally spike past the default 15s under
          // load, so give it more headroom.
          const { data } = await api.post<AgentTask>('/ai/command', { text }, { timeout: 30000 })
          set((s) => ({
            tasks: [data, ...s.tasks],
            unreadCount: s.unreadCount + 1,
          }))
          return data
        } catch (err: any) {
          console.error('[agentStore] submitCommand error:', err)
          // A client-side timeout does NOT mean the server failed — it usually
          // created the task anyway. Reconcile from the server so it still appears.
          if (err?.code === 'ECONNABORTED') {
            setTimeout(() => { get().fetchTasks() }, 1500)
          }
          return null
        } finally {
          set({ isSubmitting: false })
        }
      },

      fetchTasks: async () => {
        try {
          const { data } = await api.get<AgentTask[]>('/ai/tasks', { params: { limit: 50 } })
          // Never trust the response shape — a non-array here would crash every
          // render of the agent panel (and this polls on EVERY dashboard page).
          const list = Array.isArray(data) ? data : []
          const prev = get().tasks

          // Count newly completed/failed tasks as unread
          const newUnread = list.filter((t) => {
            const existing = prev.find((p) => p.id === t.id)
            const justFinished = existing &&
              existing.status !== t.status &&
              (t.status === 'completed' || t.status === 'failed')
            return justFinished
          }).length

          set((s) => ({
            tasks: list,
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

          // Hydrate from the server, which is authoritative. The store used to
          // persist settings to localStorage and push them up, but never read
          // them back — so a new browser showed "off" while the backend was
          // enforcing something completely different.
          const server = (data?.ai_settings ?? null) as Record<string, unknown> | null
          if (server && typeof server === 'object') {
            const merged: Partial<AISettings> = {}
            if (typeof server.autonomyLevel === 'string') {
              merged.autonomyLevel = server.autonomyLevel as AISettings['autonomyLevel']
            }
            if (typeof server.voiceEnabled === 'boolean') {
              merged.voiceEnabled = server.voiceEnabled
            }
            if (typeof server.voiceLanguage === 'string') {
              merged.voiceLanguage = server.voiceLanguage
            }
            // Only adopt keys we recognise, so ai_settings.call / .memory don't
            // leak into the persisted client settings.
            if (Object.keys(merged).length > 0) {
              set((s) => ({ aiSettings: { ...s.aiSettings, ...merged } }))
            }
          }
        } catch {
          // Backend might not have AI settings endpoint yet
        }
      },

      updateAISetting: (key, value) => {
        set((s) => {
          const newSettings = { ...s.aiSettings, [key]: value }
          // Send ONLY the changed key. The backend merges ai_settings, so this
          // can never clobber sibling keys such as `call` or `memory` even if
          // the merge is ever removed.
          api.patch('/users/me', { ai_settings: { [key]: value } }).catch(err => {
            console.error('[agentStore] Failed to sync AI settings with backend:', err)
          })
          return { aiSettings: newSettings }
        })
      },

      fetchVoiceSettings: async () => {
        try {
          const { data } = await api.get<VoiceSettings>('/voice/settings')
          set({ voiceSettings: data })
        } catch (err) {
          // User might not be logged in, or endpoint unavailable — fail quietly
        }
      },

      updateVoiceSettings: async (patch) => {
        try {
          const { data } = await api.patch<VoiceSettings>('/voice/settings', patch)
          set({ voiceSettings: data })
          return data
        } catch (err) {
          console.error('[agentStore] updateVoiceSettings error:', err)
          return null
        }
      },

      placeTestCall: async (message?: string) => {
        try {
          const { data } = await api.post<{ status: string }>('/voice/call', { message })
          return data
        } catch (err: any) {
          console.error('[agentStore] placeTestCall error:', err)
          throw err
        }
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
        if (get().isSubmitting) return
        set({ isSubmitting: true })
        try {
          await api.post(`/ai/tasks/${taskId}/respond`, { action })
          await get().fetchTasks()
        } catch (err) {
          console.error('[agentStore] respondToDialog error:', err)
        } finally {
          set({ isSubmitting: false })
        }
      },

      get pendingDialogTaskIds() {
        const tasks = Array.isArray(get().tasks) ? get().tasks : []
        return new Set(
          tasks
            .filter((task) => {
              if (!task.logs) return false
              // Search backwards for the most recent log with an action_payload
              for (let i = task.logs.length - 1; i >= 0; i--) {
                if (task.logs[i].data?.action_payload) return true
              }
              return false
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
