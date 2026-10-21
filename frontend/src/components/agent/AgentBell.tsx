/**
 * AgentBell.tsx — the Zap icon in the header, showing AI Agent status.
 *
 * Badge colours: green = a dialog needs an answer, blue pulse = working,
 * red = a fresh failure, violet = unread results.
 *
 * The badge is derived from the tasks on every render rather than trusted from a
 * stored counter, so it cannot keep demanding attention for work the user has
 * already seen. "Working" also expires, because a task left queued or running by
 * a server restart should not pulse forever.
 */
import { Zap } from 'lucide-react'
import { useAgentStore } from '@/store/agentStore'
import { Button } from '@/components/ui/button'
import AgentStatusBar from './AgentStatusBar'

/** After this long, a queued/running task is treated as stale, not active. */
const RUNNING_STALE_MS = 15 * 60 * 1000

function firstTime(...candidates: (string | null | undefined)[]): number | null {
  for (const value of candidates) {
    if (!value) continue
    const ts = Date.parse(value)
    if (!Number.isNaN(ts)) return ts
  }
  return null
}

export default function AgentBell() {
  const { unreadCount, togglePanel, isPanelOpen, tasks, lastReadAt } = useAgentStore()
  const now = Date.now()
  const sinceRead = lastReadAt ?? now

  const isRunning = tasks.some((task) => {
    if (task.status !== 'queued' && task.status !== 'running') return false
    const ts = firstTime(task.updated_at, task.created_at)
    return ts !== null && now - ts < RUNNING_STALE_MS
  })

  // A dialog only demands attention if an active (queued/running) task is awaiting user action
  // and has not been viewed yet.
  const hasPendingDialog = tasks.some((task) => {
    if (task.status !== 'queued' && task.status !== 'running') return false
    if (!task.logs || task.logs.length === 0) return false
    const hasAction = task.logs.some((l) => Boolean(l.data?.action_payload))
    if (!hasAction) return false
    const ts = firstTime(task.updated_at, task.created_at)
    return ts !== null && ts > sinceRead
  })

  const MAX_FAILURE_AGE_MS = 60 * 60 * 1000 // 1 hour
  const freshFinishes = tasks.filter((task) => {
    const ts = firstTime(task.completed_at)
    return ts !== null && ts > sinceRead && (now - ts) < MAX_FAILURE_AGE_MS
  })
  const hasFreshFailure = freshFinishes.some((task) => task.status === 'failed')

  const showBadge = unreadCount > 0 || hasPendingDialog || isRunning
  const badgeClass = hasPendingDialog
    ? 'bg-green-500 shadow-green-500/40 animate-bounce'
    : isRunning
    ? 'bg-blue-500 shadow-blue-500/40 animate-pulse'
    : hasFreshFailure
    ? 'bg-red-500 shadow-red-500/40 animate-bounce'
    : 'bg-violet-600 shadow-violet-500/40 animate-bounce'

  return (
    <div className="flex items-center gap-1.5">
      <AgentStatusBar />
      <Button
        variant="ghost"
        size="icon"
        onClick={togglePanel}
        className="relative"
        title="AI Agent"
        id="agent-bell-btn"
      >
        <Zap
          className={`h-5 w-5 transition-all duration-200 ${
            isPanelOpen ? 'text-violet-500' : isRunning ? 'text-blue-500' : ''
          }`}
        />
        {showBadge && (
          <span
            className={`absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full
                       text-white text-[10px] font-bold flex items-center justify-center
                       shadow-lg px-1 ${badgeClass}`}
          >
            {hasPendingDialog ? '!' : isRunning ? '…' : (unreadCount > 99 ? '99+' : unreadCount)}
          </span>
        )}
      </Button>
    </div>
  )
}
