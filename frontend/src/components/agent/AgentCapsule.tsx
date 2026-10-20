/**
 * AgentCapsule.tsx — Dynamic Island-style agent status pill.
 *
 * Floats at the top-center of the screen and morphs between three states:
 *   idle       — collapsed pill, single dot, [AGENT IDLE]
 *   thinking   — expanded to show the last reasoning log
 *   dialog     — expanded to show action chips from action_payload.options
 *
 * Uses pure CSS transitions (no Framer Motion) to avoid bundle pressure.
 * Gated by the commandPalette feature flag.
 */

import { useMemo } from 'react'
import { useAgentStore, type AgentTask, type AgentLog } from '@/store/agentStore'
import { isFeatureEnabled } from '@/lib/featureFlags'
import { cn } from '@/lib/utils'

type CapsuleMode = 'idle' | 'thinking' | 'dialog'

function resolveMode(task: AgentTask | null): CapsuleMode {
  if (!task) return 'idle'
  const logs = task.logs ?? []
  const lastLog: AgentLog | undefined = logs[logs.length - 1]
  if (!lastLog) return 'thinking'
  const payload = (lastLog.data as Record<string, unknown> | null | undefined)?.action_payload as
    | { options?: Array<{ label: string; value: string }> }
    | undefined
  if (payload?.options && Array.isArray(payload.options) && payload.options.length > 0) {
    return 'dialog'
  }
  return 'thinking'
}

function useActiveTask(): AgentTask | null {
  const tasks = useAgentStore((s) => s.tasks)
  return useMemo(() => {
    const running = tasks.filter((t) => t.status === 'running' || t.status === 'queued')
    if (running.length === 0) return null
    return running[running.length - 1]
  }, [tasks])
}

export default function AgentCapsule() {
  const allTasks = useAgentStore((s) => s.tasks)
  const activeTask = useActiveTask()
  const submitCommand = useAgentStore((s) => s.submitCommand)

  if (!isFeatureEnabled('commandPalette')) return null
  if (allTasks.length === 0) return null

  const mode = resolveMode(activeTask)
  const logs = activeTask?.logs ?? []
  const lastLog: AgentLog | undefined = logs[logs.length - 1]
  const thinkMessage = lastLog?.message ? lastLog.message.slice(0, 80) : null
  const dialogPayload = (lastLog?.data as Record<string, unknown> | null | undefined)
    ?.action_payload as { options?: Array<{ label: string; value: string }> } | undefined
  const options: Array<{ label: string; value: string }> =
    mode === 'dialog' ? (dialogPayload?.options ?? []) : []

  const isExpanded = mode === 'thinking' || mode === 'dialog'

  return (
    <div
      aria-live="polite"
      aria-label="Agent status capsule"
      className={cn(
        'fixed top-4 left-1/2 -translate-x-1/2 z-50',
        'flex flex-col items-center gap-2',
        'pointer-events-none',
      )}
    >
      <div
        className={cn(
          'bg-gray-900 dark:bg-gray-950 border border-gray-700/60',
          'shadow-xl shadow-black/40 backdrop-blur-sm',
          'rounded-full transition-all duration-300 ease-in-out',
          'pointer-events-auto overflow-hidden',
          isExpanded
            ? 'px-4 py-2.5 rounded-2xl min-w-[220px] max-w-[340px]'
            : 'px-3 py-1.5',
        )}
      >
        {/* Idle state */}
        {mode === 'idle' && (
          <div className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-gray-500" />
            <span className="text-[10px] text-gray-400 font-medium tracking-wide whitespace-nowrap">
              Standby
            </span>
          </div>
        )}

        {/* Thinking state */}
        {mode === 'thinking' && (
          <div className="flex items-center gap-2 w-full">
            <span className="flex gap-0.5 shrink-0">
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  className="w-1 h-1 rounded-full bg-white animate-bounce"
                  style={{ animationDelay: `${i * 120}ms` }}
                />
              ))}
            </span>
            <span className="text-xs text-gray-200 truncate leading-snug">
              {thinkMessage ?? 'Processing...'}
            </span>
          </div>
        )}

        {/* Dialog state — action chips */}
        {mode === 'dialog' && options.length > 0 && (
          <div className="flex flex-col gap-1.5 w-full">
            <span className="text-[10px] text-gray-300 font-medium tracking-wide">Action Needed</span>
            <div className="flex flex-wrap gap-1.5">
              {options.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => submitCommand(opt.value)}
                  className="text-xs px-2.5 py-1 rounded-full bg-white hover:bg-gray-200 text-black font-medium transition-colors"
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
