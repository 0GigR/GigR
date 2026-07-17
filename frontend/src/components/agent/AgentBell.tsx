/**
 * AgentBell.tsx — Zap icon in the header showing AI Agent status.
 * Badge colors: green=pending dialog, blue pulse=running, red=fresh failure, violet=unread
 */
import { Zap } from 'lucide-react'
import { useAgentStore } from '@/store/agentStore'
import { Button } from '@/components/ui/button'

export default function AgentBell() {
  const { unreadCount, togglePanel, isPanelOpen, tasks } = useAgentStore()

  const isRunning = tasks.some((t) => t.status === 'queued' || t.status === 'running')
  const hasPendingDialog = tasks.some((task) => {
    const lastLog = task.logs?.[task.logs.length - 1]
    return !!lastLog?.data?.action_payload
  })
  // Tasks are stored newest-first, so the unread ones are the first `unreadCount`.
  // Only light up red if one of those fresh, unseen tasks actually failed.
  const hasFreshFailure =
    unreadCount > 0 && tasks.slice(0, unreadCount).some((t) => t.status === 'failed')

  const showBadge = unreadCount > 0 || hasPendingDialog || isRunning
  const badgeClass = hasPendingDialog
    ? 'bg-green-500 shadow-green-500/40 animate-bounce'
    : isRunning
    ? 'bg-blue-500 shadow-blue-500/40 animate-pulse'
    : hasFreshFailure
    ? 'bg-red-500 shadow-red-500/40 animate-bounce'
    : 'bg-violet-600 shadow-violet-500/40 animate-bounce'

  return (
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
  )
}
