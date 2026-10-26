/**
 * VoiceAssistant.tsx — Floating push-to-talk mic and companion popup for Gigidy AI.
 *
 * Tap-to-speak flow:
 * - Tapping the mic button opens the companion speech popup on the side and starts listening immediately.
 * - Live speech transcripts stream in real-time inside the companion card.
 * - Auto-submits on speech completion (silence debounce or onend).
 * - Opens the AgentActivityPanel with the agent's progress and actions.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Mic, Loader2, X, Send } from 'lucide-react'
import { useAgentStore } from '@/store/agentStore'
import { toast } from 'sonner'
import { motion, AnimatePresence } from 'framer-motion'
import { agentAudio } from '@/lib/agentAudio'

export default function VoiceAssistant() {
  const { aiSettings, submitCommand, openPanel } = useAgentStore()

  const [isOpen, setIsOpen] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [typedCommand, setTypedCommand] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)

  const recognitionRef = useRef<any>(null)
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const speechBufferRef = useRef<string>('')

  const stopListening = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current)
      silenceTimerRef.current = null
    }
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch {
        /* already stopped */
      }
      recognitionRef.current = null
    }
    setIsListening(false)
    agentAudio.stopSonarPulse()
  }, [])

  const handleSubmit = useCallback(async (spokenSpeech: string) => {
    const cleanSpeech = spokenSpeech.trim()
    if (!cleanSpeech) return

    stopListening()
    setIsProcessing(true)

    try {
      const task = await submitCommand(cleanSpeech)
      if (task) {
        setIsOpen(false)
        openPanel()
        if (aiSettings.soundEnabled) {
          agentAudio.playSuccessChime()
        }
        toast.success(`[OK] Gigidy AI: ${cleanSpeech.slice(0, 50)}`)
      }
    } catch {
      toast.error('Failed to send command to Gigidy AI')
    } finally {
      setIsProcessing(false)
      setTranscript('')
      setTypedCommand('')
      speechBufferRef.current = ''
    }
  }, [openPanel, submitCommand, aiSettings.soundEnabled, stopListening])

  const startListening = useCallback(() => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      toast.error('Voice recognition is not supported in this browser.')
      return
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    const recognition = new SpeechRecognition()
    recognition.continuous = true
    recognition.interimResults = true
    recognition.lang = aiSettings.voiceLanguage || 'en-US'

    recognition.onresult = (event: any) => {
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
        setTranscript(activeSpeech)
        speechBufferRef.current = activeSpeech

        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current)
        }
        silenceTimerRef.current = setTimeout(() => {
          if (speechBufferRef.current) {
            handleSubmit(speechBufferRef.current)
          }
        }, 1200)
      }
    }

    recognition.onerror = (event: any) => {
      console.warn('[voice] Speech recognition error:', event.error)
      stopListening()
      if (event.error === 'not-allowed') {
        toast.error('Microphone access denied. Enable permissions in your browser.')
      }
    }

    recognition.onend = () => {
      setIsListening(false)
      agentAudio.stopSonarPulse()
      if (speechBufferRef.current) {
        handleSubmit(speechBufferRef.current)
      }
    }

    recognitionRef.current = recognition
    recognition.start()
    setIsListening(true)
    setTranscript('')
    speechBufferRef.current = ''

    if (aiSettings.soundEnabled) {
      agentAudio.playSonarPulse()
    }
  }, [aiSettings.voiceLanguage, aiSettings.soundEnabled, handleSubmit, stopListening])

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        try { recognitionRef.current.stop() } catch {}
      }
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current)
      }
      agentAudio.stopSonarPulse()
    }
  }, [])

  if (!aiSettings.voiceEnabled) return null

  const handleMicToggle = () => {
    if (isListening) {
      if (speechBufferRef.current.trim()) {
        handleSubmit(speechBufferRef.current)
      } else {
        stopListening()
        setIsOpen(false)
      }
    } else {
      setIsOpen(true)
      startListening()
    }
  }

  const handleClose = () => {
    stopListening()
    setIsOpen(false)
    setTranscript('')
    setTypedCommand('')
    speechBufferRef.current = ''
  }

  return (
    <>
      {/* Floating draggable mic button */}
      <motion.div
        drag
        dragMomentum={false}
        whileDrag={{ scale: 1.08 }}
        className="fixed bottom-20 right-4 md:bottom-6 md:right-6 z-[9999] w-14 h-14 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none select-none"
      >
        {/* Active recording sonar ring */}
        {isListening && (
          <>
            <span className="absolute inset-0 rounded-full bg-red-500/40 animate-ping pointer-events-none" />
            <span
              className="absolute -inset-2 rounded-full border border-red-500/50 animate-ping pointer-events-none"
              style={{ animationDuration: '2s', animationDelay: '0.3s' }}
            />
          </>
        )}

        <motion.button
          type="button"
          whileTap={{ scale: 0.94 }}
          whileHover={{ scale: 1.06 }}
          onClick={handleMicToggle}
          className={`relative w-14 h-14 rounded-full shadow-2xl flex items-center justify-center transition-all duration-300 pointer-events-auto ${
            isListening
              ? 'bg-red-600 text-white shadow-red-500/50 ring-4 ring-red-500/30'
              : 'bg-black text-white hover:bg-gray-900 dark:hover:bg-card border border-white/10 shadow-xl'
          }`}
          title={isListening ? (transcript ? `"${transcript}" — Click to send` : 'Listening... Click to send') : 'Gigidy AI — Tap to speak (Drag anywhere)'}
          aria-label={isListening ? 'Stop recording voice command' : 'Start recording voice command'}
        >
          {isProcessing ? (
            <Loader2 className="w-6 h-6 animate-spin text-white" />
          ) : (
            <Mic className={`w-6 h-6 text-white ${isListening ? 'animate-pulse' : ''}`} />
          )}
        </motion.button>
      </motion.div>

      {/* Speech Companion Popup Panel on the side */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.92, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.92, y: 12 }}
            transition={{ duration: 0.18 }}
            className="fixed bottom-36 right-4 md:bottom-24 md:right-6 z-[9999] w-84 max-w-[calc(100vw-2rem)]"
          >
            <div className="bg-white dark:bg-background rounded-2xl shadow-2xl border border-gray-200 dark:border-border overflow-hidden">
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-100 dark:border-border bg-gray-50/80 dark:bg-card/80">
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${isListening ? 'bg-red-500 animate-pulse' : 'bg-emerald-500'}`} />
                  <span className="text-xs font-semibold tracking-tight text-gray-900 dark:text-foreground">
                    Gigidy AI
                  </span>
                  <span className="text-[10px] font-mono text-gray-400">
                    {isListening ? '[LISTENING]' : isProcessing ? '[PROCESSING]' : '[READY]'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleClose}
                  className="p-1 rounded-lg text-gray-400 hover:text-gray-600 dark:hover:text-foreground hover:bg-gray-100 dark:hover:bg-muted transition-colors"
                  aria-label="Close assistant"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Live speech typing display */}
              <div className="p-4 min-h-[96px] flex flex-col justify-center">
                {isProcessing ? (
                  <div className="flex items-center justify-center gap-2 py-4 text-gray-700 dark:text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin text-gray-900 dark:text-foreground" />
                    <span className="text-xs font-medium">Processing command...</span>
                  </div>
                ) : transcript ? (
                  <div className="text-xs text-gray-900 dark:text-foreground font-medium leading-relaxed bg-gray-50 dark:bg-card p-3 rounded-xl border border-gray-200 dark:border-border">
                    "{transcript}"
                  </div>
                ) : isListening ? (
                  <div className="flex flex-col items-center justify-center gap-2 py-2">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                      <span className="w-2 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                      <span className="w-2 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                    </div>
                    <span className="text-xs text-gray-500 dark:text-muted-foreground">Listening to your voice... speak now</span>
                  </div>
                ) : (
                  <p className="text-xs text-gray-400 text-center py-2">
                    Tap the mic to speak, or type your request below.
                  </p>
                )}
              </div>

              {/* Text input fallback */}
              <form
                onSubmit={(e) => {
                  e.preventDefault()
                  if (typedCommand.trim()) handleSubmit(typedCommand)
                }}
                className="p-2.5 pt-0 flex gap-1.5 items-center"
              >
                <input
                  type="text"
                  value={typedCommand}
                  onChange={(e) => setTypedCommand(e.target.value)}
                  placeholder="Or type a command..."
                  disabled={isProcessing}
                  className="flex-1 text-xs bg-gray-100 dark:bg-card border border-gray-200 dark:border-border rounded-xl px-3 py-2 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder:text-muted-foreground/80 focus:outline-none focus:ring-1 focus:ring-gray-400 dark:focus:ring-border"
                />
                <button
                  type="submit"
                  disabled={!typedCommand.trim() || isProcessing}
                  className="h-8 w-8 rounded-xl bg-black hover:bg-gray-800 dark:hover:bg-muted text-white flex items-center justify-center shrink-0 disabled:opacity-40 transition-colors"
                  title="Send"
                >
                  <Send className="w-3.5 h-3.5" />
                </button>
              </form>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}