/**
 * AgentActivityPanel.tsx — Chat-style AI Agent panel.
 *
 * Each user command appears as a right-aligned bubble.
 * Each task's logs stream in as left-aligned agent messages.
 * Service/job results render as interactive cards inside the chat.
 * Dialogs render as inline choice buttons.
 */
import { useEffect, useRef, useState } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { X, Zap, Loader2, Settings, Send, Trash2, ChevronRight } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useAgentStore, AgentTask, AgentLog } from '@/store/agentStore'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Main Panel ───────────────────────────────────────────────────────────────

export default function AgentActivityPanel() {
  const { isPanelOpen, closePanel, tasks, clearHistory, submitCommand } = useAgentStore()
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const navigate = useNavigate()

  // Auto-scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [tasks])

  // Listen for navigate_to in logs and redirect
  useEffect(() => {
    for (const task of tasks) {
      for (const log of task.logs ?? []) {
        if (log.data?.navigate_to) {
          navigate(log.data.navigate_to as string)
          closePanel()
        }
      }
    }
  }, [tasks, navigate, closePanel])

  if (!isPanelOpen) return null

  const handleSend = async () => {
    const text = input.trim()
    if (!text || sending) return
    setInput('')
    setSending(true)
    await submitCommand(text)
    setSending(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Show tasks newest-first in the panel but render each task oldest-first
  const sortedTasks = [...tasks].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-[60]" onClick={closePanel} />

      {/* Panel */}
      <div className="fixed top-0 right-0 h-full w-full max-w-md bg-white dark:bg-gray-950 shadow-2xl z-[70] flex flex-col border-l border-gray-200 dark:border-gray-800 animate-in slide-in-from-right duration-300">

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/80 backdrop-blur shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-violet-100 dark:bg-violet-900/50 flex items-center justify-center">
              <Zap className="w-4 h-4 text-violet-600 dark:text-violet-400" />
            </div>
            <div>
              <p className="font-semibold text-sm leading-none">GigidyAI</p>
              <p className="text-xs text-gray-500 mt-0.5">Your smart marketplace assistant</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {tasks.length > 0 && (
              <Button variant="ghost" size="icon" title="Clear history" className="h-8 w-8 text-gray-400 hover:text-red-500"
                onClick={() => clearHistory()}>
                <Trash2 className="w-4 h-4" />
              </Button>
            )}
            <Link to="/dashboard/ai-settings" onClick={closePanel}>
              <Button variant="ghost" size="icon" title="AI Settings" className="h-8 w-8">
                <Settings className="w-4 h-4 text-gray-500" />
              </Button>
            </Link>
            <Button variant="ghost" size="icon" onClick={closePanel} className="h-8 w-8">
              <X className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* Chat thread */}
        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {sortedTasks.length === 0 ? (
            <EmptyState onChipClick={(text) => { setInput(text); }} />
          ) : (
            sortedTasks.map((task) => (
              <TaskThread key={task.id} task={task} onNavigate={(path) => { navigate(path); closePanel() }} />
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div className="border-t border-gray-200 dark:border-gray-800 p-3 shrink-0 bg-white dark:bg-gray-950">
          <div className="flex items-center gap-2 bg-gray-50 dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 focus-within:border-violet-400 transition-colors">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask me anything…"
              rows={1}
              className="flex-1 bg-transparent resize-none outline-none text-sm leading-snug max-h-28"
              style={{ scrollbarWidth: 'none' }}
            />
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!input.trim() || sending}
              className="h-8 w-8 rounded-lg bg-violet-600 hover:bg-violet-700 text-white shrink-0 disabled:opacity-40"
            >
              {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-[10px] text-gray-400 text-center mt-1.5">Press Enter to send · Shift+Enter for new line</p>
        </div>
      </div>
    </>
  )
}

// ─── Task Thread ──────────────────────────────────────────────────────────────

function TaskThread({ task, onNavigate }: { task: AgentTask; onNavigate: (path: string) => void }) {
  const { respondToDialog, cancelTask } = useAgentStore()
  const timeAgo = formatDistanceToNow(new Date(task.created_at), { addSuffix: true })
  const isActive = task.status === 'queued' || task.status === 'running'

  const handleDialogAction = async (action: string) => {
    await respondToDialog(task.id, action)
  }

  return (
    <div className="space-y-3">
      {/* User command bubble */}
      <div className="flex justify-end">
        <div className="max-w-[80%]">
          <div className="bg-violet-600 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm shadow-sm">
            {task.command_text}
          </div>
          <p className="text-[10px] text-gray-400 text-right mt-1">{timeAgo}</p>
        </div>
      </div>

      {/* Agent logs */}
      {(task.logs ?? []).map((log) => (
        <AgentMessage key={log.id} log={log} onDialogAction={handleDialogAction} onNavigate={onNavigate} />
      ))}

      {/* Thinking indicator */}
      {isActive && (
        <div className="flex items-start gap-2.5">
          <AgentAvatar />
          <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl rounded-bl-sm px-4 py-3">
            <div className="flex gap-1 items-center">
              <span className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
          {isActive && (
            <button onClick={() => cancelTask(task.id)} className="text-xs text-red-400 hover:text-red-600 mt-2 self-end">
              Cancel
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Agent Message ─────────────────────────────────────────────────────────────

function AgentMessage({ log, onDialogAction, onNavigate }: {
  log: AgentLog
  onDialogAction: (action: string) => void
  onNavigate: (path: string) => void
}) {
  const data = log.data as any
  const renderType = data?.render_type
  const actionPayload = data?.action_payload

  // Skip raw "Command received" and "Parsing command intent" logs — they're noise in the chat
  if (log.message.startsWith('Command received:') || log.message === 'Parsing command intent...') {
    return null
  }

  const bubbleBg = log.level === 'error'
    ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
    : log.level === 'warning'
      ? 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'
      : log.level === 'success'
        ? 'bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-900'
        : 'bg-gray-100 dark:bg-gray-800'

  return (
    <div className="flex items-start gap-2.5">
      <AgentAvatar />
      <div className="flex-1 space-y-2">
        <div className={cn('rounded-2xl rounded-bl-sm px-4 py-2.5 text-sm max-w-[85%]', bubbleBg)}>
          <p className="text-gray-800 dark:text-gray-200 whitespace-pre-line leading-relaxed">
            <LogMessage text={log.message} onNavigate={onNavigate} />
          </p>
        </div>

        {/* Inline service cards */}
        {renderType === 'service_cards' && data?.services?.length > 0 && (
          <div className="space-y-2 max-w-[90%]">
            {data.services.map((svc: any) => (
              <ServiceResultCard key={svc.id} service={svc} onRequest={() => onDialogAction(`select_service:${svc.id}`)} />
            ))}
          </div>
        )}

        {/* Inline job cards */}
        {renderType === 'job_cards' && data?.jobs?.length > 0 && (
          <div className="space-y-2 max-w-[90%]">
            {data.jobs.map((job: any) => (
              <JobResultCard key={job.id} job={job} onNavigate={onNavigate} />
            ))}
          </div>
        )}

        {/* Dialog options */}
        {actionPayload?.options && (
          <DialogOptions options={actionPayload.options} onSelect={onDialogAction} />
        )}

        {/* Legacy confirm/cancel fallback for old-style dialogs */}
        {actionPayload && !actionPayload.options && (
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" className="bg-violet-600 hover:bg-violet-700 text-white"
              onClick={() => onDialogAction('confirm')}>
              {actionPayload.type === 'create_job_fallback' ? 'Yes, Post a Job' : 'Approve'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => onDialogAction('cancel')}>
              No, Cancel
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function AgentAvatar() {
  return (
    <div className="w-7 h-7 rounded-full bg-violet-100 dark:bg-violet-900/60 flex items-center justify-center shrink-0 mt-0.5">
      <Zap className="w-3.5 h-3.5 text-violet-600 dark:text-violet-400" />
    </div>
  )
}

function ServiceResultCard({ service, onRequest }: { service: any; onRequest: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 shadow-sm">
      <div className="min-w-0">
        <p className="font-medium text-sm truncate">{service.title}</p>
        <p className="text-xs text-violet-600 dark:text-violet-400 font-semibold mt-0.5">₦{Number(service.price).toLocaleString()}</p>
        {service.description && (
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{service.description}</p>
        )}
      </div>
      <Button size="sm" className="shrink-0 bg-violet-600 hover:bg-violet-700 text-white text-xs h-7 px-2.5"
        onClick={onRequest}>
        Request
      </Button>
    </div>
  )
}

function JobResultCard({ job, onNavigate }: { job: any; onNavigate: (path: string) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 shadow-sm">
      <div className="min-w-0">
        <p className="font-medium text-sm truncate">{job.title}</p>
        <p className="text-xs text-emerald-600 font-semibold mt-0.5">₦{Number(job.price).toLocaleString()}</p>
        {job.description && (
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{job.description}</p>
        )}
      </div>
      <Button size="sm" variant="outline" className="shrink-0 text-xs h-7 px-2.5 gap-1"
        onClick={() => onNavigate(`/dashboard/jobs?jobId=${job.id}`)}>
        View <ChevronRight className="w-3 h-3" />
      </Button>
    </div>
  )
}

function DialogOptions({ options, onSelect }: {
  options: Array<{ label: string; action: string }>
  onSelect: (action: string) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)

  const handleClick = (action: string) => {
    if (selected) return
    setSelected(action)
    onSelect(action)
  }

  return (
    <div className="flex flex-wrap gap-2 mt-1">
      {options.map((opt) => {
        const isCancel = opt.action === 'cancel'
        const isSelected = selected === opt.action
        return (
          <button
            key={opt.action}
            onClick={() => handleClick(opt.action)}
            disabled={!!selected}
            className={cn(
              'text-xs px-3 py-1.5 rounded-full border font-medium transition-all',
              isSelected
                ? 'bg-violet-600 text-white border-violet-600'
                : isCancel
                  ? 'border-gray-300 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
                  : 'border-violet-300 text-violet-700 hover:bg-violet-50 dark:border-violet-700 dark:text-violet-400 dark:hover:bg-violet-900/30',
              selected && !isSelected && 'opacity-40 cursor-not-allowed'
            )}
          >
            {isSelected ? '✓ ' : ''}{opt.label}
          </button>
        )
      })}
    </div>
  )
}

function EmptyState({ onChipClick }: { onChipClick: (text: string) => void }) {
  const chips = [
    'Find a plumber for 5k',
    'Post a job: fix my sink for ₦8,000',
    'Go to services',
    'Show open jobs',
  ]
  return (
    <div className="flex flex-col items-center justify-center h-full text-center py-10 px-4">
      <div className="w-16 h-16 rounded-full bg-violet-50 dark:bg-violet-900/30 flex items-center justify-center mb-4">
        <Zap className="w-8 h-8 text-violet-400" />
      </div>
      <p className="font-semibold text-gray-900 dark:text-gray-100 mb-1">Hi! I'm GigidyAI</p>
      <p className="text-sm text-gray-500 mb-6 max-w-xs">
        I can find services, post jobs, negotiate on your behalf, and navigate the app.
      </p>
      <div className="flex flex-col gap-2 w-full max-w-xs">
        {chips.map((chip) => (
          <button
            key={chip}
            onClick={() => onChipClick(chip)}
            className="text-sm text-left bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 hover:border-violet-400 hover:bg-violet-50 dark:hover:bg-violet-900/20 transition-colors text-gray-700 dark:text-gray-300"
          >
            {chip}
          </button>
        ))}
      </div>
    </div>
  )
}

function LogMessage({ text, onNavigate }: { text: string; onNavigate: (path: string) => void }) {
  const linkRegex = /\[([^\]]+)\]\(([^)]+)\)/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match

  while ((match = linkRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex, match.index)}</span>)
    }
    const url = match[2]
    const isInternal = url.startsWith('/') || url.startsWith('?')
    parts.push(
      isInternal ? (
        <button key={`l-${match.index}`} onClick={() => onNavigate(url)}
          className="text-violet-600 dark:text-violet-400 hover:underline font-medium">
          {match[1]}
        </button>
      ) : (
        <a key={`l-${match.index}`} href={url} target="_blank" rel="noreferrer"
          className="text-violet-600 dark:text-violet-400 hover:underline font-medium">
          {match[1]}
        </a>
      )
    )
    lastIndex = linkRegex.lastIndex
  }

  if (lastIndex < text.length) {
    parts.push(<span key={`t-${lastIndex}`}>{text.slice(lastIndex)}</span>)
  }

  return <>{parts}</>
}
