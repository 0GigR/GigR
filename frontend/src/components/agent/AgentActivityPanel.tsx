/**
 * AgentActivityPanel.tsx — Chat-style AI Agent panel.
 *
 * Each user command appears as a right-aligned bubble.
 * Each task's logs stream in as left-aligned agent messages.
 * Service/job results render as interactive cards inside the chat.
 * Dialogs render as inline choice buttons.
 */
import { useEffect, useRef, useState, useCallback, lazy, Suspense } from 'react'
import { formatDistanceToNow } from 'date-fns'
import { X, Zap, Loader2, Settings, Send, Trash2, ChevronRight, ChevronDown, Check, Wrench, Sparkles, Wallet, Mic } from 'lucide-react'
import { toast } from 'sonner'
import { Link, useNavigate } from 'react-router-dom'
import { useAgentStore, AgentTask, AgentLog } from '@/store/agentStore'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { motion, AnimatePresence } from 'framer-motion'
import { RobotWaitingIllustration } from './illustrations'
import { agentAudio } from '@/lib/agentAudio'

const AgentResultMap = lazy(() => import('./AgentResultMap'))

// ─── Helpers ──────────────────────────────────────────────────────────────────

// ─── Main Panel ───────────────────────────────────────────────────────────────

const HANDLED_NAV_KEY = 'gigr_agent_handled_nav'
/** How long a "take me there" intent stays actionable after it is written. */
const NAV_INTENT_TTL_MS = 2 * 60 * 1000

function loadHandledNavIds(): Set<string> {
  try {
    const raw = sessionStorage.getItem(HANDLED_NAV_KEY)
    return new Set<string>(raw ? (JSON.parse(raw) as string[]) : [])
  } catch {
    return new Set<string>()
  }
}

function saveHandledNavIds(ids: Set<string>) {
  try {
    // Keep only the tail: these ids are worthless once stale.
    sessionStorage.setItem(HANDLED_NAV_KEY, JSON.stringify([...ids].slice(-200)))
  } catch {
    /* storage unavailable — navigation still works for this mount */
  }
}

function isFreshNavIntent(createdAt?: string | null): boolean {
  if (!createdAt) return false
  const ts = Date.parse(createdAt)
  if (Number.isNaN(ts)) return false
  return Date.now() - ts < NAV_INTENT_TTL_MS
}

