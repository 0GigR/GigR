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
import { motion, AnimatePresence, useAnimationControls, useMotionValue, useSpring, useTransform, type MotionValue } from 'framer-motion'
import { agentAudio } from '@/lib/agentAudio'

const BUTTON_RADIUS = 28
/** The body is fully stretched once it trails the pointer by this many pixels. */
const MAX_PULL = 56

/** A blob that lags behind the dragged button, so pulling leaves a tail of it behind. */
function TrailBlob({
  dragX,
  dragY,
  stiffness,
  size,
  colorClass,
}: {
  dragX: MotionValue<number>
  dragY: MotionValue<number>
  stiffness: number
  size: number
  colorClass: string
}) {
  const lx = useSpring(dragX, { stiffness, damping: 20, mass: 0.9 })
  const ly = useSpring(dragY, { stiffness, damping: 20, mass: 0.9 })
  const x = useTransform([lx, dragX] as const, ([a, b]: number[]) => a - b)
  const y = useTransform([ly, dragY] as const, ([a, b]: number[]) => a - b)
  return (
    <motion.span
      aria-hidden="true"
      className={`absolute inset-0 rounded-full transition-colors duration-300 ${colorClass}`}
      style={{ x, y, scale: size }}
    />
  )
}

export default function VoiceAssistant() {
  const { aiSettings, submitCommand, openPanel } = useAgentStore()

  const [isOpen, setIsOpen] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [typedCommand, setTypedCommand] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)

  // The body is a soft mass on a spring. How far that mass trails the pointer
  // sets the stretch along the pull and the squash across it. When the pointer
  // stops the mass overshoots, which is the wobble.
  const dragX = useMotionValue(0)
  const dragY = useMotionValue(0)
  const massX = useSpring(dragX, { stiffness: 340, damping: 15, mass: 0.7 })
  const massY = useSpring(dragY, { stiffness: 340, damping: 15, mass: 0.7 })
  const pullX = useTransform([massX, dragX] as const, ([m, d]: number[]) => m - d)
  const pullY = useTransform([massY, dragY] as const, ([m, d]: number[]) => m - d)
  const pullAmount = useTransform([pullX, pullY] as const, ([x, y]: number[]) =>
    Math.min(1, Math.hypot(x, y) / MAX_PULL),
  )
  // Below a pixel of pull the direction is noise, so hold the last one
  const lastAngleRef = useRef(0)
  const pullAngle = useTransform([pullX, pullY] as const, ([x, y]: number[]) => {
    if (Math.hypot(x, y) > 1) lastAngleRef.current = (Math.atan2(y, x) * 180) / Math.PI
    return lastAngleRef.current
  })
  const stretchX = useTransform(pullAmount, (a: number) => 1 + a * 0.8)
  const stretchY = useTransform(pullAmount, (a: number) => 1 - a * 0.34)
  // Slide the stretched body backward so its leading edge stays under the pointer
  const bodyX = useTransform([pullAmount, pullAngle] as const, ([a, deg]: number[]) => Math.cos((deg * Math.PI) / 180) * a * 0.8 * BUTTON_RADIUS)
  const bodyY = useTransform([pullAmount, pullAngle] as const, ([a, deg]: number[]) => Math.sin((deg * Math.PI) / 180) * a * 0.8 * BUTTON_RADIUS)
  const squash = useAnimationControls()
  const [isDragging, setIsDragging] = useState(false)
  const draggedRef = useRef(false)
  const [ripples, setRipples] = useState<number[]>([])

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

  const handleButtonClick = () => {
    if (draggedRef.current) return
    const id = Date.now()
    setRipples((prev) => [...prev, id])
    window.setTimeout(() => setRipples((prev) => prev.filter((r) => r !== id)), 650)
    handleMicToggle()
  }

  const handleClose = () => {
    stopListening()
    setIsOpen(false)
    setTranscript('')
    setTypedCommand('')
    speechBufferRef.current = ''
  }

  const bodyColor = isListening ? 'bg-red-600' : 'bg-black dark:bg-zinc-700'

  const pressSquash = () => {
    void squash.start({ scaleX: 1.14, scaleY: 0.84, transition: { type: 'spring', stiffness: 620, damping: 16 } })
  }
  const releaseSquash = () => {
    void squash.start({
      scaleX: [1.14, 0.9, 1.05, 0.98, 1],
      scaleY: [0.84, 1.12, 0.96, 1.02, 1],
      transition: { duration: 0.5, ease: 'easeOut' },
    })
  }

  return (
    <>
      {/* Floating draggable mic button. The visible body lives in a goo layer
          with its trail, so pulling it draws out one continuous stretchy shape. */}
      <motion.div
        drag
        dragMomentum={false}
        dragElastic={0.12}
        dragTransition={{ bounceStiffness: 500, bounceDamping: 24 }}
        style={{ x: dragX, y: dragY }}
        onPointerDown={pressSquash}
        onPointerUp={releaseSquash}
        onPointerCancel={releaseSquash}
        onDragStart={() => {
          draggedRef.current = true
          setIsDragging(true)
        }}
        onDragEnd={() => {
          setIsDragging(false)
          releaseSquash()
          // the click that follows pointer-up must not toggle the mic
          window.setTimeout(() => {
            draggedRef.current = false
          }, 80)
        }}
        className="fixed bottom-20 right-4 md:bottom-6 md:right-6 z-[9999] w-14 h-14 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none select-none"
      >
        <svg width="0" height="0" className="absolute" aria-hidden="true" focusable="false">
          <defs>
            <filter id="va-goo" filterUnits="userSpaceOnUse" x="-400" y="-400" width="900" height="900">
              <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="b" />
              <feColorMatrix in="b" mode="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 20 -9" />
            </filter>
          </defs>
        </svg>
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ filter: 'url(#va-goo) drop-shadow(0 8px 12px rgba(0,0,0,0.35))' }}
        >
          <TrailBlob dragX={dragX} dragY={dragY} stiffness={240} size={0.9} colorClass={bodyColor} />
          <TrailBlob dragX={dragX} dragY={dragY} stiffness={140} size={0.74} colorClass={bodyColor} />
          <TrailBlob dragX={dragX} dragY={dragY} stiffness={85} size={0.58} colorClass={bodyColor} />
          <TrailBlob dragX={dragX} dragY={dragY} stiffness={52} size={0.42} colorClass={bodyColor} />
          <motion.span className="absolute inset-0" animate={squash} initial={{ scaleX: 1, scaleY: 1 }}>
            {/* Rotation and stretch are separate elements: on one element the
                stretch would apply along the screen axes, not along the pull. */}
            <motion.span className="absolute inset-0" style={{ x: bodyX, y: bodyY, rotate: pullAngle }}>
              <motion.span
                aria-hidden="true"
                className={`absolute inset-0 rounded-full transition-colors duration-300 ${bodyColor}`}
                style={{ scaleX: stretchX, scaleY: stretchY }}
              />
            </motion.span>
          </motion.span>
        </div>

        {/* Idle breathing halo */}
        {!isListening && !isDragging && (
          <motion.span
            aria-hidden="true"
            className="absolute -inset-1 rounded-full border border-white/25 dark:border-white/20 pointer-events-none"
            animate={{ scale: [1, 1.22, 1], opacity: [0.5, 0, 0.5] }}
            transition={{ duration: 3.2, repeat: Infinity, ease: 'easeInOut' }}
          />
        )}

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

        {/* Tap ripples */}
        <AnimatePresence>
          {ripples.map((id) => (
            <motion.span
              key={id}
              aria-hidden="true"
              className="absolute inset-0 rounded-full border-2 border-white/70 pointer-events-none"
              initial={{ scale: 1, opacity: 0.8 }}
              animate={{ scale: 2.1, opacity: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
            />
          ))}
        </AnimatePresence>

        <motion.button
          type="button"
          whileHover={{ scale: 1.1 }}
          transition={{ type: 'spring', stiffness: 520, damping: 14 }}
          onClick={handleButtonClick}
          className={`relative w-14 h-14 rounded-full flex items-center justify-center pointer-events-auto text-white ${
            isListening ? 'ring-4 ring-red-500/30' : ''
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