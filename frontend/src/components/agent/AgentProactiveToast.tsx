/**
 * AgentProactiveToast.tsx — Proactive notification card for autonomous agent discoveries.
 *
 * Surfaces opportunities found during background hunting or tasks awaiting
 * confirmation without interrupting the user's current workflow.
 */

import React, { useState, useEffect } from 'react'
import { Sparkles, X, ArrowRight } from 'lucide-react'
import { useAgentStore, type AgentTask } from '@/store/agentStore'
import { isFeatureEnabled } from '@/lib/featureFlags'

export default function AgentProactiveToast(): React.ReactElement | null {
  const isProactiveEnabled = isFeatureEnabled('proactiveSurface')
  const { tasks, isPanelOpen, openPanel } = useAgentStore()
  const [dismissedTaskIds, setDismissedTaskIds] = useState<Set<string>>(() => new Set())

  // Look for the newest task needing attention
  const attentionTask = (tasks || []).find((taskItem: AgentTask) => {
    if (dismissedTaskIds.has(taskItem.id)) return false
    return (
      taskItem.status === 'waiting_reply' ||
      (taskItem.task_type === 'proactive_hunt' && taskItem.status === 'completed')
    )
  })

  // Close toast automatically when the main activity panel is opened
  useEffect(() => {
    if (isPanelOpen && attentionTask) {
      setDismissedTaskIds((prevSet) => new Set(prevSet).add(attentionTask.id))
    }
  }, [isPanelOpen, attentionTask])

  if (!isProactiveEnabled || !attentionTask || isPanelOpen) {
    return null
  }

  const dismissToast = () => {
    setDismissedTaskIds((prevSet) => new Set(prevSet).add(attentionTask.id))
  }

  const reviewTask = () => {
    dismissToast()
    openPanel()
  }

  const isAwaitingReply = attentionTask.status === 'waiting_reply'
  const toastHeadline = isAwaitingReply
    ? 'Action Requested by Agent'
    : 'New Autonomous Discovery'

  const toastSummary =
    attentionTask.logs && attentionTask.logs.length > 0
      ? attentionTask.logs[attentionTask.logs.length - 1].message
      : attentionTask.command_text

  return (
    <aside
      aria-label="Proactive Agent Notification"
      className="fixed bottom-24 left-4 z-40 max-w-sm w-[calc(100vw-2rem)] rounded-2xl bg-gray-950/95 dark:bg-background/95 border border-violet-500/30 p-3.5 shadow-2xl backdrop-blur-md text-white animate-in fade-in slide-in-from-bottom-4 duration-200"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-violet-400">
          <div className="p-1.5 rounded-lg bg-violet-600/20 border border-violet-500/30">
            <Sparkles className="w-3.5 h-3.5 animate-pulse" />
          </div>
          <span className="font-semibold text-xs tracking-wide">{toastHeadline}</span>
        </div>
        <button
          type="button"
          onClick={dismissToast}
          className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
          title="Dismiss notification"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <p className="text-xs text-gray-300 mt-2 line-clamp-2 leading-relaxed">
        {toastSummary}
      </p>

      <div className="flex items-center justify-end gap-2 mt-3 pt-2 border-t border-white/5">
        <button
          type="button"
          onClick={dismissToast}
          className="px-2.5 py-1 text-[11px] text-gray-400 hover:text-white transition-colors"
        >
          Dismiss
        </button>
        <button
          type="button"
          onClick={reviewTask}
          className="inline-flex items-center gap-1.5 px-3 py-1 rounded-lg bg-violet-600 hover:bg-violet-500 text-white text-[11px] font-medium transition-colors shadow-sm"
        >
          <span>Review</span>
          <ArrowRight className="w-3 h-3" />
        </button>
      </div>
    </aside>
  )
}
