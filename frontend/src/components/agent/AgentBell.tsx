/**
 * AgentBell.tsx — Bell icon in the header showing unread agent activity count.
 *
 * Clicking it opens/closes the AgentActivityPanel.
 * Shows an animated red badge when there are unread agent notifications.
 */

import { Bell } from 'lucide-react'
import { useAgentStore } from '@/store/agentStore'
import { Button } from '@/components/ui/button'

export default function AgentBell() {
  const { unreadCount, togglePanel, isPanelOpen, tasks } = useAgentStore()

  // Check if there are any pending interactive dialogs (look at the last log of each task)
  const hasPendingDialog = tasks.some(task => {
    if (task.status === 'queued' || task.status === 'running') return false;
    const lastLog = task.logs?.[task.logs.length - 1];
    return lastLog?.data?.action_payload;
  })

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={togglePanel}
      className="relative"
      title="AI Agent Activity"
      id="agent-bell-btn"
    >
      <Bell
        className={`h-5 w-5 transition-all duration-200 ${
          isPanelOpen ? 'text-violet-500' : ''
        }`}
      />
      {(unreadCount > 0 || hasPendingDialog) && (
        <span
          className={`absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full
                     text-white text-[10px] font-bold flex items-center justify-center
                     animate-bounce shadow-lg px-1 ${
                       hasPendingDialog 
                         ? 'bg-green-500 shadow-green-500/40' 
                         : 'bg-violet-600 shadow-violet-500/40'
                     }`}
        >
          {hasPendingDialog ? '!' : (unreadCount > 99 ? '99+' : unreadCount)}
        </span>
      )}
    </Button>
  )
}
