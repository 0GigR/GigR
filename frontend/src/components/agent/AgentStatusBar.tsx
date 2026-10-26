/**
 * AgentStatusBar.tsx — Header live status indicator for the AI Agent OS.
 *
 * Displays the real-time operational state of autonomous tasks (queued, running,
 * waiting for user reply) with quick toggle access to the activity panel.
 */

import React from 'react'
import { Sparkles, Loader2 } from 'lucide-react'
import { useAgentStore, type AgentTask } from '@/store/agentStore'

export default function AgentStatusBar(): React.ReactElement | null {
  const { tasks, isPanelOpen, openPanel } = useAgentStore()

  // Find the most recent active or actionable task
  const activeTask = (tasks || []).find(
    (taskItem: AgentTask) =>
      taskItem.status === 'running' ||
      taskItem.status === 'queued' ||
      taskItem.status === 'waiting_reply'
  )

  if (!activeTask || isPanelOpen) {
    return null
  }

  const isAwaitingReply = activeTask.status === 'waiting_reply'
  const isRunning = activeTask.status === 'running'

  const statusLabel = isAwaitingReply
    ? '[PENDING]'
    : isRunning
      ? '[RUNNING]'
      : '[QUEUED]'

  const statusColorClass = isAwaitingReply
    ? 'bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/30'
    : isRunning
      ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/30'
      : 'bg-blue-500/10 text-blue-700 dark:text-blue-300 border-blue-500/30'

  const indicatorDotClass = isAwaitingReply
    ? 'bg-violet-500 animate-pulse'
    : isRunning
      ? 'bg-amber-500 animate-pulse'
      : 'bg-blue-500'

  return (
    <button
      type="button"
      onClick={openPanel}
      className={`hidden sm:inline-flex items-center gap-2 px-3 py-1 rounded-full border text-xs font-medium transition-all shadow-sm ${statusColorClass}`}
      title="View AI agent activity details"
    >
      <span className={`w-2 h-2 rounded-full ${indicatorDotClass}`} />
      <span className="font-mono text-[10px] font-bold">{statusLabel}</span>
      <span className="max-w-[140px] truncate text-gray-700 dark:text-foreground">
        {activeTask.command_text}
      </span>
      {isRunning ? (
        <Loader2 className="w-3 h-3 animate-spin shrink-0 text-amber-500" />
      ) : (
        <Sparkles className="w-3 h-3 shrink-0 text-violet-500" />
      )}
    </button>
  )
}
