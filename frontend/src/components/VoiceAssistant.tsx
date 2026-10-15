/**
 * VoiceAssistant.tsx — Floating push-to-talk mic for Gigidy AI.
 *
 * Frictionless tap-to-speak:
 * - Single tap immediately starts audio capture via Web Speech API.
 * - Auto-submits to submitCommand as soon as speech finishes.
 * - Directly opens the AgentActivityPanel so interactive feedback lives in the panel.
 * - No modal overlays or command palettes popping up in front of the user.
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { Mic, Loader2 } from 'lucide-react'
import { useAgentStore } from '@/store/agentStore'
import { toast } from 'sonner'
import { motion } from 'framer-motion'
import { agentAudio } from '@/lib/agentAudio'

export default function VoiceAssistant() {
  const { aiSettings, submitCommand, openPanel } = useAgentStore()

  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
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

  const handleMicClick = () => {
    if (isListening) {
      if (speechBufferRef.current.trim()) {
        handleSubmit(speechBufferRef.current)
      } else {
        stopListening()
      }
    } else {
      startListening()
    }
  }

  return (
    <div className="fixed bottom-20 right-4 md:bottom-6 md:right-6 z-[9999] w-14 h-14 flex items-center justify-center pointer-events-none">
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
        onClick={handleMicClick}
        className={`pointer-events-auto relative w-14 h-14 rounded-full shadow-2xl flex items-center justify-center transition-all duration-300 ${
          isListening
            ? 'bg-red-600 text-white shadow-red-500/50 ring-4 ring-red-500/30'
            : 'bg-indigo-600 hover:bg-indigo-700 text-white border border-indigo-400/30 shadow-[0_4px_20px_rgba(79,70,229,0.35)]'
        }`}
        title={isListening ? (transcript ? `"${transcript}" — Click to send` : 'Listening to you... Click to send now') : 'Gigidy AI — Tap to speak'}
        aria-label={isListening ? 'Stop recording voice command' : 'Start recording voice command'}
      >
        {isProcessing ? (
          <Loader2 className="w-6 h-6 animate-spin text-white" />
        ) : (
          <Mic className={`w-6 h-6 text-white ${isListening ? 'animate-pulse' : ''}`} />
        )}
      </motion.button>
    </div>
  )
}