export default function AgentActivityPanel() {
  const { isPanelOpen, closePanel, tasks, clearHistory, submitCommand, isSubmitting } = useAgentStore()
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [showClearConfirm, setShowClearConfirm] = useState(false)
  const [isVoiceActive, setIsVoiceActive] = useState(false)
  const voiceRecognitionRef = useRef<any>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const speechBufferRef = useRef('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  const isAtBottomRef = useRef(true)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const navigate = useNavigate()
  // Log ids we have already acted on, persisted for the session.
  const handledLogIds = useRef<Set<string>>(loadHandledNavIds())

  const handleScroll = useCallback(() => {
    const element = scrollContainerRef.current
    if (!element) return
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight
    // Sticky if within 90px of bottom
    isAtBottomRef.current = distanceFromBottom < 90
  }, [])

  const handleSendSpoken = useCallback(async (spokenPhrase: string) => {
    const cleanSpeech = spokenPhrase.trim()
    if (!cleanSpeech || sending || isSubmitting) return
    setInput('')
    speechBufferRef.current = ''
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    isAtBottomRef.current = true
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    setSending(true)
    await submitCommand(cleanSpeech)
    setSending(false)
  }, [sending, isSubmitting, submitCommand])

  const stopVoice = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
    if (voiceRecognitionRef.current) {
      try {
        voiceRecognitionRef.current.stop()
      } catch {
        /* already stopped */
      }
      voiceRecognitionRef.current = null
    }
    setIsVoiceActive(false)
  }, [])

  const startVoice = useCallback(() => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      toast.error('Voice recognition is not supported in this browser.')
      return
    }

    const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    const speechRecognition = new SpeechRecognitionClass()
    speechRecognition.continuous = true
    speechRecognition.interimResults = true
    speechRecognition.lang = 'en-US'

    speechRecognition.onresult = (event: any) => {
      let finalSpeech = ''
      let interimSpeech = ''
      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          finalSpeech += event.results[i][0].transcript
        } else {
          interimSpeech += event.results[i][0].transcript
        }
      }
      const activeSpeech = (finalSpeech || interimSpeech).trim()
      if (activeSpeech) {
        setInput(activeSpeech)
        speechBufferRef.current = activeSpeech
        if (textareaRef.current) {
          textareaRef.current.style.height = 'auto'
          textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 128)}px`
        }
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current)
        }
        silenceTimerRef.current = setTimeout(() => {
          if (speechBufferRef.current) {
            const speechToSubmit = speechBufferRef.current
            stopVoice()
            handleSendSpoken(speechToSubmit)
          }
        }, 1200)
      }
    }

    speechRecognition.onerror = (event: any) => {
      console.warn('[agent-voice] recognition error', event.error)
      stopVoice()
    }

    speechRecognition.onend = () => {
      setIsVoiceActive(false)
      if (speechBufferRef.current) {
        const speechToSubmit = speechBufferRef.current
        speechBufferRef.current = ''
        handleSendSpoken(speechToSubmit)
      }
    }

    voiceRecognitionRef.current = speechRecognition
    speechBufferRef.current = ''
    speechRecognition.start()
    setIsVoiceActive(true)
  }, [stopVoice, handleSendSpoken])

  const toggleVoice = () => {
    if (isVoiceActive) {
      stopVoice()
    } else {
      startVoice()
    }
  }

  useEffect(() => {
    return () => {
      if (voiceRecognitionRef.current) {
        try { voiceRecognitionRef.current.stop() } catch {}
      }
    }
  }, [])

  // Auto-scroll on new messages only if user is already near the bottom
  useEffect(() => {
    if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [tasks])

  // Jump straight to the latest message whenever the panel is opened. Runs after
  // the slide-in animation/content mounts, so use a tick delay + instant scroll.
  useEffect(() => {
    if (!isPanelOpen) return
    isAtBottomRef.current = true
    const id = setTimeout(() => {
      bottomRef.current?.scrollIntoView({ behavior: 'auto' })
    }, 120)
    return () => clearTimeout(id)
  }, [isPanelOpen])

  // Honour the agent's "take me there" intents.
  //
  // A navigate_to is ephemeral: it exists so the agent can move you somewhere
  // right after you ask. Because the handled-ids set used to be an in-memory ref,
  // every mount replayed every old intent — which is why refreshing hours later
  // still threw you back to the jobs page. Now the set survives a refresh, and an
  // intent is only acted on while it is fresh.
  useEffect(() => {
    let changed = false
    for (const task of tasks) {
      for (const log of task.logs ?? []) {
        const target = log.data?.navigate_to
        if (!target || handledLogIds.current.has(log.id)) continue
        handledLogIds.current.add(log.id)
        changed = true
        if (!isFreshNavIntent(log.created_at)) continue
        navigate(target as string)
        closePanel()
      }
    }
    if (changed) saveHandledNavIds(handledLogIds.current)
  }, [tasks, navigate, closePanel])

  const handleSend = async () => {
    if (!input.trim() || sending || isSubmitting) return
    const text = input
    setInput('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
    isAtBottomRef.current = true
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    setSending(true)
    await submitCommand(text)
    setSending(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Tasks are returned descending; reverse to show oldest top -> newest bottom
  const sortedTasks = [...tasks].reverse()

  return (
    <>
      <AnimatePresence>
      {isPanelOpen && (
        <>
          {/* Backdrop */}
          <motion.div 
            initial={{ opacity: 0 }} 
            animate={{ opacity: 1 }} 
            exit={{ opacity: 0 }} 
            className="fixed inset-0 bg-black/40 z-[9998]" 
            onClick={closePanel} 
          />

          {/* Panel */}
          <motion.div 
            initial={{ x: '100%' }} 
            animate={{ x: 0 }} 
            exit={{ x: '100%' }} 
            transition={{ type: 'spring', damping: 25, stiffness: 200 }}
            className="fixed top-0 right-0 h-full w-full max-w-md bg-white dark:bg-gray-950 shadow-2xl z-[9999] flex flex-col border-l border-gray-200 dark:border-gray-800"
          >

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50/80 dark:bg-gray-900/80 backdrop-blur shrink-0">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-indigo-100 dark:bg-indigo-950/60 flex items-center justify-center">
              <Zap className="w-4 h-4 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <p className="font-semibold text-sm leading-none flex items-center gap-1.5">
                Gigidy AI
                <span className="text-[9px] font-mono font-medium px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">
                  [OK] ACTIVE
                </span>
              </p>
              <p className="text-xs text-gray-500 mt-0.5">Your local Gigr assistant</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            {tasks.length > 0 && (
              <Button variant="ghost" size="icon" title="Clear history" className="h-8 w-8 text-gray-400 hover:text-red-500"
                onClick={() => setShowClearConfirm(true)}>
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
        <div
          ref={scrollContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-4 space-y-6"
        >
          {sortedTasks.length === 0 ? (
            <EmptyState onChipClick={(text) => { setInput(text); setTimeout(() => document.getElementById('agent-input')?.focus(), 50) }} />
          ) : (
            sortedTasks.map((task) => (
              <TaskThread key={task.id} task={task} onNavigate={(path) => { navigate(path); closePanel() }} />
            ))
          )}
          <div ref={bottomRef} />
        </div>

        {/* Input bar */}
        <div className="border-t border-gray-200 dark:border-gray-800 p-3 shrink-0 bg-white dark:bg-gray-950">
          <div className={cn(
            "flex items-center gap-2 bg-gray-50 dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-700 px-3 py-2 transition-colors",
            isVoiceActive ? "border-red-500 ring-2 ring-red-500/20" : "focus-within:border-indigo-500"
          )}>
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`
              }}
              onKeyDown={handleKeyDown}
              placeholder={isVoiceActive ? "Listening... speak now" : "Ask Gigidy AI anything..."}
              rows={1}
              className="flex-1 bg-transparent resize-none outline-none text-sm leading-snug max-h-32 text-gray-900 dark:text-gray-100 placeholder:text-gray-400"
              id="agent-input"
              style={{ scrollbarWidth: 'none' }}
            />
            <Button
              type="button"
              size="icon"
              variant="ghost"
              onClick={toggleVoice}
              className={cn(
                "h-8 w-8 rounded-lg shrink-0 transition-colors",
                isVoiceActive ? "bg-red-500/20 text-red-500" : "text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              )}
              title={isVoiceActive ? "Listening... click to stop" : "Speak to Gigidy AI"}
              aria-label={isVoiceActive ? "Stop voice listening" : "Start voice listening"}
            >
              <Mic className={cn("w-4 h-4", isVoiceActive && "animate-pulse text-red-500")} />
            </Button>
            <Button
              size="icon"
              onClick={handleSend}
              disabled={!input.trim() || sending || isSubmitting}
              className="h-8 w-8 rounded-lg bg-black hover:bg-gray-800 text-white shrink-0 disabled:opacity-40"
              title="Send to Gigidy AI"
            >
              {sending || isSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            </Button>
          </div>
          <p className="text-[10px] text-gray-400 text-center mt-1.5">Press Enter to send · Shift+Enter for new line</p>
        </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>

    <ConfirmDialog
      open={showClearConfirm}
      onOpenChange={setShowClearConfirm}
      title="Clear History?"
      description="Are you sure you want to clear your AI agent history? This will cancel running tasks and clear all logs."
      confirmLabel="Clear History"
      onConfirm={async () => {
        await clearHistory()
        setShowClearConfirm(false)
      }}
    />
    </>
  )
}

// ─── Task Thread ──────────────────────────────────────────────────────────────

function TaskThread({ task, onNavigate }: { task: AgentTask; onNavigate: (path: string) => void }) {
  const { respondToDialog, cancelTask } = useAgentStore()
  const [isStepsCollapsed, setIsStepsCollapsed] = useState(true)
  const timeAgo = formatDistanceToNow(new Date(task.created_at), { addSuffix: true })
  const isActive = task.status === 'queued' || task.status === 'running'

  const handleDialogAction = async (action: string) => {
    await respondToDialog(task.id, action)
  }

  useEffect(() => {
    if (task.status === 'completed' && useAgentStore.getState().aiSettings.soundEnabled) {
      agentAudio.playSuccessChime()
    }
  }, [task.status])

  useEffect(() => {
    const logsList = task.logs ?? []
    const latestLog = logsList[logsList.length - 1]
    if (
      latestLog?.level === 'success' &&
      (latestLog?.data as Record<string, unknown> | null | undefined)?.render_type === 'service_cards' &&
      useAgentStore.getState().aiSettings.soundEnabled
    ) {
      agentAudio.playRadarPing()
    }
  }, [task.logs?.length])

  const allLogs = task.logs ?? []

  // Split logs into execution steps vs outcome cards / answers
  const stepLogs = allLogs.filter((l) => {
    if (l.level === 'think') return true
    if (l.level === 'action') return true
    if (
      l.level === 'info' &&
      !l.data?.render_type &&
      !l.data?.action_payload &&
      (l.message.startsWith('Searching') ||
        l.message.startsWith('Evaluating') ||
        l.message.startsWith('Parsing') ||
        l.message.startsWith('Agent started') ||
        l.message.startsWith('Interpreted as:') ||
        l.message.startsWith('Analyzing'))
    ) {
      return true
    }
    return false
  })

  const outcomeLogs = allLogs.filter((l) => !stepLogs.includes(l))

  const statusTag =
    task.status === 'running'
      ? '[RUNNING]'
      : task.status === 'queued'
        ? '[QUEUED]'
        : task.status === 'completed'
          ? '[DONE]'
          : task.status === 'waiting_reply'
            ? '[PENDING]'
            : task.status === 'failed'
              ? '[FAILED]'
              : task.status === 'cancelled'
                ? '[CANCELLED]'
                : null

  return (
    <div className="space-y-3">
      {/* User command bubble */}
      <div className="flex justify-end">
        <div className="max-w-[80%]">
          <div className="bg-indigo-600 text-white rounded-2xl rounded-br-sm px-4 py-2.5 text-sm shadow-sm">
            {task.command_text}
          </div>
          <div className="flex items-center justify-end gap-1.5 mt-1">
            {statusTag && (
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-100 dark:bg-gray-800 text-gray-500 font-semibold tracking-wider">
                {statusTag}
              </span>
            )}
            <p className="text-[10px] text-gray-400">{timeAgo}</p>
          </div>
        </div>
      </div>

      {/* Collapsible execution steps block */}
      {stepLogs.length > 0 && (
        <div className="space-y-1.5 pl-2 border-l-2 border-indigo-500/25 dark:border-indigo-500/35 ml-2 my-2">
          <div className="flex items-center justify-between">
            <button
              type="button"
              onClick={() => setIsStepsCollapsed((prev) => !prev)}
              className="flex items-center gap-1.5 text-[11px] font-mono text-gray-500 hover:text-gray-800 dark:hover:text-gray-200 py-1 px-2 rounded-lg bg-gray-100 dark:bg-gray-800 transition-colors"
            >
              {isStepsCollapsed ? (
                <>
                  <ChevronRight className="w-3.5 h-3.5" />
                  <span>Show {stepLogs.length} step{stepLogs.length === 1 ? '' : 's'}</span>
                </>
              ) : (
                <>
                  <ChevronDown className="w-3.5 h-3.5" />
                  <span>Hide execution steps ({stepLogs.length})</span>
                </>
              )}
            </button>
            {isActive && (
              <span className="text-[10px] font-mono text-indigo-500 dark:text-indigo-400 animate-pulse font-medium">
                [AGENT WORKING...]
              </span>
            )}
          </div>

          {!isStepsCollapsed && (
            <div className="space-y-1.5 pt-1">
              {stepLogs.map((step) => (
                <div
                  key={step.id}
                  className="flex items-start gap-2 text-xs py-1.5 px-2.5 rounded-lg bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800"
                >
                  <span
                    className={cn(
                      "text-[9px] font-mono px-1 py-0.5 rounded font-semibold uppercase shrink-0 mt-0.5",
                      step.level === 'think'
                        ? "bg-violet-950/60 text-violet-400 border border-violet-800/40"
                        : step.level === 'action'
                          ? "bg-blue-950/60 text-blue-400 border border-blue-800/40"
                          : "bg-gray-800 text-gray-300"
                    )}
                  >
                    {step.level === 'think' ? '[THINK]' : step.level === 'action' ? '[ACTION]' : '[STEP]'}
                  </span>
                  <span className="text-gray-700 dark:text-gray-300 leading-snug break-words">
                    {step.message}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Outcome logs (cards, dialogs, answers) */}
      {outcomeLogs.map((log) => (
        <AgentMessage key={log.id} log={log} onDialogAction={handleDialogAction} onNavigate={onNavigate} />
      ))}

      {/* Thinking indicator */}
      {isActive && (
        <div className="flex items-start gap-2.5">
          <AgentAvatar />
          <div className="bg-gray-100 dark:bg-gray-800 rounded-2xl rounded-bl-sm px-4 py-3">
            <div className="flex gap-1 items-center">
              <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
          {isActive && (
            <button onClick={() => cancelTask(task.id)} className="text-xs text-red-400 hover:text-red-600 mt-2 self-end font-mono">
              [CANCEL]
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Negotiation Progress Card ────────────────────────────────────────────────

interface NegotiationProgressCardProps {
  originalPrice: number
  targetPrice: number
  counterPrice?: number
  round: number
  savings: number
}

function NegotiationProgressCard({
  originalPrice,
  targetPrice,
  counterPrice,
  round,
  savings,
}: NegotiationProgressCardProps) {
  const ceiling = Math.max(originalPrice, targetPrice, counterPrice ?? 0) * 1.05
  const bars: Array<{ label: string; amount: number; colour: string }> = [
    { label: 'Listing', amount: originalPrice, colour: 'bg-gray-600' },
    { label: 'Target', amount: targetPrice, colour: 'bg-white' },
  ]
  if (counterPrice !== undefined && counterPrice > 0) {
    bars.push({ label: 'Counter', amount: counterPrice, colour: 'bg-gray-400' })
  }

  return (
    <div className="p-3 rounded-xl bg-gray-950/90 border border-gray-800 space-y-3 max-w-[90%]">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono text-gray-300 tracking-wider">
          [NEGOTIATION] Round {round}
        </span>
        {savings > 0 && (
          <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-emerald-950/60 text-emerald-400 border border-emerald-800/40">
            [OK] Saved: NGN {savings.toLocaleString()}
          </span>
        )}
      </div>

      {/* Bar chart */}
      <div className="space-y-2">
        {bars.map((bar) => (
          <div key={bar.label} className="space-y-0.5">
            <div className="flex justify-between text-[10px] text-gray-400">
              <span>{bar.label}</span>
              <span className="font-mono">NGN {bar.amount.toLocaleString()}</span>
            </div>
            <div className="h-2 w-full bg-gray-800 rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ${bar.colour}`}
                style={{ width: `${Math.min((bar.amount / ceiling) * 100, 100).toFixed(1)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Savings summary */}
      {savings > 0 && (
        <p className="text-xs text-emerald-400 font-semibold">
          Negotiated {((savings / originalPrice) * 100).toFixed(1)}% below listing price.
        </p>
      )}
    </div>
  )
}

// ─── Wallet Balance Card ──────────────────────────────────────────────────────

interface WalletCardProps {
  connected: boolean
  walletPublicKey?: string
  solBalance?: number
  usdcBalance?: string
  warning?: string
  onNavigate: (path: string) => void
}

function WalletCard({
  connected,
  walletPublicKey,
  solBalance = 0,
  usdcBalance = '0.00',
  warning,
  onNavigate,
}: WalletCardProps) {
  const truncatedKey = walletPublicKey
    ? `${walletPublicKey.slice(0, 4)}...${walletPublicKey.slice(-4)}`
    : null

  return (
    <div className="p-3.5 rounded-xl bg-gray-950/80 border border-violet-800/40 space-y-3 max-w-[90%] shadow-lg shadow-black/30">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Wallet className="w-3.5 h-3.5 text-violet-400" />
          <span className="text-[11px] font-mono font-medium text-violet-200">
            {connected ? `[WALLET] ${truncatedKey}` : '[WALLET] Disconnected'}
          </span>
        </div>
        <span
          className={cn(
            'text-[10px] font-mono px-1.5 py-0.5 rounded border',
            connected
              ? 'bg-emerald-950/60 text-emerald-400 border-emerald-800/40'
              : 'bg-amber-950/60 text-amber-400 border-amber-800/40',
          )}
        >
          {connected ? '[OK] ACTIVE' : '[PENDING] CONNECT'}
        </span>
      </div>

      {connected ? (
        <div className="grid grid-cols-2 gap-2">
          <div className="p-2 rounded-lg bg-white/5 border border-white/5">
            <span className="text-[10px] font-mono text-gray-400 block">SOL Balance</span>
            <span className="text-sm font-mono font-bold text-white">
              {Number(solBalance).toFixed(4)} <span className="text-violet-400 text-xs">SOL</span>
            </span>
          </div>
          <div className="p-2 rounded-lg bg-white/5 border border-white/5">
            <span className="text-[10px] font-mono text-gray-400 block">USDC Balance</span>
            <span className="text-sm font-mono font-bold text-white">
              ${usdcBalance} <span className="text-emerald-400 text-xs">USDC</span>
            </span>
          </div>
        </div>
      ) : (
        <p className="text-xs text-gray-300">
          Connect your Solana wallet in your profile to view balances, fund gigs, and receive escrow payouts.
        </p>
      )}

      {warning && (
        <p className="text-[11px] text-amber-400/90 font-mono">
          Note: {warning}
        </p>
      )}

      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          className="flex-1 bg-violet-600 hover:bg-violet-700 text-white text-xs h-8 font-mono"
          onClick={() => onNavigate('/dashboard/profile')}
        >
          [FUND WALLET]
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="border-gray-700 hover:bg-gray-800 text-xs h-8 font-mono text-gray-300"
          onClick={() => onNavigate('/dashboard/activity')}
        >
          [TRANSACTIONS]
        </Button>
      </div>
    </div>
  )
}

// ─── Agent Message ─────────────────────────────────────────────────────────────

function AgentMessage({ log, onDialogAction, onNavigate }: {
  log: AgentLog
  onDialogAction: (action: string) => void
  onNavigate: (path: string) => void
}) {
  const logPayload = (log.data as any) || {}
  const renderType = logPayload?.render_type
  const actionPayload = logPayload?.action_payload

  // Skip raw command echo and generic task completed marker
  if (
    log.message.startsWith('Command received:') ||
    log.message === 'Task completed'
  ) {
    return null
  }

  const bubbleBg = log.level === 'error'
    ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
    : log.level === 'warning'
      ? 'bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800'
      : log.level === 'success'
        ? 'bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-100 dark:border-emerald-900'
        : 'bg-gray-100 dark:bg-gray-800'

  // Agent reasoning transparency ("think" log level)
  if (log.level === 'think') {
    return (
      <div className="flex items-center gap-2 pl-9 py-0.5 text-xs text-violet-600/80 dark:text-violet-400/80 italic font-mono">
        <Sparkles className="w-3 h-3 shrink-0 text-violet-500 animate-pulse" />
        <span className="truncate">{log.message}</span>
      </div>
    )
  }

  // A tool call is the agent showing its work, not talking to you, so it reads as
  // a compact trace line instead of a chat bubble.
  if (logPayload?.tool) {
    return (
      <div className="flex items-center gap-2 pl-9 text-xs text-gray-500 dark:text-gray-400">
        <Wrench className="w-3 h-3 shrink-0 text-indigo-500" />
        <span className="truncate">{log.message}</span>
      </div>
    )
  }

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
        {renderType === 'service_cards' && logPayload?.services?.length > 0 && (
          <div className="space-y-2 max-w-[90%]">
            <Suspense fallback={null}>
              <AgentResultMap
                items={logPayload.services}
                onSelectItem={(selectedId) => onDialogAction(`select_service:${selectedId}`)}
                onNavigateToMap={() => onNavigate('/dashboard/services?tab=map')}
              />
            </Suspense>
            {logPayload.services.map((svc: any) => (
              <ServiceResultCard key={svc.id} service={svc} onRequest={() => onDialogAction(`select_service:${svc.id}`)} />
            ))}
          </div>
        )}

        {/* Inline job cards */}
        {renderType === 'job_cards' && logPayload?.jobs?.length > 0 && (
          <div className="space-y-2 max-w-[90%]">
            <Suspense fallback={null}>
              <AgentResultMap
                items={logPayload.jobs}
                onSelectItem={(selectedId) => onDialogAction(`select_job:${selectedId}`)}
                onNavigateToMap={() => onNavigate('/dashboard/jobs?tab=map')}
              />
            </Suspense>
            {logPayload.jobs.map((job: any) => (
              <JobResultCard 
                key={job.id} 
                job={job} 
                onNavigate={onNavigate} 
                onApply={() => onDialogAction(`select_job:${job.id}`)} 
              />
            ))}
          </div>
        )}

        {/* Inline multi-step plan card */}
        {renderType === 'plan_summary' && Array.isArray(logPayload?.child_tasks) && (
          <div className="space-y-1.5 p-3 rounded-xl bg-violet-950/30 border border-violet-800/40 max-w-[90%]">
            <div className="flex items-center justify-between pb-1.5 border-b border-violet-800/30">
              <span className="text-xs font-semibold text-violet-200">Execution Plan</span>
              <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-violet-900/60 text-violet-300">
                [PLAN]
              </span>
            </div>
            <div className="space-y-1">
              {logPayload.child_tasks.map((stepItem: any, idx: number) => (
                <div key={stepItem.task_id || idx} className="flex items-center justify-between text-xs py-1 px-2 rounded bg-white/5 border border-white/5">
                  <div className="flex items-center gap-2 truncate">
                    <span className="text-[10px] font-mono text-violet-400">Step {stepItem.step_index || idx + 1}:</span>
                    <span className="text-gray-200 truncate">{stepItem.title}</span>
                  </div>
                  <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-950/60 text-amber-300 border border-amber-800/40 shrink-0 ml-2">
                    [QUEUED]
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Negotiation price comparison chart */}
        {renderType === 'negotiation_progress' && (
          <NegotiationProgressCard
            originalPrice={(logPayload as any).original_price}
            targetPrice={(logPayload as any).target_price}
            counterPrice={(logPayload as any).counter_price}
            round={(logPayload as any).round ?? 1}
            savings={(logPayload as any).savings ?? 0}
          />
        )}

        {/* Wallet Balance Card */}
        {renderType === 'wallet_card' && (
          <WalletCard
            connected={Boolean(logPayload.connected)}
            walletPublicKey={logPayload.wallet_public_key}
            solBalance={logPayload.sol_balance}
            usdcBalance={logPayload.usdc_balance}
            warning={logPayload.warning}
            onNavigate={onNavigate}
          />
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
    <div className="w-7 h-7 rounded-full bg-indigo-100 dark:bg-indigo-950/60 flex items-center justify-center shrink-0 mt-0.5">
      <Zap className="w-3.5 h-3.5 text-indigo-600 dark:text-indigo-400" />
    </div>
  )
}

function ServiceResultCard({ service, onRequest }: { service: any; onRequest: () => void }) {
  const [requested, setRequested] = useState(false)
  const priceDisplay =
    service.price_display ||
    (service.price && Number(service.price) > 0
      ? `₦${Number(service.price).toLocaleString()}`
      : 'Negotiable')

  return (
    <div className="flex items-center justify-between gap-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 shadow-sm">
      <div className="min-w-0">
        <p className="font-medium text-sm truncate">{service.title}</p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <p className="text-xs text-indigo-600 dark:text-indigo-400 font-semibold">{priceDisplay}</p>
          {service.distance_km != null && (
            <span className="text-[11px] text-gray-400 font-mono">
              {Number(service.distance_km).toFixed(1)} km
            </span>
          )}
          {service.outside_radius && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-950/40 text-amber-400 border border-amber-800/40 font-semibold">
              [OUTSIDE RADIUS]
            </span>
          )}
        </div>
        {service.provider_name && (
          <p className="text-[11px] text-gray-400 mt-0.5">by {service.provider_name}</p>
        )}
        {service.description && (
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{service.description}</p>
        )}
      </div>
      <Button
        size="sm"
        disabled={requested}
        className={`shrink-0 text-white text-xs h-7 px-2.5 transition-colors ${
          requested
            ? 'bg-gray-400 dark:bg-gray-700 text-gray-200 cursor-not-allowed'
            : 'bg-indigo-600 hover:bg-indigo-700'
        }`}
        onClick={() => {
          setRequested(true)
          onRequest()
        }}
      >
        {requested ? 'Requested' : 'Request'}
      </Button>
    </div>
  )
}

function JobResultCard({ job, onNavigate, onApply }: { job: any; onNavigate: (path: string) => void; onApply?: () => void }) {
  const [applied, setApplied] = useState(false)
  const priceDisplay =
    job.price_display ||
    (job.price && Number(job.price) > 0
      ? `₦${Number(job.price).toLocaleString()}`
      : 'Negotiable')

  return (
    <div className="flex items-center justify-between gap-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-3 py-2.5 shadow-sm">
      <div className="min-w-0">
        <p className="font-medium text-sm truncate">{job.title}</p>
        <div className="flex items-center gap-2 mt-0.5 flex-wrap">
          <p className="text-xs text-emerald-600 font-semibold">{priceDisplay}</p>
          {job.distance_km != null && (
            <span className="text-[11px] text-gray-400 font-mono">
              {Number(job.distance_km).toFixed(1)} km
            </span>
          )}
          {job.outside_radius && (
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-amber-950/40 text-amber-400 border border-amber-800/40 font-semibold">
              [OUTSIDE RADIUS]
            </span>
          )}
        </div>
        {job.client_name && (
          <p className="text-[11px] text-gray-400 mt-0.5">posted by {job.client_name}</p>
        )}
        {job.description && (
          <p className="text-xs text-gray-500 mt-0.5 line-clamp-1">{job.description}</p>
        )}
      </div>
      <div className="flex gap-1 shrink-0">
        <Button size="sm" variant="outline" className="text-xs h-7 px-2.5 gap-1"
          onClick={() => onNavigate(`/dashboard/jobs?jobId=${job.id}`)}>
          View <ChevronRight className="w-3 h-3" />
        </Button>
        {onApply && (
          <Button
            size="sm"
            disabled={applied}
            className={`text-white text-xs h-7 px-2.5 transition-colors ${
              applied
                ? 'bg-gray-400 dark:bg-gray-700 text-gray-200 cursor-not-allowed'
                : 'bg-emerald-600 hover:bg-emerald-700'
            }`}
            onClick={() => {
              setApplied(true)
              onApply()
            }}
          >
            {applied ? 'Applied' : 'Apply'}
          </Button>
        )}
      </div>
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
                ? 'bg-indigo-600 text-white border-indigo-600'
                : isCancel
                  ? 'border-gray-300 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
                  : 'border-indigo-300 text-indigo-700 hover:bg-indigo-50 dark:border-indigo-700 dark:text-indigo-400 dark:hover:bg-indigo-950/30',
              selected && !isSelected && 'opacity-40 cursor-not-allowed'
            )}
          >
            {isSelected && <Check className="inline w-3 h-3 mr-1 -mt-0.5" />}
            {opt.label}
          </button>
        )
      })}
    </div>
  )
}

function EmptyState({ onChipClick }: { onChipClick: (text: string) => void }) {
  const chips = [
    'Find a reliable plumber nearby',
    'What is my wallet balance?',
    'I need someone for house cleaning',
    'Show open jobs',
  ]
  return (
    <div className="flex flex-col items-center justify-center h-full text-center py-10 px-4">
      <RobotWaitingIllustration className="w-36 h-36 mb-3" />
      <p className="font-semibold text-gray-900 dark:text-gray-100 mb-1">Gigidy AI</p>
      <p className="text-sm text-gray-500 mb-6 max-w-xs">
        I can find verified service providers nearby, search open gigs, check your wallet balance, or help you negotiate prices.
      </p>
      <div className="flex flex-col gap-2 w-full max-w-xs">
        {chips.map((chip) => (
          <button
            key={chip}
            onClick={() => onChipClick(chip)}
            className="text-sm text-left bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-xl px-4 py-2.5 hover:border-indigo-400 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition-colors text-gray-700 dark:text-gray-300"
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
