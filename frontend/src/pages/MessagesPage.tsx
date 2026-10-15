/**
 * MessagesPage.tsx — Executive Contract Rooms & Chat for Gigr.
 *
 * Provides real-time messaging, on-chain escrow status indicators,
 * contract terms overview, and interactive scope amendment management.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import api, { extractError } from '@/lib/api'
import UserChip from '@/components/UserChip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PriceInput } from '@/components/PriceInput'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { processImageFile } from '@/lib/imageUtils'
import { motion } from 'framer-motion'
import { Textarea } from '@/components/ui/textarea'
import { useAuthStore } from '@/store/authStore'
import { useUnreadStore } from '@/store/unreadStore'
import {
  MessageCircle,
  Send,
  ImagePlus,
  FileText,
  Loader2,
  X,
  Search,
  ShieldCheck,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Briefcase,
  ArrowRight,
} from 'lucide-react'
import type { components } from '@/types/api'
import { useWebSocketMessages } from '@/hooks/useWebSocketMessages'
import { ImageViewer } from '@/components/ImageViewer'
import ChatMessageContent from '@/components/ChatMessageContent'
import { cn } from '@/lib/utils'

type Job = components['schemas']['JobOut']
type Message = components['schemas']['MessageOut']

async function uploadFile(file: File): Promise<string> {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
  const preset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET
  const formPayload = new FormData()
  formPayload.append('file', file)
  formPayload.append('upload_preset', preset)
  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: 'POST', body: formPayload }
  )
  const uploadResponseJson = await response.json()
  if (!response.ok) {
    toast.error('Upload failed: ' + (uploadResponseJson.error?.message || ''))
    throw new Error(uploadResponseJson.error?.message || 'Upload failed')
  }
  toast.success('Image uploaded')
  return uploadResponseJson.secure_url
}

const renderStatusBadge = (status: string) => {
  const baseStyle = 'rounded-md px-2 py-0.5 text-[11px] font-mono font-medium border'
  switch (status) {
    case 'open':
      return <span className={cn(baseStyle, 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20')}>[OPEN]</span>
    case 'requested':
      return <span className={cn(baseStyle, 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/20')}>[REQUESTED]</span>
    case 'assigned':
      return <span className={cn(baseStyle, 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20')}>[ASSIGNED]</span>
    case 'funded':
      return <span className={cn(baseStyle, 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20')}>[FUNDED]</span>
    case 'in_progress':
      return <span className={cn(baseStyle, 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20')}>[IN PROGRESS]</span>
    case 'completed':
      return <span className={cn(baseStyle, 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 border-transparent')}>[COMPLETED]</span>
    case 'cancelled':
      return <span className={cn(baseStyle, 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20')}>[CANCELLED]</span>
    default:
      return <span className={cn(baseStyle, 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 border-gray-300')}>[{status.toUpperCase()}]</span>
  }
}

export default function MessagesPage() {
  const { user } = useAuthStore()
  const setMessageUnread = useUnreadStore((s) => s.setMessageUnread)
  const setMessagesPageActive = useUnreadStore((s) => s.setMessagesPageActive)
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

  const { data: myConversations, isLoading: jobsLoading } = useQuery<Job[]>({
    queryKey: ['myJobsForMessages'],
    queryFn: async () => {
      const { data } = await api.get('/jobs/my-conversations')
      return data
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
  const deepLinkHandledRef = useRef(false)

  useEffect(() => {
    if (!deepLinkJobId || deepLinkHandledRef.current || !myConversations) return
    deepLinkHandledRef.current = true
    const clearParam = () => {
      searchParams.delete('jobId')
      setSearchParams(searchParams, { replace: true })
    }
    const matchingJob = myConversations.find((j) => j.id === deepLinkJobId)
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
      lastSelectedJobIdRef.current = selectedJob.id
      setJobMeta((prev) => ({
        ...prev,
        [selectedJob.id]: { ...prev[selectedJob.id], unreadCount: 0 },
      }))
      api.post('/notifications/read-conversation', { job_id: selectedJob.id })
        .then(() => queryClient.invalidateQueries({ queryKey: ['notifications'] }))
        .catch(() => {})
    }
  }, [selectedJob?.id, queryClient])

  const [liveMessages, setLiveMessages] = useState<Message[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [liveMessages.length, selectedJob?.id])

  const { isLoading: msgsLoading, data: fetchedMessages, refetch } = useQuery<Message[]>({
    queryKey: ['messages', selectedJob?.id],
    queryFn: async () => {
      if (!selectedJob?.id) return []
      const { data } = await api.get(`/messages/job/${selectedJob.id}`)
      return data
    },
    enabled: !!selectedJob?.id,
  })

  useEffect(() => {
    if (fetchedMessages) {
      setLiveMessages(fetchedMessages)
      if (fetchedMessages.length > 0) {
        const lastMsg = fetchedMessages[fetchedMessages.length - 1]
        setJobMeta((prev) => ({
          ...prev,
          [selectedJob!.id]: {
            lastCreatedAt: lastMsg.created_at,
            unreadCount: prev[selectedJob!.id]?.unreadCount ?? 0,
          },
        }))
      }
    }
  }, [fetchedMessages, selectedJob])

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

  const { data: amendmentsList } = useQuery({
    queryKey: ['amendments', selectedJob?.id],
    queryFn: async () => {
      if (!selectedJob?.id) return []
      const { data } = await api.get(`/amendments/job/${selectedJob.id}`)
      return data
    },
    enabled: !!selectedJob?.id,
  })

  const filteredJobs = useMemo(() => {
    return activeJobs
      .filter((job) => {
        if (statusFilter === 'active') {
          return !['completed', 'cancelled'].includes(job.status)
        }
        if (statusFilter === 'completed') {
          return job.status === 'completed'
        }
        return true
      })
      .filter((job) => {
        if (!searchQuery.trim()) return true
        const searchTarget = (job.title || '').toLowerCase()
        return searchTarget.includes(searchQuery.toLowerCase().trim())
      })
      .sort((a, b) => {
        const metaA = jobMeta[a.id]
        const metaB = jobMeta[b.id]
        const timeA = metaA?.lastCreatedAt ? new Date(metaA.lastCreatedAt).getTime() : 0
        const timeB = metaB?.lastCreatedAt ? new Date(metaB.lastCreatedAt).getTime() : 0
        return timeB - timeA
      })
  }, [activeJobs, statusFilter, searchQuery, jobMeta])

  const sendTextMutation = useMutation({
    mutationFn: async () => {
      if (!selectedJob?.id || !messageText.trim()) return
      await api.post('/messages/', {
        job_id: selectedJob.id,
        content: messageText,
      })
    },
    onSuccess: () => {
      refetch()
      setMessageText('')
    },
    onError: (err: any) =>
      toast.error(extractError(err, 'Message failed')),
  })

  const sendImageMutation = useMutation({
    mutationFn: async ({ file, caption }: { file: File; caption: string }) => {
      const uploadedUrl = await uploadFile(file)
      if (!selectedJob?.id) return
      await api.post('/messages/', {
        job_id: selectedJob.id,
        content: caption || '',
        image_url: uploadedUrl,
      })
    },
    onSuccess: () => {
      refetch()
      setImageFile(null)
      setImagePreview(null)
      setMessageText('')
      toast.success('Image sent')
    },
    onError: (err: any) =>
      toast.error(extractError(err, 'Image send failed')),
  })

  const scopeAmendMutation = useMutation({
    mutationFn: async () => {
      if (!selectedJob?.id || !amendReason || !amendNewPrice) return
      let proofUrl: string | undefined
      if (amendImage) {
        proofUrl = await uploadFile(amendImage)
      }
      await api.post(`/amendments/${selectedJob.id}`, {
        job_id: selectedJob.id,
        proposed_by: user?.id === selectedJob?.provider_id ? 'provider' : 'client',
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

  return (
    <div className="space-y-4 animate-in fade-in duration-300">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-gray-100 dark:border-gray-800 pb-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-gray-900 dark:text-gray-100">
            Messages & Contract Rooms
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Real-time chat and verified escrow rooms for your active gigs
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono px-2 py-1 rounded bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400 border border-indigo-200 dark:border-indigo-800/40">
            {activeJobs.length} active room(s)
          </span>
        </div>
      </div>

      <div className="grid lg:grid-cols-12 gap-5 h-[calc(100vh-12rem)] min-h-[580px]">
        {/* Left Sidebar: Contract rooms list */}
        <div className="lg:col-span-4 flex flex-col rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden shadow-xs">
          {/* Search & filter toolbar */}
          <div className="p-3 border-b border-gray-100 dark:border-gray-800 space-y-2">
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
              <Input
                placeholder="Search rooms..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 h-9 text-xs rounded-xl bg-gray-50 dark:bg-gray-950 border-gray-200 dark:border-gray-800"
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
                      ? 'bg-gray-900 text-white dark:bg-white dark:text-gray-900 font-semibold'
                      : 'text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
                  )}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* List of rooms */}
          <div className="flex-1 overflow-y-auto p-2 space-y-1.5 divide-y divide-transparent">
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
                        ? 'bg-indigo-50/80 dark:bg-indigo-950/40 border border-indigo-200 dark:border-indigo-800/60 shadow-xs'
                        : 'border border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/60'
                    )}
                  >
                    {/* Avatar */}
                    {job.image_url ? (
                      <img
                        src={job.image_url}
                        alt=""
                        className="w-10 h-10 rounded-full object-cover shrink-0 ring-1 ring-gray-200 dark:ring-gray-700"
                      />
                    ) : (
                      <span className="w-10 h-10 rounded-full bg-indigo-600 text-white flex items-center justify-center text-xs font-bold shrink-0">
                        {job.title?.[0]?.toUpperCase() || '?'}
                      </span>
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1">
                        <p className={cn('text-xs truncate', unreadCount > 0 ? 'font-bold text-gray-900 dark:text-gray-100' : 'font-medium text-gray-800 dark:text-gray-200')}>
                          {job.title}
                        </p>
                        {currentMeta?.lastCreatedAt && (
                          <span className="text-[10px] font-mono text-gray-400 shrink-0">
                            {new Date(currentMeta.lastCreatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center justify-between gap-1 mt-1">
                        <span className="text-[11px] font-mono font-semibold text-indigo-600 dark:text-indigo-400">
                          ₦{Number(job.price).toLocaleString()}
                        </span>
                        <div className="flex items-center gap-1.5 shrink-0">
                          {renderStatusBadge(job.status)}
                          {unreadCount > 0 && (
                            <span className="min-w-[18px] h-4.5 px-1 text-[10px] font-bold text-white bg-indigo-600 rounded-full flex items-center justify-center">
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
        <div className="lg:col-span-8 flex flex-col rounded-2xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-hidden shadow-xs">
          {!selectedJob ? (
            <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
              <div className="w-16 h-16 rounded-2xl bg-indigo-50 dark:bg-indigo-950/40 text-indigo-600 flex items-center justify-center mb-3">
                <MessageCircle className="w-8 h-8" />
              </div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                No Contract Room Selected
              </h2>
              <p className="text-xs text-gray-500 max-w-sm mt-1">
                Choose an active gig from the sidebar on the left to enter its live contract room, review escrow terms, or message your counterparty.
              </p>
            </div>
          ) : (
            <>
              {/* Executive Contract Room Header HUD */}
              <div className="border-b border-gray-200 dark:border-gray-800 p-4 bg-gray-50/60 dark:bg-gray-950/60 space-y-2.5 shrink-0">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Briefcase className="w-4 h-4 text-indigo-600 shrink-0" />
                      <h2 className="text-sm sm:text-base font-bold text-gray-900 dark:text-gray-100 truncate">
                        {selectedJob.title}
                      </h2>
                    </div>
                    {counterpartyId && (
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[11px] text-gray-500">With:</span>
                        <UserChip userId={counterpartyId} size="sm" />
                        <span className="text-[10px] font-mono px-1.5 py-0.2 rounded bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300">
                          [{isClient ? 'FREELANCER' : 'CLIENT'}]
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Actions & Price */}
                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <span className="text-[10px] text-gray-400 block font-mono">Agreed Price</span>
                      <span className="text-sm sm:text-base font-mono font-bold text-indigo-600 dark:text-indigo-400">
                        ₦{Number(selectedJob.price).toLocaleString()}
                      </span>
                    </div>
                    {renderStatusBadge(selectedJob.status)}
                  </div>
                </div>

                {/* Escrow status bar & quick links */}
                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-gray-100 dark:border-gray-800 text-xs">
                  <div className="flex items-center gap-2">
                    {selectedJob.status === 'funded' ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-600 dark:text-emerald-400">
                        <ShieldCheck className="w-3.5 h-3.5" /> [ESCROW FUNDED · SECURED]
                      </span>
                    ) : selectedJob.status === 'in_progress' ? (
                      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-blue-600 dark:text-blue-400">
                        <ShieldCheck className="w-3.5 h-3.5" /> [IN PROGRESS · ESCROW LOCKED]
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[11px] font-mono text-amber-600 dark:text-amber-400">
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
                      className="inline-flex items-center gap-1 text-[11px] font-mono text-indigo-600 dark:text-indigo-400 hover:underline"
                    >
                      [VIEW GIG] <ExternalLink className="w-3 h-3" />
                    </button>
                    {!['completed', 'cancelled'].includes(selectedJob.status) && (
                      <button
                        type="button"
                        onClick={() => setShowScopeAmend(!showScopeAmend)}
                        className="inline-flex items-center gap-1 text-[11px] font-mono text-gray-600 dark:text-gray-300 hover:text-indigo-600"
                      >
                        [PROPOSE AMENDMENT]
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Chat Message Stream */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50/40 dark:bg-gray-950/40">
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
                    const prevMsg = liveMessages[index - 1]
                    const isLastInGroup = !nextMsg || nextMsg.sender_id !== msg.sender_id
                    const isFirstInGroup = !prevMsg || prevMsg.sender_id !== msg.sender_id

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
                        {/* Avatar for received messages */}
                        {!isCurrentUser && (
                          <div className="w-7 shrink-0 flex items-end">
                            {isLastInGroup && (
                              <Avatar className="w-7 h-7">
                                <AvatarImage src={msg.sender_image_url || undefined} referrerPolicy="no-referrer" />
                                <AvatarFallback className="bg-indigo-600 text-white text-[10px]">
                                  {msg.sender_name?.[0]?.toUpperCase() || '?'}
                                </AvatarFallback>
                              </Avatar>
                            )}
                          </div>
                        )}

                        <div className={cn('flex flex-col', isCurrentUser ? 'items-end' : 'items-start', 'max-w-[78%]')}>
                          {!isCurrentUser && isFirstInGroup && msg.sender_name && (
                            <span className="text-[11px] font-medium text-gray-500 ml-1 mb-0.5">
                              {msg.sender_name}
                            </span>
                          )}

                          <div
                            className={cn(
                              'px-3.5 py-2.5 text-sm shadow-xs break-words',
                              isCurrentUser
                                ? cn(
                                    'bg-indigo-600 text-white rounded-2xl',
                                    isLastInGroup ? 'rounded-br-xs' : 'rounded-br-md',
                                    isFirstInGroup ? 'rounded-tr-2xl' : 'rounded-tr-md'
                                  )
                                : cn(
                                    'bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 border border-gray-200 dark:border-gray-700/80 rounded-2xl',
                                    isLastInGroup ? 'rounded-bl-xs' : 'rounded-bl-md',
                                    isFirstInGroup ? 'rounded-tl-2xl' : 'rounded-tl-md'
                                  )
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
                      <div className="w-full max-w-md p-3.5 rounded-xl border border-indigo-200 dark:border-indigo-900/60 bg-white dark:bg-gray-900 shadow-sm space-y-2.5">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5 text-indigo-600 dark:text-indigo-400">
                            <FileText className="w-4 h-4" />
                            <span className="text-[11px] font-mono font-semibold">
                              [CONTRACT AMENDMENT PROPOSAL]
                            </span>
                          </div>
                          <span
                            className={cn(
                              'text-[10px] font-mono px-1.5 py-0.5 rounded border',
                              isPending
                                ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20'
                                : amendmentItem.is_accepted
                                  ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20'
                                  : 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20'
                            )}
                          >
                            {isPending
                              ? '[PENDING REVIEW]'
                              : amendmentItem.is_accepted
                                ? '[ACCEPTED]'
                                : '[DECLINED]'}
                          </span>
                        </div>

                        {/* Price difference banner */}
                        <div className="flex items-center justify-between p-2 rounded-lg bg-gray-50 dark:bg-gray-950 border border-gray-100 dark:border-gray-800 text-xs">
                          <div>
                            <span className="text-[10px] text-gray-400 block font-mono">Current Price</span>
                            <span className="font-mono font-medium text-gray-600 dark:text-gray-300">
                              ₦{currentJobPrice.toLocaleString()}
                            </span>
                          </div>
                          <ArrowRight className="w-4 h-4 text-gray-400" />
                          <div className="text-right">
                            <span className="text-[10px] text-gray-400 block font-mono">Proposed Total</span>
                            <span className="font-mono font-bold text-indigo-600 dark:text-indigo-400">
                              ₦{proposedPrice.toLocaleString()}
                            </span>
                          </div>
                        </div>

                        {priceDifference !== 0 && (
                          <p className="text-[11px] font-mono text-gray-500">
                            Price adjustment:{' '}
                            <span className={priceDifference > 0 ? 'text-amber-600 font-semibold' : 'text-emerald-600 font-semibold'}>
                              {priceDifference > 0 ? `+₦${priceDifference.toLocaleString()}` : `-₦${Math.abs(priceDifference).toLocaleString()}`}
                            </span>
                          </p>
                        )}

                        <div className="text-xs text-gray-700 dark:text-gray-300">
                          <span className="font-semibold text-gray-900 dark:text-gray-100">Reason: </span>
                          {amendmentItem.reason}
                        </div>

                        {amendmentItem.image_url && (
                          <div>
                            <img
                              src={amendmentItem.image_url}
                              alt="Amendment proof"
                              className="rounded-lg w-20 h-20 object-cover cursor-pointer hover:opacity-90 ring-1 ring-gray-200 dark:ring-gray-700"
                              onClick={() => setLightboxSrc(amendmentItem.image_url)}
                            />
                          </div>
                        )}

                        {/* Client decision buttons */}
                        {isClient && isPending && (
                          <div className="flex gap-2 pt-1 border-t border-gray-100 dark:border-gray-800">
                            <Button
                              size="sm"
                              className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white text-xs h-8 font-mono"
                              disabled={decideAmendmentMutation.isPending}
                              onClick={() =>
                                decideAmendmentMutation.mutate({ amendmentId: amendmentItem.id, accept: true })
                              }
                            >
                              <CheckCircle2 className="w-3.5 h-3.5 mr-1" />
                              [ACCEPT AMENDMENT]
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-red-300 text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20 text-xs h-8 font-mono"
                              disabled={decideAmendmentMutation.isPending}
                              onClick={() =>
                                decideAmendmentMutation.mutate({ amendmentId: amendmentItem.id, accept: false })
                              }
                            >
                              <XCircle className="w-3.5 h-3.5 mr-1" />
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

              {/* Bottom Dock Input Bar */}
              {showScopeAmend ? (
                <div className="border-t border-gray-200 dark:border-gray-800 p-4 space-y-3 bg-gray-50/80 dark:bg-gray-950/80">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold font-mono text-indigo-600 dark:text-indigo-400">
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
                    className="text-xs rounded-xl bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800"
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
                        className="bg-indigo-600 hover:bg-indigo-700 text-white text-xs h-8 font-mono"
                      >
                        {scopeAmendMutation.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '[SUBMIT PROPOSAL]'}
                      </Button>
                    </div>
                  </div>
                </div>
              ) : imagePreview ? (
                <div className="border-t border-gray-200 dark:border-gray-800 p-3 flex gap-2 items-center bg-white dark:bg-gray-950">
                  <img src={imagePreview} alt="Preview" className="w-12 h-12 rounded-xl object-cover shrink-0 ring-1 ring-gray-300" />
                  <Input
                    placeholder="Add a caption..."
                    value={messageText}
                    onChange={(e) => setMessageText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isSending) handleSendMessage()
                    }}
                    className="flex-1 text-xs rounded-xl"
                    autoFocus
                  />
                  <Button
                    size="sm"
                    onClick={handleSendMessage}
                    disabled={isSending}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white h-9 px-3 rounded-xl"
                  >
                    {isSending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={removeImage} className="h-9 w-9 p-0 rounded-xl">
                    <X className="w-4 h-4 text-gray-500" />
                  </Button>
                </div>
              ) : (
                <div className="border-t border-gray-200 dark:border-gray-800 p-3 flex gap-2 items-center bg-white dark:bg-gray-950">
                  <label className="cursor-pointer p-2 rounded-xl text-gray-500 hover:text-indigo-600 hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors">
                    <ImagePlus className="w-5 h-5" />
                    <input
                      type="file"
                      accept="image/*, .heic, .heif, .webp"
                      className="hidden"
                      onChange={handleImageSelect}
                    />
                  </label>
                  <Input
                    placeholder="Type a message in this contract room..."
                    value={messageText}
                    onChange={(e) => setMessageText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isSending) handleSendMessage()
                    }}
                    className="flex-1 text-xs rounded-xl bg-gray-50 dark:bg-gray-950 border-gray-200 dark:border-gray-800"
                  />
                  <Button
                    size="sm"
                    onClick={handleSendMessage}
                    disabled={!messageText.trim() || isSending}
                    className="bg-indigo-600 hover:bg-indigo-700 text-white h-9 px-3 rounded-xl disabled:opacity-40"
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