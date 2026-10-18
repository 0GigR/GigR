/**
 * MessagesPage.tsx — Full-screen Contract Rooms & Real-time Chat for Gigr.
 *
 * Provides real-time messaging, on-chain escrow status indicators,
 * contract terms overview, interactive scope amendment management,
 * and single-click contract finalisation / work submission.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import api, { extractError } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { PriceInput } from '@/components/PriceInput'
import { Skeleton } from '@/components/ui/skeleton'
import { processImageFile } from '@/lib/imageUtils'
import { motion } from 'framer-motion'
import { Textarea } from '@/components/ui/textarea'
import { useAuthStore } from '@/store/authStore'
import { useUnreadStore } from '@/store/unreadStore'
import OnlineIndicator from '@/components/OnlineIndicator'
import {
  MessageCircle,
  Send,
  ImagePlus,
  Loader2,
  X,
  Search,
  ShieldCheck,
  ExternalLink,
  ArrowLeft,
  CheckCircle,
} from 'lucide-react'
import type { components } from '@/types/api'
import { useWebSocketMessages } from '@/hooks/useWebSocketMessages'
import { ImageViewer } from '@/components/ImageViewer'
import ChatMessageContent from '@/components/ChatMessageContent'
import { cn } from '@/lib/utils'
import { useRail } from '@/lib/config'
import { startPayPalCheckout, redirectToPayPal } from '@/lib/paypal'

type Job = components['schemas']['JobOut']
type Message = components['schemas']['MessageOut']

interface CounterpartyUser {
  id: string
  display_name: string
  profile_image_url?: string | null
  last_seen_at?: string | null
}

async function uploadFile(file: File): Promise<string> {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
  const preset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET
  if (!cloudName || !preset) {
    throw new Error('Cloudinary not configured')
  }
  const formData = new FormData()
  formData.append('file', file)
  formData.append('upload_preset', preset)
  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: formData,
  })
  if (!response.ok) throw new Error('Image upload failed')
  const uploadJson = await response.json()
  return uploadJson.secure_url
}

function CounterpartyAvatar({ userId, size = 'md' }: { userId?: string | null; size?: 'sm' | 'md' | 'lg' }) {
  const { data: counterpartyUser } = useQuery<CounterpartyUser>({
    queryKey: ['counterparty-user', userId],
    queryFn: async () => {
      const response = await api.get(`/users/${userId}`)
      return response.data
    },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  })

  const initials = counterpartyUser?.display_name
    ? counterpartyUser.display_name.slice(0, 2).toUpperCase()
    : '?'

  const dim = size === 'sm' ? 'w-8 h-8 text-[11px]' : size === 'lg' ? 'w-11 h-11 text-sm' : 'w-10 h-10 text-xs'

  return (
    <div className="relative shrink-0">
      {counterpartyUser?.profile_image_url ? (
        <img
          src={counterpartyUser.profile_image_url}
          alt={counterpartyUser.display_name || 'User'}
          className={`${dim} rounded-full object-cover ring-1 ring-gray-200 dark:ring-gray-700`}
        />
      ) : (
        <span className={`${dim} rounded-full bg-gray-200 dark:bg-gray-800 text-gray-800 dark:text-gray-200 flex items-center justify-center font-bold ring-1 ring-gray-300 dark:ring-gray-700`}>
          {initials}
        </span>
      )}
      <OnlineIndicator lastSeenAt={counterpartyUser?.last_seen_at} className="absolute bottom-0 right-0" />
    </div>
  )
}

function CounterpartyLabel({ userId, fallback = 'Counterparty' }: { userId?: string | null; fallback?: string }) {
  const { data: counterpartyUser } = useQuery<CounterpartyUser>({
    queryKey: ['counterparty-user', userId],
    queryFn: async () => {
      const response = await api.get(`/users/${userId}`)
      return response.data
    },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  })

  return <span>{counterpartyUser?.display_name || fallback}</span>
}

export default function MessagesPage() {
  const { user } = useAuthStore()
  const { setMessageUnread, setMessagesPageActive } = useUnreadStore()
  const queryClient = useQueryClient()
  const navigate = useNavigate()

  useEffect(() => {
    setMessagesPageActive(true)
    return () => setMessagesPageActive(false)
  }, [setMessagesPageActive])

  const [selectedJob, setSelectedJob] = useState<Job | null>(null)
  const [messageText, setMessageText] = useState('')
  const [showScopeAmend, setShowScopeAmend] = useState(false)
  const [amendReason, setAmendReason] = useState('')
  const [amendNewPrice, setAmendNewPrice] = useState('')
  const [amendImage, setAmendImage] = useState<File | null>(null)
  const [amendImagePreview, setAmendImagePreview] = useState<string | null>(null)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'completed'>('all')

  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { data: myConversations, isLoading: jobsLoading } = useQuery<Job[]>({
    queryKey: ['myJobsForMessages'],
    queryFn: async () => {
      const response = await api.get('/jobs/my-conversations')
      return response.data
    },
  })

  const activeJobs = useMemo(() => {
    const rawList = myConversations || []
    const dedupedById = rawList.filter((jobItem, idx, arr) => arr.findIndex((x) => x.id === jobItem.id) === idx)
    const seenChats = new Set<string>()
    return dedupedById.filter((jobItem) => {
      const otherPartyId = jobItem.client_id === user?.id ? jobItem.provider_id : jobItem.client_id
      const chatKey = jobItem.service_listing_id
        ? `svc:${jobItem.service_listing_id}:${otherPartyId}`
        : `job:${jobItem.id}`
      if (seenChats.has(chatKey)) return false
      seenChats.add(chatKey)
      return true
    })
  }, [myConversations, user?.id])

  const [jobMeta, setJobMeta] = useState<Record<string, { lastCreatedAt: string; unreadCount: number }>>({})

  useEffect(() => {
    const totalCount = Object.values(jobMeta).reduce((sum, item) => sum + (item.unreadCount || 0), 0)
    setMessageUnread(totalCount)
  }, [jobMeta, setMessageUnread])

  const lastSelectedJobIdRef = useRef<string | null>(null)
  const [searchParams, setSearchParams] = useSearchParams()
  const deepLinkJobId = searchParams.get('jobId')

  useEffect(() => {
    if (!deepLinkJobId) return
    const clearParam = () => {
      const next = new URLSearchParams(searchParams)
      next.delete('jobId')
      setSearchParams(next, { replace: true })
    }
    const matchingJob = myConversations?.find((j) => j.id === deepLinkJobId)
    if (matchingJob) {
      setSelectedJob(matchingJob)
      setShowScopeAmend(false)
      clearParam()
    } else {
      api.get(`/jobs/${deepLinkJobId}`)
        .then((jobRes) => { setSelectedJob(jobRes.data); setShowScopeAmend(false) })
        .catch(() => {})
        .finally(clearParam)
    }
  }, [deepLinkJobId, myConversations, searchParams, setSearchParams])

  useEffect(() => {
    if (selectedJob?.id) {
      setJobMeta((prev) => {
        if (!prev[selectedJob.id] || prev[selectedJob.id].unreadCount === 0) return prev
        return {
          ...prev,
          [selectedJob.id]: {
            ...prev[selectedJob.id],
            unreadCount: 0,
          },
        }
      })
    }
  }, [selectedJob?.id])

  useEffect(() => {
    lastSelectedJobIdRef.current = selectedJob?.id || null
  }, [selectedJob?.id])

  const { data: initialMessages, isLoading: msgsLoading } = useQuery<Message[]>({
    queryKey: ['messages', selectedJob?.id],
    queryFn: async () => {
      const response = await api.get(`/messages/${selectedJob?.id}`)
      return response.data
    },
    enabled: !!selectedJob?.id,
  })

  const { data: amendmentsList } = useQuery({
    queryKey: ['amendments', selectedJob?.id],
    queryFn: async () => {
      const response = await api.get(`/amendments/${selectedJob?.id}`)
      return response.data
    },
    enabled: !!selectedJob?.id,
  })

  const [liveMessages, setLiveMessages] = useState<Message[]>([])

  useEffect(() => {
    if (initialMessages) {
      setLiveMessages(initialMessages)
    }
  }, [initialMessages])

  const handleNewMessage = useCallback((incomingMsg: Message) => {
    if (incomingMsg.job_id === lastSelectedJobIdRef.current) {
      setLiveMessages((prev) => {
        if (prev.some((m) => m.id === incomingMsg.id)) return prev
        return [...prev, incomingMsg]
      })
    }

    setJobMeta((prev) => {
      const currentMeta = prev[incomingMsg.job_id] || { lastCreatedAt: '', unreadCount: 0 }
      const isUnread = incomingMsg.job_id !== lastSelectedJobIdRef.current
      return {
        ...prev,
        [incomingMsg.job_id]: {
          lastCreatedAt: incomingMsg.created_at,
          unreadCount: currentMeta.unreadCount + (isUnread ? 1 : 0),
        },
      }
    })
  }, [])

  const allJobIdsKey = activeJobs.map((j) => j.id).sort().join(',')
  const allJobIds = useMemo(
    () => (allJobIdsKey ? allJobIdsKey.split(',') : []),
    [allJobIdsKey]
  )

  useWebSocketMessages({
    jobIds: allJobIds,
    onNewMessage: handleNewMessage,
    enabled: allJobIds.length > 0,
  })

  const messagesEndRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [liveMessages])

  const filteredJobs = useMemo(() => {
    let result = activeJobs
    if (statusFilter === 'active') {
      result = result.filter((j) => !['completed', 'cancelled'].includes(j.status))
    } else if (statusFilter === 'completed') {
      result = result.filter((j) => ['completed', 'cancelled'].includes(j.status))
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      result = result.filter((j) => j.title.toLowerCase().includes(q))
    }
    return result
  }, [activeJobs, statusFilter, searchQuery])

  const sendTextMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post('/messages', {
        job_id: selectedJob?.id,
        content: messageText.trim(),
      })
      return response.data
    },
    onSuccess: (newMsg) => {
      setMessageText('')
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
      setLiveMessages((prev) => [...prev, newMsg])
      queryClient.invalidateQueries({ queryKey: ['myJobsForMessages'] })
    },
    onError: (err: any) =>
      toast.error(extractError(err, 'Failed to send message')),
  })

  const sendImageMutation = useMutation({
    mutationFn: async ({ file, caption }: { file: File; caption?: string }) => {
      const uploadedUrl = await uploadFile(file)
      const response = await api.post('/messages', {
        job_id: selectedJob?.id,
        content: caption?.trim() || '[IMAGE ATTACHMENT]',
        image_url: uploadedUrl,
      })
      return response.data
    },
    onSuccess: (newMsg) => {
      setImageFile(null)
      setImagePreview(null)
      setMessageText('')
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto'
      }
      setLiveMessages((prev) => [...prev, newMsg])
      queryClient.invalidateQueries({ queryKey: ['myJobsForMessages'] })
    },
    onError: (err: any) =>
      toast.error(extractError(err, 'Failed to send image')),
  })

  const scopeAmendMutation = useMutation({
    mutationFn: async () => {
      let proofUrl: string | null = null
      if (amendImage) {
        proofUrl = await uploadFile(amendImage)
      }
      await api.post('/amendments', {
        job_id: selectedJob?.id,
        reason: amendReason,
        new_total_price: amendNewPrice,
        additional_cost: '0',
        image_url: proofUrl,
      })
    },
    onSuccess: () => {
      toast.success('Scope amendment proposed')
      queryClient.invalidateQueries({ queryKey: ['amendments', selectedJob?.id] })
      setShowScopeAmend(false)
      setAmendReason('')
      setAmendNewPrice('')
      setAmendImage(null)
      setAmendImagePreview(null)
    },
    onError: (err: any) =>
      toast.error(extractError(err, 'Amendment failed')),
  })

  const decideAmendmentMutation = useMutation({
    mutationFn: async ({ amendmentId, accept }: { amendmentId: string; accept: boolean }) => {
      await api.post(`/amendments/${amendmentId}/accept`, { accept })
    },
    onSuccess: (_, variables) => {
      toast.success(variables.accept ? '[OK] Amendment accepted' : '[OK] Amendment rejected')
      queryClient.invalidateQueries({ queryKey: ['amendments', selectedJob?.id] })
      queryClient.invalidateQueries({ queryKey: ['myJobsForMessages'] })
      if (selectedJob?.id) {
        api.get(`/jobs/${selectedJob.id}`).then((jobRes) => setSelectedJob(jobRes.data)).catch(() => {})
      }
    },
    onError: (err: any) =>
      toast.error(extractError(err, 'Action failed')),
  })

  const submitWorkMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post(`/jobs/${jobId}/submit-work`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myJobsForMessages'] })
      if (selectedJob?.id) {
        api.get(`/jobs/${selectedJob.id}`).then((jobRes) => setSelectedJob(jobRes.data)).catch(() => {})
      }
      toast.success('[OK] Work submitted. The client has been notified to inspect and release payment.')
    },
    onError: (err: any) => toast.error(extractError(err, 'Failed to submit work')),
  })

  const releasePaymentMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post(`/jobs/${jobId}/release`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myJobsForMessages'] })
      if (selectedJob?.id) {
        api.get(`/jobs/${selectedJob.id}`).then((jobRes) => setSelectedJob(jobRes.data)).catch(() => {})
      }
      toast.success('[OK] Escrow payment released to provider!')
    },
    onError: (err: any) => toast.error(extractError(err, 'Failed to release payment')),
  })

  // Which rail funds escrow: PayPal approval redirect, or the on-chain Solana call.
  const { isPayPal } = useRail()

  const fundEscrowMutation = useMutation({
    mutationFn: async (jobId: string) => {
      if (isPayPal) {
        // The client approves on PayPal, then returns to /dashboard/paypal/return
        // where the order is captured into escrow.
        return { checkout: await startPayPalCheckout(jobId) }
      }
      await api.post(`/jobs/${jobId}/fund`)
      return { checkout: null }
    },
    onSuccess: (res) => {
      if (res?.checkout) {
        toast.success('Opening PayPal to approve your payment…')
        redirectToPayPal(res.checkout)
        return
      }
      queryClient.invalidateQueries({ queryKey: ['myJobsForMessages'] })
      if (selectedJob?.id) {
        api.get(`/jobs/${selectedJob.id}`).then((jobRes) => setSelectedJob(jobRes.data)).catch(() => {})
      }
      toast.success('[OK] Escrow funded on Solana!')
    },
    onError: (err: any) => toast.error(extractError(err, 'Failed to fund escrow')),
  })

  const handleSendMessage = () => {
    if (imageFile && imagePreview) {
      sendImageMutation.mutate({ file: imageFile, caption: messageText })
      return
    }
    if (!messageText.trim()) return
    sendTextMutation.mutate()
  }

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawFile = e.target.files?.[0]
    if (rawFile) {
      const processed = await processImageFile(rawFile)
      setImageFile(processed)
      setImagePreview(URL.createObjectURL(processed))
      setMessageText('')
    }
    e.target.value = ''
  }

  const removeImage = () => {
    setImageFile(null)
    setImagePreview(null)
    setMessageText('')
  }

  const isSending = sendTextMutation.isPending || sendImageMutation.isPending

  const counterpartyId = selectedJob
    ? selectedJob.client_id === user?.id
      ? selectedJob.provider_id
      : selectedJob.client_id
    : null

  const isClient = selectedJob ? selectedJob.client_id === user?.id : false

  const renderStatusBadge = (jobStatus: string) => {
    const base = 'text-[10px] font-mono font-semibold px-2 py-0.5 rounded tracking-wider uppercase'
    switch (jobStatus) {
      case 'open':
        return <span className={`${base} bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300`}>[OPEN]</span>
      case 'assigned':
        return <span className={`${base} bg-gray-200 text-gray-800 dark:bg-gray-700 dark:text-gray-200`}>[ASSIGNED]</span>
      case 'funded':
        return <span className={`${base} bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300`}>[FUNDED]</span>
      case 'in_progress':
        return <span className={`${base} bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300`}>[IN PROGRESS]</span>
      case 'submitted':
        return <span className={`${base} bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300`}>[SUBMITTED]</span>
      case 'completed':
        return <span className={`${base} bg-black text-white dark:bg-white dark:text-black`}>[COMPLETED]</span>
      case 'cancelled':
        return <span className={`${base} bg-red-100 text-red-700 dark:bg-red-950/60 dark:text-red-300`}>[CANCELLED]</span>
      default:
        return <span className={`${base} bg-gray-100 text-gray-600`}>[{jobStatus}]</span>
    }
  }

  return (
    <div className="h-[calc(100vh-5.5rem)] flex flex-col animate-in fade-in duration-200">
      <div className="flex-1 grid lg:grid-cols-12 gap-4 min-h-0">
        {/* Left Sidebar: Contract rooms list */}
        <div
          className={cn(
            'lg:col-span-4 flex flex-col rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden shadow-xs h-full min-h-0',
            selectedJob ? 'hidden lg:flex' : 'flex'
          )}
        >
          {/* Search & filter toolbar */}
          <div className="p-3 border-b border-gray-100 dark:border-gray-800 space-y-2 shrink-0">
            <div className="flex items-center justify-between">
              <h1 className="text-base font-bold text-gray-900 dark:text-gray-100">
                Messages
              </h1>
              <span className="text-[10px] font-mono text-gray-500">
                {activeJobs.length} rooms
              </span>
            </div>
            <div className="relative">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search rooms..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 h-8 text-xs rounded-xl bg-gray-50 dark:bg-gray-950 border border-gray-200 dark:border-gray-800 text-gray-900 dark:text-gray-100 placeholder-gray-400 focus:outline-none focus:ring-1 focus:ring-gray-400"
              />
            </div>
            <div className="flex gap-1">
              {(['all', 'active', 'completed'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setStatusFilter(mode)}
                  className={cn(
                    'flex-1 py-1 text-[11px] font-medium rounded-lg capitalize transition-colors',
                    statusFilter === mode
                      ? 'bg-black text-white dark:bg-white dark:text-black font-semibold'
                      : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* List of rooms */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 divide-y divide-transparent min-h-0">
            {jobsLoading ? (
              <div className="space-y-2 p-2">
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-16 w-full rounded-xl" />
                <Skeleton className="h-16 w-full rounded-xl" />
              </div>
            ) : filteredJobs.length === 0 ? (
              <div className="py-12 text-center text-xs text-gray-400">
                No contract rooms found.
              </div>
            ) : (
              filteredJobs.map((job) => {
                const currentMeta = jobMeta[job.id]
                const unreadCount = currentMeta?.unreadCount ?? 0
                const isSelected = selectedJob?.id === job.id
                const otherPartyId = job.client_id === user?.id ? job.provider_id : job.client_id

                return (
                  <button
                    key={job.id}
                    type="button"
                    onClick={() => {
                      setSelectedJob(job)
                      setShowScopeAmend(false)
                    }}
                    className={cn(
                      'w-full text-left rounded-xl p-3 flex gap-3 items-center transition-all duration-150',
                      isSelected
                        ? 'bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-700 shadow-xs'
                        : 'border border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/60'
                    )}
                  >
                    {/* Counterparty actual avatar */}
                    <CounterpartyAvatar userId={otherPartyId} size="md" />

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <p className={cn('text-xs truncate', unreadCount > 0 ? 'font-bold text-gray-900 dark:text-gray-100' : 'font-medium text-gray-800 dark:text-gray-200')}>
                          <CounterpartyLabel userId={otherPartyId} fallback={job.title} />
                        </p>
                        {currentMeta?.lastCreatedAt && (
                          <span className="text-[10px] font-mono text-gray-400 shrink-0">
                            {new Date(currentMeta.lastCreatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </div>

                      <p className="text-[11px] text-gray-500 truncate mt-0.5">
                        {job.title}
                      </p>

                      <div className="flex items-center justify-between gap-1 mt-1">
                        <span className="text-[11px] font-mono font-semibold text-gray-900 dark:text-gray-100">
                          ₦{Number(job.price).toLocaleString()}
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {renderStatusBadge(job.status)}
                          {unreadCount > 0 && (
                            <span className="min-w-[18px] h-4 px-1 text-[10px] font-bold text-white bg-black dark:bg-white dark:text-black rounded-full flex items-center justify-center">
                              {unreadCount}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </div>

        {/* Right Area: Active Contract Room & Chat */}
        <div
          className={cn(
            'lg:col-span-8 flex flex-col rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden shadow-xs h-full min-h-0',
            selectedJob ? 'flex' : 'hidden lg:flex'
          )}
        >
          {!selectedJob ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <div className="w-16 h-16 rounded-2xl bg-gray-100 dark:bg-gray-800 text-gray-500 flex items-center justify-center mb-3">
                <MessageCircle className="w-8 h-8" />
              </div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                No Contract Room Selected
              </h2>
              <p className="text-xs text-gray-500 max-w-sm mt-1">
                Choose a conversation from the left to enter its contract room, review escrow terms, or message your counterparty.
              </p>
            </div>
          ) : (
            <>
              {/* Executive Contract Room Header */}
              <div className="border-b border-gray-200 dark:border-gray-800 p-3.5 bg-gray-50/70 dark:bg-gray-950/70 shrink-0 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Back button for mobile navigation */}
                    <button
                      type="button"
                      onClick={() => setSelectedJob(null)}
                      className="lg:hidden p-1.5 -ml-1 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-800 rounded-lg flex items-center gap-1 text-xs font-semibold"
                      aria-label="Back to conversations list"
                    >
                      <ArrowLeft className="w-4 h-4" />
                      Back
                    </button>

                    {/* Counterparty avatar & details */}
                    <CounterpartyAvatar userId={counterpartyId} size="lg" />

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="text-sm font-bold text-gray-900 dark:text-gray-100 truncate">
                          <CounterpartyLabel userId={counterpartyId} fallback="Counterparty" />
                        </h2>
                        <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-gray-200 dark:bg-gray-800 text-gray-700 dark:text-gray-300 font-semibold">
                          [{isClient ? 'FREELANCER' : 'CLIENT'}]
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 truncate mt-0.5">
                        {selectedJob.title} · <span className="font-mono font-semibold text-gray-900 dark:text-gray-100">₦{Number(selectedJob.price).toLocaleString()}</span>
                      </p>
                    </div>
                  </div>

                  {/* Action buttons (Finish / Submit Work, Release, Fund) */}
                  <div className="flex items-center gap-2">
                    {/* Provider: Finish / Submit Work */}
                    {!isClient && (selectedJob.status === 'funded' || selectedJob.status === 'in_progress') && (
                      <Button
                        size="sm"
                        onClick={() => submitWorkMutation.mutate(selectedJob.id)}
                        disabled={submitWorkMutation.isPending}
                        className="bg-black hover:bg-gray-800 text-white font-mono text-xs h-8 px-3 rounded-xl shadow-xs"
                      >
                        {submitWorkMutation.isPending ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                        ) : (
                          <CheckCircle className="w-3.5 h-3.5 mr-1 text-emerald-400" />
                        )}
                        [FINISH / SUBMIT WORK]
                      </Button>
                    )}

                    {/* Client: Accept & Release payment */}
                    {isClient && selectedJob.status === 'submitted' && (
                      <Button
                        size="sm"
                        onClick={() => releasePaymentMutation.mutate(selectedJob.id)}
                        disabled={releasePaymentMutation.isPending}
                        className="bg-emerald-600 hover:bg-emerald-700 text-white font-mono text-xs h-8 px-3 rounded-xl shadow-xs"
                      >
                        {releasePaymentMutation.isPending ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                        ) : (
                          <CheckCircle className="w-3.5 h-3.5 mr-1" />
                        )}
                        [ACCEPT & RELEASE PAYMENT]
                      </Button>
                    )}

                    {/* Client: Fund escrow */}
                    {isClient && (selectedJob.status === 'open' || selectedJob.status === 'assigned') && (
                      <Button
                        size="sm"
                        onClick={() => fundEscrowMutation.mutate(selectedJob.id)}
                        disabled={fundEscrowMutation.isPending}
                        className="bg-black hover:bg-gray-800 text-white font-mono text-xs h-8 px-3 rounded-xl shadow-xs"
                      >
                        {fundEscrowMutation.isPending ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" />
                        ) : (
                          <ShieldCheck className="w-3.5 h-3.5 mr-1 text-emerald-400" />
                        )}
                        [FUND ESCROW]
                      </Button>
                    )}

                    {renderStatusBadge(selectedJob.status)}
                  </div>
                </div>

                {/* Sub-bar: Escrow status & quick links */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-gray-200 dark:border-gray-800 text-xs">
                  <div className="flex items-center gap-2">
                    {selectedJob.status === 'funded' ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                        <ShieldCheck className="w-3.5 h-3.5" /> {isPayPal ? '[ESCROW FUNDED · HELD IN PAYPAL]' : '[ESCROW FUNDED · SECURED ON SOLANA]'}
                      </span>
                    ) : selectedJob.status === 'in_progress' ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                        <ShieldCheck className="w-3.5 h-3.5" /> [IN PROGRESS · ESCROW LOCKED]
                      </span>
                    ) : selectedJob.status === 'submitted' ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-amber-600 dark:text-amber-400 font-semibold">
                        [WORK SUBMITTED · READY FOR CLIENT APPROVAL]
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-gray-500">
                        [ESCROW PENDING FUNDING]
                      </span>
                    )}

                    {selectedJob.escrow_address && (
                      <span className="text-[10px] font-mono text-gray-400">
                        ({selectedJob.escrow_address.slice(0, 6)}...{selectedJob.escrow_address.slice(-4)})
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => navigate(`/dashboard/jobs?jobId=${selectedJob.id}`)}
                      className="inline-flex items-center gap-1 text-[11px] font-mono text-gray-700 dark:text-gray-300 hover:text-black dark:hover:text-white"
                    >
                      [VIEW GIG] <ExternalLink className="w-3 h-3" />
                    </button>
                    {!['completed', 'cancelled'].includes(selectedJob.status) && (
                      <button
                        type="button"
                        onClick={() => setShowScopeAmend(!showScopeAmend)}
                        className="inline-flex items-center gap-1 text-[11px] font-mono text-gray-700 dark:text-gray-300 hover:text-black dark:hover:text-white"
                      >
                        [PROPOSE AMENDMENT]
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Chat Message Stream */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-white dark:bg-gray-950 min-h-0">
                {msgsLoading ? (
                  <div className="space-y-3">
                    <Skeleton className="h-14 w-2/3 ml-auto rounded-2xl" />
                    <Skeleton className="h-14 w-2/3 rounded-2xl" />
                    <Skeleton className="h-14 w-1/2 ml-auto rounded-2xl" />
                  </div>
                ) : liveMessages?.length ? (
                  liveMessages.map((msg, index) => {
                    const isCurrentUser = msg.sender_id === user?.id
                    const nextMsg = liveMessages[index + 1]
                    const isLastInGroup = !nextMsg || nextMsg.sender_id !== msg.sender_id

                    return (
                      <motion.div
                        key={msg.id}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.15 }}
                        className={cn(
                          'flex gap-2.5',
                          isCurrentUser ? 'justify-end' : 'justify-start',
                          isLastInGroup ? 'mb-3' : 'mb-1'
                        )}
                      >
                        {/* Avatar for counterparty messages */}
                        {!isCurrentUser && (
                          <div className="w-7 shrink-0 flex items-end">
                            {isLastInGroup && (
                              <CounterpartyAvatar userId={msg.sender_id} size="sm" />
                            )}
                          </div>
                        )}

                        <div className={cn('flex flex-col', isCurrentUser ? 'items-end' : 'items-start', 'max-w-[76%]')}>
                          <div
                            className={cn(
                              'px-4 py-2.5 text-xs sm:text-sm shadow-xs break-words',
                              isCurrentUser
                                ? 'bg-black text-white dark:bg-white dark:text-black rounded-2xl rounded-br-sm'
                                : 'bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700 rounded-2xl rounded-bl-sm'
                            )}
                          >
                            <ChatMessageContent
                              content={msg.content}
                              imageUrl={msg.image_url}
                              onImageClick={setLightboxSrc}
                            />
                            <div className="flex justify-end items-center gap-1.5 mt-1 text-[10px] opacity-70">
                              <span>
                                {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                              {isCurrentUser && (
                                <span className="font-mono text-[9px]">[SENT]</span>
                              )}
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    )
                  })
                ) : (
                  <div className="py-12 text-center text-xs text-gray-400">
                    No messages yet in this room. Send the first message below.
                  </div>
                )}

                {/* Scope Amendments Cards */}
                {amendmentsList?.map((amendmentItem: any) => {
                  const currentJobPrice = Number(selectedJob.price)
                  const proposedPrice = Number(amendmentItem.new_total_price)
                  const priceDifference = proposedPrice - currentJobPrice
                  const isPending = amendmentItem.is_accepted === null

                  return (
                    <div key={amendmentItem.id} className="flex justify-center my-3">
                      <div className="w-full max-w-lg rounded-2xl border border-gray-300 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 p-4 space-y-3 shadow-xs">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-mono font-bold text-gray-900 dark:text-gray-100 tracking-wider">
                            [SCOPE AMENDMENT PROPOSAL]
                          </span>
                          <span
                            className={cn(
                              'text-[10px] font-mono px-2 py-0.5 rounded font-semibold',
                              isPending
                                ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300'
                                : amendmentItem.is_accepted
                                ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-300'
                                : 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300'
                            )}
                          >
                            {isPending ? '[PENDING APPROVAL]' : amendmentItem.is_accepted ? '[ACCEPTED]' : '[DECLINED]'}
                          </span>
                        </div>

                        <p className="text-xs text-gray-700 dark:text-gray-300 leading-relaxed">
                          {amendmentItem.reason}
                        </p>

                        <div className="flex items-center justify-between p-2.5 rounded-xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 text-xs">
                          <div>
                            <span className="text-[10px] text-gray-400 block font-mono">Current Price</span>
                            <span className="font-mono font-semibold text-gray-800 dark:text-gray-200">
                              ₦{currentJobPrice.toLocaleString()}
                            </span>
                          </div>
                          <div className="text-right">
                            <span className="text-[10px] text-gray-400 block font-mono">Proposed Price</span>
                            <span className="font-mono font-bold text-gray-900 dark:text-gray-100">
                              ₦{proposedPrice.toLocaleString()}
                              <span className="text-[10px] text-gray-500 ml-1">
                                ({priceDifference >= 0 ? `+₦${priceDifference.toLocaleString()}` : `-₦${Math.abs(priceDifference).toLocaleString()}`})
                              </span>
                            </span>
                          </div>
                        </div>

                        {amendmentItem.image_url && (
                          <div>
                            <span className="text-[10px] text-gray-400 block mb-1">Attached Proof:</span>
                            <img
                              src={amendmentItem.image_url}
                              alt="Amendment proof"
                              className="w-20 h-20 rounded-xl object-cover cursor-pointer ring-1 ring-gray-200 dark:ring-gray-700 hover:opacity-90"
                              onClick={() => setLightboxSrc(amendmentItem.image_url)}
                            />
                          </div>
                        )}

                        {isPending && isClient && (
                          <div className="flex gap-2 pt-1 border-t border-gray-200 dark:border-gray-700">
                            <Button
                              size="sm"
                              onClick={() => decideAmendmentMutation.mutate({ amendmentId: amendmentItem.id, accept: true })}
                              disabled={decideAmendmentMutation.isPending}
                              className="flex-1 bg-black hover:bg-gray-800 text-white text-xs h-8 font-mono"
                            >
                              [ACCEPT AMENDMENT]
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => decideAmendmentMutation.mutate({ amendmentId: amendmentItem.id, accept: false })}
                              disabled={decideAmendmentMutation.isPending}
                              className="text-xs h-8 font-mono text-red-600 hover:text-red-700"
                            >
                              [DECLINE]
                            </Button>
                          </div>
                        )}
                      </div>
                    </div>
                  )
                })}
                <div ref={messagesEndRef} />
              </div>

              {/* Bottom Input Area */}
              {showScopeAmend ? (
                <div className="border-t border-gray-200 dark:border-gray-800 p-4 bg-gray-50 dark:bg-gray-900 space-y-3 shrink-0">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold font-mono text-gray-900 dark:text-gray-100">
                      [PROPOSE CONTRACT AMENDMENT]
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowScopeAmend(false)}
                      className="text-gray-400 hover:text-gray-600"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  <Textarea
                    placeholder="Specify the reason for modifying the scope or price..."
                    value={amendReason}
                    onChange={(e) => setAmendReason(e.target.value)}
                    className="text-xs rounded-xl bg-white dark:bg-gray-950 border-gray-200 dark:border-gray-800"
                  />
                  <PriceInput
                    placeholder="New total contract price (₦)"
                    value={amendNewPrice}
                    onChange={setAmendNewPrice}
                  />
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="text-xs h-8"
                        onClick={() => document.getElementById('contractAmendImage')?.click()}
                      >
                        <ImagePlus className="w-3.5 h-3.5 mr-1" /> Attach Proof
                      </Button>
                      <input
                        id="contractAmendImage"
                        type="file"
                        accept="image/*, .heic, .heif, .webp"
                        className="hidden"
                        onChange={async (e) => {
                          const rawSelected = e.target.files?.[0]
                          if (rawSelected) {
                            const processed = await processImageFile(rawSelected)
                            setAmendImage(processed)
                            setAmendImagePreview(URL.createObjectURL(processed))
                          }
                        }}
                      />
                      {amendImagePreview && (
                        <img
                          src={amendImagePreview}
                          alt=""
                          className="w-8 h-8 rounded-md object-cover ring-1 ring-gray-300"
                        />
                      )}
                    </div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setShowScopeAmend(false)}
                        className="text-xs h-8"
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => scopeAmendMutation.mutate()}
                        disabled={!amendReason.trim() || !amendNewPrice || scopeAmendMutation.isPending}
                        className="bg-black hover:bg-gray-800 text-white text-xs h-8 font-mono"
                      >
                        {scopeAmendMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '[SUBMIT PROPOSAL]'}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : imagePreview ? (
                <div className="border-t border-gray-200 dark:border-gray-800 p-3 flex gap-2 items-center bg-white dark:bg-gray-950 shrink-0">
                  <img src={imagePreview} alt="Preview" className="w-12 h-12 rounded-xl object-cover shrink-0 ring-1 ring-gray-300" />
                  <textarea
                    ref={textareaRef}
                    rows={1}
                    placeholder="Add a caption..."
                    value={messageText}
                    onChange={(e) => {
                      setMessageText(e.target.value)
                      e.target.style.height = 'auto'
                      e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !isSending) {
                        e.preventDefault()
                        handleSendMessage()
                      }
                    }}
                    className="flex-1 text-xs rounded-xl bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-2.5 resize-none outline-none max-h-32"
                    autoFocus
                  />
                  <Button
                    size="sm"
                    onClick={handleSendMessage}
                    disabled={isSending}
                    className="bg-black hover:bg-gray-800 text-white h-9 px-3 rounded-xl shrink-0"
                  >
                    {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={removeImage} className="h-9 w-9 p-0 rounded-xl shrink-0">
                    <X className="w-4 h-4 text-gray-500" />
                  </Button>
                </div>
              ) : (
                <div className="border-t border-gray-200 dark:border-gray-800 p-3 flex gap-2 items-end bg-white dark:bg-gray-950 shrink-0">
                  <label className="cursor-pointer p-2 rounded-xl text-gray-500 hover:text-black dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors shrink-0">
                    <ImagePlus className="w-5 h-5" />
                    <input
                      type="file"
                      accept="image/*, .heic, .heif, .webp"
                      className="hidden"
                      onChange={handleImageSelect}
                    />
                  </label>
                  <textarea
                    ref={textareaRef}
                    rows={1}
                    placeholder="Type a message..."
                    value={messageText}
                    onChange={(e) => {
                      setMessageText(e.target.value)
                      e.target.style.height = 'auto'
                      e.target.style.height = `${Math.min(e.target.scrollHeight, 128)}px`
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey && !isSending) {
                        e.preventDefault()
                        handleSendMessage()
                      }
                    }}
                    className="flex-1 text-xs rounded-xl bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-800 p-2.5 resize-none outline-none max-h-32 text-gray-900 dark:text-gray-100 placeholder-gray-400"
                  />
                  <Button
                    size="sm"
                    onClick={handleSendMessage}
                    disabled={!messageText.trim() || isSending}
                    className="bg-black hover:bg-gray-800 text-white h-9 px-3 rounded-xl disabled:opacity-40 shrink-0"
                    title="Send message"
                  >
                    {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {lightboxSrc && (
        <ImageViewer open={!!lightboxSrc} onClose={() => setLightboxSrc(null)} src={lightboxSrc} />
      )}
    </div>
  )
}