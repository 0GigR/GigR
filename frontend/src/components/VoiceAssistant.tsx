import { useState, useEffect, useRef } from 'react'
import { Mic, MicOff, Loader2, X, Sparkles, Send, CheckCircle2 } from 'lucide-react'
import { useAgentStore } from '@/store/agentStore'
import { toast } from 'sonner'

export default function VoiceAssistant() {
  const { aiSettings, submitCommand, isPanelOpen } = useAgentStore()
  
  const [isOpen, setIsOpen] = useState(false)
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [textInput, setTextInput] = useState('')
  const [isProcessing, setIsProcessing] = useState(false)
  const [successMessage, setSuccessMessage] = useState<string | null>(null)
  
  const recognitionRef = useRef<any>(null)
  const successTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Don't render the floating button if the user disabled it in AI Settings
  // (unless the panel is open, in which case we might want to hide the whole popup anyway,
  // but let's just hide the trigger button if disabled).
  if (!aiSettings.voiceEnabled) return null

  // ─── Voice Recognition ───────────────────────────────────────────
  const startListening = () => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      toast.error('Voice recognition is not supported in this browser.')
      return
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = aiSettings.voiceLanguage || 'en-US'

    recognition.onresult = (event: any) => {
      const current = event.resultIndex
      const transcriptText = event.results[current][0].transcript
      setTranscript(transcriptText)

      if (event.results[current].isFinal) {
        handleSubmit(transcriptText)
      }
    }

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error)
      setIsListening(false)
      if (event.error === 'not-allowed') {
        toast.error('Microphone access denied.')
      }
    }

    recognition.onend = () => {
      setIsListening(false)
    }

    recognitionRef.current = recognition
    recognition.start()
    setIsListening(true)
    setTranscript('')
    setSuccessMessage(null)
  }

  const stopListening = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    setIsListening(false)
  }

  // ─── Command Submission ──────────────────────────────────────────
  const handleSubmit = async (text: string) => {
    if (!text.trim()) return
    
    setIsProcessing(true)
    stopListening() // stop listening while processing
    
    try {
      const task = await submitCommand(text.trim())
      if (task) {
        setSuccessMessage('Got it! Agent is on it — check your notifications.')
        setTextInput('')
        setTranscript('')
        
        // Auto-close after 3 seconds
        if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current)
        successTimeoutRef.current = setTimeout(() => {
          setIsOpen(false)
          setSuccessMessage(null)
        }, 3000)
      }
    } catch (err) {
      toast.error('Failed to submit command to agent')
    } finally {
      setIsProcessing(false)
    }
  }

  const handleToggle = () => {
    if (isListening) {
      stopListening()
      setIsOpen(false)
    } else {
      setIsOpen(true)
      startListening()
    }
  }

  const handleClose = () => {
    stopListening()
    setIsOpen(false)
    setSuccessMessage(null)
  }

  // Cleanup
  useEffect(() => {
    return () => {
      if (recognitionRef.current) recognitionRef.current.stop()
      if (successTimeoutRef.current) clearTimeout(successTimeoutRef.current)
    }
  }, [])

  // Hide popup if the big activity panel is open so they don't overlap
  if (isPanelOpen && isOpen) {
    handleClose()
  }

  return (
    <>
      {/* Floating mic button */}
      <button
        onClick={handleToggle}
        className={`fixed bottom-20 right-4 md:bottom-6 md:right-6 z-[9999] w-14 h-14 rounded-full shadow-xl flex items-center justify-center transition-all duration-300 ${
          isListening
            ? 'bg-red-500 text-white scale-110 animate-pulse shadow-red-500/50'
            : 'bg-black text-white hover:bg-gray-800 hover:scale-105'
        }`}
        title={isListening ? 'Stop listening' : 'Voice assistant'}
      >
        {isProcessing ? (
          <Loader2 className="w-6 h-6 animate-spin" />
        ) : isListening ? (
          <Mic className="w-6 h-6" />
        ) : (
          <MicOff className="w-6 h-6" />
        )}
      </button>

      {/* Assistant Popup Panel */}
      {isOpen && (
        <div className="fixed bottom-36 right-4 md:bottom-24 md:right-6 z-[9999] w-80 max-w-[calc(100vw-2rem)]">
          <div className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden animate-in slide-in-from-bottom-5">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800 bg-gray-50/50 dark:bg-gray-900/50">
              <div className="flex items-center gap-2 text-violet-600 dark:text-violet-400">
                <Sparkles className="w-4 h-4" />
                <span className="text-sm font-semibold">AI Agent</span>
              </div>
              <button
                onClick={handleClose}
                className="p-1 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-full transition-colors text-gray-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Content Body */}
            <div className="p-4 min-h-[120px] flex flex-col justify-center">
              
              {/* Success State */}
              {successMessage ? (
                <div className="text-center space-y-2 py-4 animate-in fade-in zoom-in duration-300">
                  <CheckCircle2 className="w-10 h-10 text-green-500 mx-auto" />
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
                    {successMessage}
                  </p>
                </div>
              ) : (
                <>
                  {/* Listening / Processing status */}
                  <div className="text-center mb-4 min-h-[40px]">
                    {isListening && !transcript ? (
                      <div className="flex flex-col items-center justify-center gap-2">
                        <div className="flex items-center gap-1.5">
                          <span className="w-2 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                          <span className="w-2 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                          <span className="w-2 h-2 bg-red-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                        </div>
                        <span className="text-xs text-gray-500 font-medium">Listening...</span>
                      </div>
                    ) : isProcessing ? (
                      <div className="flex items-center justify-center gap-2 text-violet-600 dark:text-violet-400">
                        <Loader2 className="w-5 h-5 animate-spin" />
                        <span className="text-xs font-medium">Processing command...</span>
                      </div>
                    ) : transcript ? (
                      <div className="text-sm text-gray-700 dark:text-gray-300 italic font-medium break-words">
                        "{transcript}"
                      </div>
                    ) : (
                      <div className="text-gray-500 dark:text-gray-400 text-sm text-center">
                        Speak a command or type it below.
                      </div>
                    )}
                  </div>

                  {/* Text Input */}
                  <form 
                    onSubmit={(e) => {
                      e.preventDefault()
                      handleSubmit(textInput)
                    }}
                    className="relative flex items-center"
                  >
                    <input
                      type="text"
                      value={textInput}
                      onChange={(e) => setTextInput(e.target.value)}
                      placeholder="e.g. Find a plumber for 5k"
                      disabled={isProcessing}
                      className="w-full text-sm bg-gray-100 dark:bg-gray-800 border-none rounded-xl py-3 pl-4 pr-12 focus:ring-2 focus:ring-violet-500 dark:text-white placeholder-gray-400"
                    />
                    <button
                      type="submit"
                      disabled={!textInput.trim() || isProcessing}
                      className="absolute right-2 p-1.5 bg-violet-600 text-white rounded-lg disabled:opacity-50 disabled:bg-gray-400 transition-colors"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </form>
                </>
              )}
            </div>

            {/* Quick Actions Footer */}
            {!successMessage && (
              <div className="px-4 py-3 bg-gray-50 dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800">
                <p className="text-[10px] uppercase font-semibold text-gray-400 tracking-wider mb-2">Try asking</p>
                <div className="flex flex-wrap gap-1.5">
                  {[
                    'Show open jobs',
                    'Find a mechanic under 20000',
                  ].map((cmd) => (
                    <button
                      key={cmd}
                      onClick={() => handleSubmit(cmd)}
                      className="text-[11px] px-2.5 py-1.5 rounded-lg bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:border-violet-300 hover:text-violet-600 dark:hover:border-violet-700 dark:hover:text-violet-400 transition-colors text-left"
                    >
                      "{cmd}"
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}