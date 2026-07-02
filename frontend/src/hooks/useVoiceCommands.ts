import { useState, useCallback, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import api from '@/lib/api'

type CommandHandler = (transcript: string) => Promise<string | null>

interface VoiceCommand {
  pattern: RegExp
  handler: CommandHandler
  description: string
}

export function useVoiceCommands() {
  const navigate = useNavigate()
  const [isListening, setIsListening] = useState(false)
  const [transcript, setTranscript] = useState('')
  const [aiResponse, setAiResponse] = useState<string | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const recognitionRef = useRef<any>(null)
  const synthRef = useRef<SpeechSynthesis | null>(null)

  // Initialize speech synthesis
  useEffect(() => {
    synthRef.current = window.speechSynthesis
  }, [])

  // Speak response aloud
  const speak = useCallback((text: string) => {
    if (!synthRef.current) return
    synthRef.current.cancel()
    const utterance = new SpeechSynthesisUtterance(text)
    utterance.rate = 1.0
    utterance.pitch = 1.0
    utterance.volume = 1.0
    synthRef.current.speak(utterance)
  }, [])

  // ─── Command definitions ──────────────────────────────────────
  const commands: VoiceCommand[] = [
    // Navigation
    {
      pattern: /go to (home|dashboard|jobs|services|messages|activity|disputes|profile)/i,
      handler: async (t) => {
        const page = t.match(/go to (.+)/i)?.[1]?.toLowerCase()
        const routes: Record<string, string> = {
          home: '/dashboard',
          dashboard: '/dashboard',
          jobs: '/dashboard/jobs',
          services: '/dashboard/services',
          messages: '/dashboard/messages',
          activity: '/dashboard/activity',
          disputes: '/dashboard/disputes',
          profile: '/dashboard/profile',
        }
        const route = routes[page || '']
        if (route) {
          navigate(route)
          return `Navigating to ${page}`
        }
        return null
      },
      description: 'Navigate to a page (e.g. "go to jobs")',
    },

    // Find a service provider (e.g. "find someone to fix my car for no more than 50k")
    {
      pattern: /find (someone|a|an) (to )?(.+?)( for no more than| for under| for less than| under| for max| max| for at most| budget of)?\s*(\d+[kK]?)?$/i,
      handler: async (t) => {
        const match = t.match(/find (someone|a|an) (to )?(.+?)( for no more than| for under| for less than| under| for max| max| for at most| budget of)?\s*(\d+[kK]?)?$/i)
        if (!match) return null
        const service = match[3]?.trim() || ''
        let maxPrice = match[5] || ''
        
        // Convert k to thousands
        if (maxPrice.toLowerCase().includes('k')) {
          maxPrice = String(parseFloat(maxPrice) * 1000)
        }

        // Navigate to services with search params
        navigate(`/dashboard/services?search=${encodeURIComponent(service)}${maxPrice ? `&maxPrice=${maxPrice}` : ''}`)
        
        let response = `Searching for ${service}`
        if (maxPrice) {
          response += ` with a maximum price of ₦${parseInt(maxPrice).toLocaleString()}`
        }
        return response
      },
      description: 'Find a service provider (e.g. "find someone to fix my car for no more than 50k")',
    },

    // Post a job
    {
      pattern: /post (a |an )?job (called |titled |for )?(.+?)( for | at | price )?(\d+[kK]?)?$/i,
      handler: async (t) => {
        const match = t.match(/post (a |an )?job (called |titled |for )?(.+?)( for | at | price )?(\d+[kK]?)?$/i)
        if (!match) return null
        const title = match[3]?.trim() || ''
        let price = match[5] || ''
        
        if (price.toLowerCase().includes('k')) {
          price = String(parseFloat(price) * 1000)
        }

        if (!title || !price) {
          return 'Please provide both a job title and a price. For example: "post a job called fix my car for 50000"'
        }

        try {
          await api.post('/jobs/', {
            title,
            description: `Posted via voice command: ${title}`,
            price,
          })
          navigate('/dashboard/jobs')
          return `Job "${title}" posted for ₦${parseInt(price).toLocaleString()}`
        } catch (err: any) {
          return `Failed to post job: ${err.response?.data?.detail || 'Unknown error'}`
        }
      },
      description: 'Post a new job (e.g. "post a job called fix my car for 50000")',
    },

    // Send a message (navigate to messages)
    {
      pattern: /send (a )?message (to |about )?(.+)/i,
      handler: async () => {
        navigate('/dashboard/messages')
        return 'Opening messages. Select a conversation to send a message.'
      },
      description: 'Navigate to messages',
    },

    // Check my jobs
    {
      pattern: /(show|check|what are) (my )?(active|open|current)?\s*jobs/i,
      handler: async () => {
        navigate('/dashboard/jobs?tab=mine')
        return 'Showing your jobs'
      },
      description: 'Show your jobs',
    },

    // Find work / open jobs
    {
      pattern: /(find|show|browse) (open )?(work|jobs)/i,
      handler: async () => {
        navigate('/dashboard/jobs?tab=open')
        return 'Showing open jobs'
      },
      description: 'Browse open jobs',
    },

    // Help
    {
      pattern: /(what can you do|help|commands|what do you do)/i,
      handler: async () => {
        const helpText = `I can help you with:
1. Navigation - say "go to jobs" or "go to messages"
2. Find a service - say "find someone to fix my car for no more than 50k"
3. Post a job - say "post a job called fix my car for 50000"
4. Check your jobs - say "show my jobs"
5. Browse work - say "find work"
6. Send messages - say "send a message"
Try saying any of these commands!`
        return helpText
      },
      description: 'Show available commands',
    },

    // Generic search fallback
    {
      pattern: /(search|look for|find) (.+)/i,
      handler: async (t) => {
        const match = t.match(/(search|look for|find) (.+)/i)
        const query = match?.[2]?.trim() || ''
        navigate(`/dashboard/services?search=${encodeURIComponent(query)}`)
        return `Searching for ${query}`
      },
      description: 'Search for anything',
    },
  ]

  // ─── Process voice command ────────────────────────────────────
  const processCommand = useCallback(async (text: string) => {
    setIsProcessing(true)
    setAiResponse(null)

    try {
      // Try to match a command
      for (const cmd of commands) {
        const match = text.match(cmd.pattern)
        if (match) {
          const response = await cmd.handler(text)
          if (response) {
            setAiResponse(response)
            speak(response)
            toast.success(response.split('\n')[0])
            setIsProcessing(false)
            return
          }
        }
      }

      // No command matched - try AI-powered interpretation via backend
      try {
        const { data } = await api.post('/ai/interpret-command', { text })
        if (data?.action) {
          const { action, params } = data
          switch (action) {
            case 'navigate':
              navigate(params.route)
              setAiResponse(data.response)
              speak(data.response)
              toast.success(data.response)
              break
            case 'search':
              navigate(`/dashboard/services?search=${encodeURIComponent(params.query)}`)
              setAiResponse(data.response)
              speak(data.response)
              toast.success(data.response)
              break
            case 'post_job':
              navigate('/dashboard/jobs')
              setAiResponse(data.response)
              speak(data.response)
              toast.success(data.response)
              break
            default:
              setAiResponse(data.response || 'Command received')
              speak(data.response || 'Command received')
              toast.success(data.response || 'Command received')
          }
        } else {
          const fallback = `I heard: "${text}". Try saying "help" to see what I can do.`
          setAiResponse(fallback)
          speak(fallback)
        }
      } catch {
        // Backend AI not available, use local fallback
        const fallback = `I heard: "${text}". Try saying "help" to see what I can do, or "find someone to fix my car for no more than 50k".`
        setAiResponse(fallback)
        speak(fallback)
      }
    } finally {
      setIsProcessing(false)
    }
  }, [navigate, speak, commands])

  // ─── Start listening ──────────────────────────────────────────
  const startListening = useCallback(() => {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      toast.error('Voice recognition is not supported in this browser. Try Chrome or Edge.')
      return
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    const recognition = new SpeechRecognition()
    recognition.continuous = false
    recognition.interimResults = true
    recognition.lang = 'en-US'

    recognition.onresult = (event: any) => {
      const current = event.resultIndex
      const transcriptText = event.results[current][0].transcript
      setTranscript(transcriptText)

      if (event.results[current].isFinal) {
        processCommand(transcriptText)
      }
    }

    recognition.onerror = (event: any) => {
      console.error('Speech recognition error:', event.error)
      setIsListening(false)
      if (event.error === 'not-allowed') {
        toast.error('Microphone access denied. Please allow microphone access.')
      } else if (event.error === 'no-speech') {
        toast.error('No speech detected. Please try again.')
      }
    }

    recognition.onend = () => {
      setIsListening(false)
    }

    recognitionRef.current = recognition
    recognition.start()
    setIsListening(true)
    setTranscript('')
    setAiResponse(null)
  }, [processCommand])

  // ─── Stop listening ───────────────────────────────────────────
  const stopListening = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop()
      recognitionRef.current = null
    }
    setIsListening(false)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop()
      }
      if (synthRef.current) {
        synthRef.current.cancel()
      }
    }
  }, [])

  return {
    isListening,
    transcript,
    aiResponse,
    isProcessing,
    startListening,
    stopListening,
    speak,
  }
}