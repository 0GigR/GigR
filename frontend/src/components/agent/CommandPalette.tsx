/**
 * CommandPalette.tsx — Centered command palette and spotlight search for the AI Agent OS.
 *
 * Provides a keyboard-first (Cmd+K / Ctrl+K), voice-enabled command terminal
 * with real-time suggestions, recent agent activities, and direct dispatch to
 * the autonomous agent execution loop.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import {
  Sparkles,
  Mic,
  MicOff,
  CornerDownLeft,
  X,
  Search,
  Wrench,
  Briefcase,
  Compass,
  Clock,
  ArrowRight,
  Loader2,
} from 'lucide-react'
import { useAgentStore, type AgentTask } from '@/store/agentStore'
import { isFeatureEnabled } from '@/lib/featureFlags'
import { toast } from 'sonner'

interface SuggestedAction {
  id: string
  title: string
  category: 'Service' | 'Job' | 'Navigation' | 'Task'
  icon: React.ComponentType<{ className?: string }>
  commandText: string
}

const PRESET_ACTIONS: SuggestedAction[] = [
  {
    id: 'preset-plumber',
    title: 'Find licensed plumber in Lagos',
    category: 'Service',
    icon: Wrench,
    commandText: 'Find a licensed plumber in Lagos under 15,000 NGN',
  },
  {
    id: 'preset-generator',
    title: 'Find generator repair technician',
    category: 'Service',
    icon: Wrench,
    commandText: 'Find a generator repair technician nearby',
  },
  {
    id: 'preset-post-cleaning',
    title: 'Post job for residential cleaning',
    category: 'Job',
    icon: Briefcase,
    commandText: 'Post a job for residential apartment cleaning for 20,000 NGN',
  },
  {
    id: 'preset-browse-jobs',
    title: 'Explore open gigs on map',
    category: 'Navigation',
    icon: Compass,
    commandText: 'Explore open gigs near my coordinates',
  },
]

export default function CommandPalette(): React.ReactElement | null {
  const isPaletteFeatureActive = isFeatureEnabled('commandPalette')
  const {
    isPaletteOpen,
    closePalette,
    submitCommand,
    openPanel,
    tasks,
    aiSettings,
  } = useAgentStore()

  const [queryText, setQueryText] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isListening, setIsListening] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submissionFeedback, setSubmissionFeedback] = useState<string | null>(null)

  const inputElementRef = useRef<HTMLInputElement>(null)
  const speechRecognitionRef = useRef<any>(null)
  const listContainerRef = useRef<HTMLDivElement>(null)

  // Listen for global Cmd+K / Ctrl+K shortcut
  useEffect(() => {
    if (!isPaletteFeatureActive) return

    const onGlobalKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        const store = useAgentStore.getState()
        if (store.isPaletteOpen) {
          store.closePalette()
        } else {
          store.openPalette()
        }
      }
    }

    window.addEventListener('keydown', onGlobalKeyDown)
    return () => window.removeEventListener('keydown', onGlobalKeyDown)
  }, [isPaletteFeatureActive])

  // Focus input on palette open
  useEffect(() => {
    if (isPaletteOpen) {
      setQueryText('')
      setSelectedIndex(0)
      setSubmissionFeedback(null)
      const focusTimer = setTimeout(() => {
        inputElementRef.current?.focus()
      }, 50)
      return () => clearTimeout(focusTimer)
    } else {
      if (speechRecognitionRef.current) {
        speechRecognitionRef.current.stop()
        speechRecognitionRef.current = null
      }
      setIsListening(false)
    }
  }, [isPaletteOpen])

  // Voice speech-to-text recognition
  const toggleSpeechRecognition = useCallback(() => {
    if (isListening) {
      if (speechRecognitionRef.current) {
        speechRecognitionRef.current.stop()
        speechRecognitionRef.current = null
      }
      setIsListening(false)
      return
    }

    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      toast.error('Voice recognition is not supported in this browser environment.')
      return
    }

    const SpeechRecognitionConstructor =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    const recognitionInstance = new SpeechRecognitionConstructor()
    recognitionInstance.continuous = false
    recognitionInstance.interimResults = true
    recognitionInstance.lang = aiSettings.voiceLanguage || 'en-US'

    recognitionInstance.onresult = (event: any) => {
      const resultIndex = event.resultIndex
      const spokenTranscript = event.results[resultIndex][0].transcript
      setQueryText(spokenTranscript)

      if (event.results[resultIndex].isFinal) {
        setIsListening(false)
      }
    }

    recognitionInstance.onerror = (recognitionErrorEvent: any) => {
      setIsListening(false)
      if (recognitionErrorEvent.error === 'not-allowed') {
        toast.error('Microphone access was denied. Enable microphone permissions to use voice commands.')
      }
    }

    recognitionInstance.onend = () => {
      setIsListening(false)
    }

    speechRecognitionRef.current = recognitionInstance
    recognitionInstance.start()
    setIsListening(true)
  }, [isListening, aiSettings.voiceLanguage])

  // Derive visible action list: presets + recent tasks matching query
  const trimmedQuery = queryText.trim().toLowerCase()

  const matchedPresets: SuggestedAction[] = PRESET_ACTIONS.filter(
    (preset) =>
      !trimmedQuery ||
      preset.title.toLowerCase().includes(trimmedQuery) ||
      preset.commandText.toLowerCase().includes(trimmedQuery)
  )

  const recentTaskActions: SuggestedAction[] = (tasks || [])
    .slice(0, 5)
    .filter((taskItem: AgentTask) => Boolean(taskItem.command_text))
    .filter(
      (taskItem: AgentTask) =>
        !trimmedQuery || taskItem.command_text.toLowerCase().includes(trimmedQuery)
    )
    .map((taskItem: AgentTask) => ({
      id: `task-${taskItem.id}`,
      title: taskItem.command_text,
      category: 'Task',
      icon: Clock,
      commandText: taskItem.command_text,
    }))

  const combinedActionList: SuggestedAction[] = [
    ...matchedPresets,
    ...recentTaskActions,
  ]

  // Submit command to agent store
  const executeCommand = async (commandToRun: string) => {
    const sanitizedCommand = commandToRun.trim()
    if (!sanitizedCommand || isSubmitting) return

    setIsSubmitting(true)
    if (speechRecognitionRef.current) {
      speechRecognitionRef.current.stop()
      speechRecognitionRef.current = null
      setIsListening(false)
    }

    try {
      const createdTask = await submitCommand(sanitizedCommand)
      if (createdTask) {
        setSubmissionFeedback('Command received by AI agent. Opening activity feed...')
        setTimeout(() => {
          closePalette()
          openPanel()
        }, 600)
      } else {
        toast.error('Could not send command to AI agent. Please check your network connection and retry.')
      }
    } catch {
      toast.error('Could not dispatch command to AI agent. Please try again in a few moments.')
    } finally {
      setIsSubmitting(false)
    }
  }

  // Keyboard navigation within the palette
  const onPaletteKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closePalette()
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      if (combinedActionList.length === 0) return
      setSelectedIndex((prevIndex) => (prevIndex + 1) % combinedActionList.length)
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      if (combinedActionList.length === 0) return
      setSelectedIndex(
        (prevIndex) => (prevIndex - 1 + combinedActionList.length) % combinedActionList.length
      )
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      if (combinedActionList.length > 0 && selectedIndex < combinedActionList.length) {
        executeCommand(combinedActionList[selectedIndex].commandText)
      } else if (trimmedQuery) {
        executeCommand(queryText)
      }
    }
  }

  if (!isPaletteFeatureActive || !isPaletteOpen) {
    return null
  }

  return (
    <AnimatePresence>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Agent Command Center"
        className="fixed inset-0 z-[10000] flex items-start justify-center p-4 sm:p-6 md:p-10"
      >
        {/* Backdrop blur with fade animation */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={closePalette}
          className="fixed inset-0 bg-black/70 backdrop-blur-md"
        />

        {/* Modal Window */}
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: -16 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: -16 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="relative w-full max-w-2xl mt-12 md:mt-20 rounded-2xl bg-gray-950/95 border border-white/10 shadow-[0_20px_50px_rgba(0,0,0,0.8),0_0_30px_rgba(139,92,246,0.15)] overflow-hidden flex flex-col max-h-[80vh]"
        >
          {/* Top Search & Voice Command Bar */}
          <div className="relative flex items-center px-4 py-3.5 border-b border-white/10 bg-gray-900/40">
            <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-violet-600/20 text-violet-400 mr-3 border border-violet-500/30">
              <Sparkles className="w-4 h-4 animate-pulse" />
            </div>

            <div className="relative flex-1 flex items-center">
              <input
                ref={inputElementRef}
                type="text"
                value={queryText}
                maxLength={2000}
                onChange={(event) => {
                  setQueryText(event.target.value)
                  setSelectedIndex(0)
                }}
                onKeyDown={onPaletteKeyDown}
                placeholder="Type a command or speak to the AI agent..."
                disabled={isSubmitting}
                className="w-full bg-transparent text-sm md:text-base text-white placeholder-gray-400 focus:outline-none pr-8"
              />
              {queryText && (
                <button
                  type="button"
                  onClick={() => {
                    setQueryText('')
                    inputElementRef.current?.focus()
                  }}
                  className="p-1 rounded-md text-gray-400 hover:text-white hover:bg-white/10 transition-colors mr-1"
                  title="Clear input"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Voice Input Waveform / Mic Trigger */}
            <div className="flex items-center gap-2 pl-2">
              {isListening ? (
                <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-red-500/20 border border-red-500/40 text-red-300 text-xs">
                  {/* Waveform indicator */}
                  <div className="flex items-center gap-0.5 h-3">
                    <span className="w-0.5 h-2 bg-red-400 animate-pulse rounded-full" />
                    <span className="w-0.5 h-3.5 bg-red-400 animate-pulse delay-75 rounded-full" />
                    <span className="w-0.5 h-1.5 bg-red-400 animate-pulse delay-150 rounded-full" />
                  </div>
                  <span className="font-mono text-[11px]">Listening</span>
                  <button
                    type="button"
                    onClick={toggleSpeechRecognition}
                    className="ml-1 p-0.5 hover:text-white"
                  >
                    <MicOff className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={toggleSpeechRecognition}
                  className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                  title="Speak command"
                >
                  <Mic className="w-4 h-4" />
                </button>
              )}

              {/* Close Button */}
              <button
                type="button"
                onClick={closePalette}
                className="p-1.5 rounded-lg text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
                title="Close palette"
              >
                <kbd className="hidden sm:inline-block px-1.5 py-0.5 text-[10px] font-mono text-gray-400 bg-white/5 border border-white/10 rounded">
                  ESC
                </kbd>
                <X className="w-4 h-4 sm:hidden" />
              </button>
            </div>
          </div>

          {/* Submission Feedback Banner */}
          {submissionFeedback && (
            <div className="px-4 py-2.5 bg-violet-950/60 border-b border-violet-500/30 text-xs text-violet-300 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-violet-400" />
              <span>{submissionFeedback}</span>
            </div>
          )}

          {/* Action List & Results */}
          <div
            ref={listContainerRef}
            className="flex-1 overflow-y-auto divide-y divide-white/5 p-2 space-y-1"
          >
            {combinedActionList.length > 0 ? (
              combinedActionList.map((actionItem, itemIndex) => {
                const isSelected = itemIndex === selectedIndex
                const ActionIcon = actionItem.icon

                return (
                  <button
                    key={actionItem.id}
                    type="button"
                    onClick={() => executeCommand(actionItem.commandText)}
                    onMouseEnter={() => setSelectedIndex(itemIndex)}
                    className={`w-full flex items-center justify-between px-3.5 py-2.5 rounded-xl text-left transition-all duration-150 ${
                      isSelected
                        ? 'bg-violet-600/20 text-white border border-violet-500/30 shadow-inner'
                        : 'text-gray-300 hover:bg-white/5 border border-transparent'
                    }`}
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <div
                        className={`p-2 rounded-lg ${
                          isSelected
                            ? 'bg-violet-600 text-white'
                            : 'bg-white/5 text-gray-400'
                        }`}
                      >
                        <ActionIcon className="w-4 h-4" />
                      </div>
                      <div className="truncate">
                        <p className="text-sm font-medium truncate text-white">
                          {actionItem.title}
                        </p>
                        <p className="text-xs text-gray-400 truncate">
                          {actionItem.commandText}
                        </p>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 pl-3 shrink-0">
                      <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded bg-white/5 text-gray-400 border border-white/5">
                        {actionItem.category}
                      </span>
                      {isSelected && (
                        <ArrowRight className="w-3.5 h-3.5 text-violet-400" />
                      )}
                    </div>
                  </button>
                )
              })
            ) : trimmedQuery ? (
              /* Custom Command Prompt when no preset matches */
              <div className="p-6 text-center space-y-3">
                <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-violet-600/10 border border-violet-500/20 text-violet-400">
                  <Search className="w-5 h-5" />
                </div>
                <div>
                  <h4 className="text-sm font-semibold text-white">
                    Execute custom agent instruction
                  </h4>
                  <p className="text-xs text-gray-400 mt-1 max-w-sm mx-auto">
                    No saved action matches this query. Press Enter or click below to let the AI agent execute this custom command.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => executeCommand(queryText)}
                  disabled={isSubmitting}
                  className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-xs font-medium transition-colors shadow-lg shadow-violet-600/30"
                >
                  <span>Execute with AI Agent</span>
                  <CornerDownLeft className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              /* Defined empty state when no tasks or queries exist */
              <div className="p-6 text-center space-y-2">
                <p className="text-xs text-gray-400">
                  Agent activity history is empty. Type a command above to begin your first automated workflow.
                </p>
              </div>
            )}
          </div>

          {/* Palette Footer Status */}
          <div className="px-4 py-2.5 bg-gray-900/60 border-t border-white/5 flex items-center justify-between text-[11px] text-gray-400">
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 font-mono text-[10px]">
                  ↑
                </kbd>
                <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 font-mono text-[10px]">
                  ↓
                </kbd>
                <span className="text-gray-400">Navigate</span>
              </span>
              <span className="flex items-center gap-1">
                <kbd className="px-1.5 py-0.5 rounded bg-white/5 border border-white/10 font-mono text-[10px]">
                  ↵
                </kbd>
                <span className="text-gray-400">Select</span>
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-gray-300 font-mono text-[10px]">Agent OS Ready</span>
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  )
}
