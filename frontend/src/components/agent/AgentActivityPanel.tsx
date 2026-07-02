/**
 * AgentActivityPanel.tsx — Slide-in panel showing all agent tasks and logs.
 */
import { formatDistanceToNow } from 'date-fns';
import { X, CheckCircle2, XCircle, AlertCircle, Info, Zap, Loader2, Trash2, Settings } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useAgentStore, AgentTask } from '@/store/agentStore';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';

const LEVEL_ICONS: Record<string, React.ReactNode> = {
  info: <Info className="w-4 h-4 text-blue-500" />,
  action: <Zap className="w-4 h-4 text-violet-500" />,
  success: <CheckCircle2 className="w-4 h-4 text-green-500" />,
  error: <XCircle className="w-4 h-4 text-red-500" />,
  warning: <AlertCircle className="w-4 h-4 text-yellow-500" />,
}

const STATUS_STYLES: Record<string, string> = {
  queued: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  running: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300 animate-pulse',
  completed: 'bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
  cancelled: 'bg-gray-200 text-gray-600 dark:bg-gray-700 dark:text-gray-400',
}

export default function AgentActivityPanel() {
  const { isPanelOpen, closePanel, tasks, markAllRead, cancelTask } = useAgentStore()

  if (!isPanelOpen) return null

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40 z-[60] transition-opacity"
        onClick={closePanel}
      />

      {/* Slide-in Panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-md bg-white dark:bg-gray-950 shadow-2xl z-[70] flex flex-col animate-in slide-in-from-right duration-300 border-l border-gray-200 dark:border-gray-800">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/50">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-violet-600 dark:text-violet-400" />
            <h2 className="font-semibold text-lg">AI Agent Activity</h2>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/dashboard/ai-settings" onClick={closePanel}>
              <Button variant="ghost" size="icon" title="AI Settings">
                <Settings className="w-5 h-5 text-gray-500" />
              </Button>
            </Link>
            <Button variant="ghost" size="sm" onClick={markAllRead}>
              Mark read
            </Button>
            <Button variant="ghost" size="icon" onClick={closePanel}>
              <X className="w-5 h-5" />
            </Button>
          </div>
        </div>

        {/* Content (Scrollable list of tasks) */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {tasks.length === 0 ? (
            <div className="text-center text-gray-500 dark:text-gray-400 mt-10">
              <div className="bg-gray-100 dark:bg-gray-900 w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-4">
                <Zap className="w-8 h-8 text-violet-400" />
              </div>
              <p className="font-medium text-gray-900 dark:text-gray-100 mb-2">No activity yet</p>
              <p className="text-sm px-4">
                Use the voice assistant or type a command to give the agent a task.
              </p>
              <div className="mt-6 text-xs bg-gray-50 dark:bg-gray-900 p-4 rounded-xl text-left inline-block">
                <p className="font-semibold mb-2">Try saying:</p>
                <ul className="space-y-1">
                  <li>"Find a plumber for under 5k"</li>
                  <li>"Post a job called fix sink for 10000"</li>
                  <li>"Show open jobs"</li>
                </ul>
              </div>
            </div>
          ) : (
            tasks.map((task) => (
              <TaskCard key={task.id} task={task} onCancel={() => cancelTask(task.id)} />
            ))
          )}
        </div>
      </div>
    </>
  )
}

function TaskCard({ task, onCancel }: { task: AgentTask; onCancel: () => void }) {
  const isCancellable = task.status === 'queued' || task.status === 'running'
  
  // Format the time since creation
  const timeAgo = formatDistanceToNow(new Date(task.created_at), { addSuffix: true })

  const handleDialogResponse = async (taskId: string, action: string) => {
    try {
      await api.post(`/ai/tasks/${taskId}/respond`, { action })
      useAgentStore.getState().fetchTasks() // Refresh to clear the dialog
    } catch (err) {
      console.error('Failed to respond to dialog:', err)
    }
  }

  return (
    <div className="border border-gray-200 dark:border-gray-800 rounded-xl overflow-hidden bg-white dark:bg-gray-900 shadow-sm">
      {/* Task Header */}
      <div className="p-3 bg-gray-50 dark:bg-gray-900 border-b border-gray-100 dark:border-gray-800 flex items-start justify-between">
        <div>
          <span
            className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium uppercase tracking-wider mb-2 ${
              STATUS_STYLES[task.status]
            }`}
          >
            {task.status === 'running' && <Loader2 className="w-3 h-3 mr-1 animate-spin" />}
            {task.status}
          </span>
          <p className="text-sm font-medium text-gray-900 dark:text-gray-100 break-words line-clamp-2">
            "{task.command_text}"
          </p>
          <p className="text-xs text-gray-500 mt-1">{timeAgo}</p>
        </div>
        {isCancellable && (
          <Button
            variant="ghost"
            size="icon"
            onClick={onCancel}
            title="Cancel task"
            className="h-8 w-8 text-gray-400 hover:text-red-500"
          >
            <Trash2 className="w-4 h-4" />
          </Button>
        )}
      </div>

      {/* Task Logs */}{/* Task Logs */}
{/* Task Logs */}
{task.logs.length > 0 && (
  <div className="p-3 space-y-3">
    {task.logs.map((log) => (
      <div key={log.id} className="flex items-start gap-2.5 text-sm">
        <div className="mt-0.5 shrink-0 bg-white dark:bg-gray-950 rounded-full">
          {LEVEL_ICONS[log.level] || LEVEL_ICONS.info}
        </div>
        <div className="flex-1">
          <p className="text-gray-700 dark:text-gray-300 whitespace-pre-line leading-snug">
            <LogMessage text={log.message} />
          </p>
          {/* Interactive Action Payload */}
          {!!log.data?.action_payload && (
            <div className="mt-2 flex gap-2">
              <Button 
                size="sm" 
                className="bg-black text-white hover:bg-gray-800"
                onClick={() => handleDialogResponse(task.id, 'confirm')}
              >
                {/* Wrapping it in parentheses and casting to 'any' forces TS to shut up about the {} type */}
                {(log.data.action_payload as any).type === 'create_job_fallback' 
                  ? 'Yes, Create Job' 
                  : 'Approve & Pay'}
              </Button>
              <Button 
                size="sm" 
                variant="outline"
                onClick={() => handleDialogResponse(task.id, 'cancel')}
              >
                No
              </Button>
            </div>
          )}
        </div>
      </div>
    ))}
  </div>
)}
    </div>
  )
}

function LogMessage({ text }: { text: string }) {
  // Simple markdown link parser: [Label](/url) or [Label](?jobId=123)
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
  const parts = []
  let lastIndex = 0
  let match

  while ((match = linkRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={`text-${lastIndex}`}>{text.slice(lastIndex, match.index)}</span>)
    }
    
    const url = match[2]
    // If it's a query param link, use a normal <a> tag or react-router Link
    parts.push(
      <Link 
        key={`link-${match.index}`} 
        to={url} 
        className="text-violet-600 dark:text-violet-400 hover:underline font-medium"
      >
        {match[1]}
      </Link>
    )
    lastIndex = linkRegex.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push(<span key={`text-${lastIndex}`}>{text.slice(lastIndex)}</span>)
  }

  return <>{parts}</>
}
