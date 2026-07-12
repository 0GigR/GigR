import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import api, { extractError } from '@/lib/api'
import UserChip from '@/components/UserChip'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Skeleton } from '@/components/ui/skeleton'
import { processImageFile } from '@/lib/imageUtils'
import { motion } from 'framer-motion'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { useAuthStore } from '@/store/authStore'
import { useUnreadStore } from '@/store/unreadStore'
import {
  MessageCircle,
  Send,
  ImagePlus,
  FileText,
  Loader2,
} from 'lucide-react'
import type { components } from '@/types/api'
import { useWebSocketMessages } from '@/hooks/useWebSocketMessages'
import { ImageViewer } from '@/components/ImageViewer'
import ChatMessageContent from '@/components/ChatMessageContent'
import { EmptyState } from '@/components/EmptyState'

type Job = components['schemas']['JobOut']
type Message = components['schemas']['MessageOut']

// Cloudinary image upload helper
async function uploadFile(file: File): Promise<string> {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
  const preset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET
  const formData = new FormData()
  formData.append('file', file)
  formData.append('upload_preset', preset)
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
    { method: 'POST', body: formData }
  )
  const data = await res.json()
  if (!res.ok) {
    toast.error('Upload failed: ' + (data.error?.message || ''))
    throw new Error(data.error?.message || 'Upload failed')
  }
  toast.success('Image uploaded')
  return data.secure_url
}

const statusBadge = (status: string) => {
  const base = 'rounded-full px-2.5 py-0.5 text-xs font-medium border'
  switch (status) {
    case 'open':
      return <Badge className={`${base} bg-blue-50 text-blue-700 border-blue-200`}>Open</Badge>
    case 'requested':
      return <Badge className={`${base} bg-indigo-50 text-indigo-700 border-indigo-200`}>Requested</Badge>
    case 'assigned':
      return <Badge className={`${base} bg-amber-50 text-amber-700 border-amber-200`}>Assigned</Badge>
    case 'funded':
      return <Badge className={`${base} bg-emerald-50 text-emerald-700 border-emerald-200`}>Funded</Badge>
    case 'in_progress':
      return <Badge className={`${base} bg-purple-50 text-purple-700 border-purple-200`}>In Progress</Badge>
    case 'completed':
      return <Badge className={`${base} bg-gray-900 text-white border-gray-900`}>Completed</Badge>
    case 'cancelled':
      return <Badge className={`${base} bg-red-50 text-red-700 border-red-200`}>Canceled</Badge>
    default:
      return <Badge className={`${base} bg-gray-50 text-gray-700 border-gray-200`}>{status}</Badge>
  }
}

export default function MessagesPage() {
  const { user } = useAuthStore()
  const setMessageUnread = useUnreadStore((s) => s.setMessageUnread)
  const setMessagesPageActive = useUnreadStore((s) => s.setMessagesPageActive)
  const queryClient = useQueryClient()

  // While the Messages page is mounted it owns unread tracking; tell the global
  // notifier to defer so we don't double-count or fire duplicate toasts.
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

  // ── Fetch all my jobs ──────────────────────────────────────
  const { data: myJobs, isLoading: jobsLoading } = useQuery<Job[]>({
    queryKey: ['myJobsForMessages'],
    queryFn: async () => {
      // Includes jobs you own AND any job you've chatted in (e.g. discussing an open job)
      const { data } = await api.get('/jobs/my-conversations')
      return data
    },
  })

  const activeJobs = (() => {
    const list =
      myJobs?.filter((j) => !['completed', 'cancelled'].includes(j.status)) || []
    // Dedup by job id first (client+provider overlap can return the same job twice)
    const byId = list.filter((j, i, arr) => arr.findIndex((x) => x.id === j.id) === i)
    // Then collapse redundant chats: one chat per service per counterparty.
    // Old users sometimes requested the same service multiple times — keep just one.
    const seen = new Set<string>()
    return byId.filter((j) => {
      const counterparty = j.client_id === user?.id ? j.provider_id : j.client_id
      const key = j.service_listing_id
        ? `svc:${j.service_listing_id}:${counterparty}`
        : `job:${j.id}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  })()

  // ── Track the last message timestamp per job for sorting & unread ──
  // Map: jobId -> { lastCreatedAt: string, unreadCount: number }
  const [jobMeta, setJobMeta] = useState<Record<string, { lastCreatedAt: string; unreadCount: number }>>({})

  // Keep the global nav indicator in sync with total unread across all jobs
  useEffect(() => {
    const total = Object.values(jobMeta).reduce((sum, m) => sum + (m.unreadCount || 0), 0)
    setMessageUnread(total)
  }, [jobMeta, setMessageUnread])

  // Also store a ref to know which job the user last had selected
  const lastSelectedJobIdRef = useRef<string | null>(null)

  // Update selectedJobId ref whenever it changes
  useEffect(() => {
    if (selectedJob?.id) {
      lastSelectedJobIdRef.current = selectedJob.id
      // Clear unread for this job
      setJobMeta((prev) => ({
        ...prev,
        [selectedJob.id]: { ...prev[selectedJob.id], unreadCount: 0 },
      }))
    }
  }, [selectedJob?.id])

  // ── Live messages state ─────────────────────────────────────
  const [liveMessages, setLiveMessages] = useState<Message[]>([])
  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to the latest message
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [liveMessages.length, selectedJob?.id])

  // Fetch messages for the selected job (initial load only, no polling)
  const { isLoading: msgsLoading, data: fetchedMessages, refetch } = useQuery<Message[]>({
    queryKey: ['messages', selectedJob?.id],
    queryFn: async () => {
      if (!selectedJob?.id) return []
      const { data } = await api.get(`/messages/job/${selectedJob.id}`)
      return data
    },
    enabled: !!selectedJob?.id,
  })

  // When fetched data changes (initial load or job switch), reset liveMessages
  useEffect(() => {
    if (fetchedMessages) {
      setLiveMessages(fetchedMessages)
      // Update last message timestamp for this job
      if (fetchedMessages.length > 0) {
        const last = fetchedMessages[fetchedMessages.length - 1]
        setJobMeta((prev) => ({
          ...prev,
          [selectedJob!.id]: {
            lastCreatedAt: last.created_at,
            unreadCount: prev[selectedJob!.id]?.unreadCount ?? 0,
          },
        }))
      }
    }
  }, [fetchedMessages])

  // WebSocket: listen for new messages in real time
  const handleNewMessage = useCallback((msg: Message) => {
    // Only append to the visible chat if the message belongs to the selected job
    if (msg.job_id === lastSelectedJobIdRef.current) {
      setLiveMessages((prev) => {
        if (prev.some((m) => m.id === msg.id)) return prev
        return [...prev, msg]
      })
    }

    // Update jobMeta for sorting and unread tracking
    setJobMeta((prev) => {
      const current = prev[msg.job_id] || { lastCreatedAt: '', unreadCount: 0 }
      const isUnread = msg.job_id !== lastSelectedJobIdRef.current
      return {
        ...prev,
        [msg.job_id]: {
          lastCreatedAt: msg.created_at,
          unreadCount: current.unreadCount + (isUnread ? 1 : 0),
        },
      }
    })
  }, [])

  // Connect to ALL active job rooms so messages from any job arrive in real time.
  // Memoize by a stable key so the array identity only changes when the set of ids changes,
  // avoiding constant WS reconnect churn (the [WS] Disconnected ... 1006 spam).
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

  const { data: amendments } = useQuery({
    queryKey: ['amendments', selectedJob?.id],
    queryFn: async () => {
      if (!selectedJob?.id) return []
      const { data } = await api.get(`/amendments/job/${selectedJob.id}`)
      return data
    },
    enabled: !!selectedJob?.id,
  })

  // ── Sort active jobs by newest message (jobs with no messages go to bottom) ──
  const sortedActiveJobs = [...activeJobs].sort((a, b) => {
    const metaA = jobMeta[a.id]
    const metaB = jobMeta[b.id]
    const timeA = metaA?.lastCreatedAt ? new Date(metaA.lastCreatedAt).getTime() : 0
    const timeB = metaB?.lastCreatedAt ? new Date(metaB.lastCreatedAt).getTime() : 0
    return timeB - timeA // descending (newest first)
  })

  // ── Send text message ───────────────────────────────────────
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

  // Send image message
  const sendImageMutation = useMutation({
    mutationFn: async (file: File) => {
      const url = await uploadFile(file)
      if (!selectedJob?.id) return
      await api.post('/messages/', {
        job_id: selectedJob.id,
        content: url,
      })
    },
    onSuccess: () => {
      refetch()
      toast.success('Image sent')
    },
    onError: (err: any) =>
      toast.error(extractError(err, 'Image send failed')),
  })

  // Scope amendment
  const scopeAmendMutation = useMutation({
    mutationFn: async () => {
      if (!selectedJob?.id || !amendReason || !amendNewPrice) return
      let imageUrl: string | undefined
      if (amendImage) {
        imageUrl = await uploadFile(amendImage)
      }
      await api.post(`/amendments/${selectedJob.id}`, {
        job_id: selectedJob.id,
        proposed_by: user?.id === selectedJob?.provider_id ? 'provider' : 'client',
        reason: amendReason,
        new_total_price: amendNewPrice,
        additional_cost: '0',
        image_url: imageUrl,
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

  const handleSendMessage = () => {
    if (!messageText.trim()) return
    sendTextMutation.mutate()
  }

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      const processed = await processImageFile(file)
      sendImageMutation.mutate(processed)
    }
  }

  const isSending = sendTextMutation.isPending || sendImageMutation.isPending

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold">Messages</h1>
        <p className="text-gray-500">
          Contract rooms for your active jobs
        </p>
      </div>

      <div className="grid md:grid-cols-3 gap-6">
        {/* Sidebar with job list */}
        <div className="md:col-span-1 space-y-2">
          {jobsLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : sortedActiveJobs.length === 0 ? (
            <p className="text-sm text-gray-500">
              No active jobs yet.
            </p>
          ) : (
            sortedActiveJobs.map((job) => {
              const meta = jobMeta[job.id]
              const unreadCount = meta?.unreadCount ?? 0
              return (
                <button
                  key={job.id}
                  type="button"
                  onClick={() => {
                    setSelectedJob(job)
                    setShowScopeAmend(false)
                  }}
                  className={`w-full text-left rounded-xl border p-3 flex gap-3 items-center transition-all ${
                    selectedJob?.id === job.id
                      ? 'border-black bg-gray-50 dark:bg-gray-800 dark:border-gray-600 shadow-sm'
                      : 'border-gray-100 dark:border-gray-800 hover:bg-gray-50 dark:hover:bg-gray-800/60'
                  }`}
                >
                  {/* Avatar / job image */}
                  {job.image_url ? (
                    <img
                      src={job.image_url}
                      className="w-11 h-11 rounded-full object-cover flex-shrink-0"
                    />
                  ) : (
                    <span className="w-11 h-11 rounded-full bg-black text-white flex items-center justify-center text-sm font-semibold flex-shrink-0">
                      {job.title?.[0]?.toUpperCase() || '?'}
                    </span>
                  )}

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className={`text-sm truncate ${unreadCount > 0 ? 'font-bold' : 'font-medium'}`}>
                        {job.title}
                      </p>
                      {meta?.lastCreatedAt && (
                        <span className="text-[10px] text-gray-400 flex-shrink-0">
                          {new Date(meta.lastCreatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center justify-between gap-2 mt-1">
                      {statusBadge(job.status)}
                      {unreadCount > 0 && (
                        <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-[10px] font-bold text-white bg-black rounded-full flex-shrink-0">
                          {unreadCount}
                        </span>
                      )}
                    </div>
                  </div>
                </button>
              )
            })
          )}
        </div>

        {/* Chat area */}
        <div className="md:col-span-2">
          {!selectedJob ? (
            <div className="mt-8">
              <EmptyState
                icon={<MessageCircle className="w-8 h-8" />}
                title="No chat selected"
                description="Select a job from the list on the left to open its contract room and start chatting."
              />
            </div>
          ) : (
            // dvh so the card shrinks when the mobile keyboard opens (keeps input visible)
            <Card className="flex flex-col h-[70dvh] max-h-[calc(100dvh-9rem)]">
              <CardHeader className="border-b">
                <div className="flex justify-between items-start gap-3">
                  <div className="min-w-0">
                    <CardTitle className="text-base font-semibold truncate">
                      {selectedJob.title}
                    </CardTitle>
                    {/* Counterparty chip */}
                    {(() => {
                      const counterpartyId = selectedJob.client_id === user?.id
                        ? selectedJob.provider_id
                        : selectedJob.client_id
                      return counterpartyId ? (
                        <div className="mt-1">
                          <UserChip userId={counterpartyId} size="sm" />
                        </div>
                      ) : null
                    })()}
                  </div>
                  {statusBadge(selectedJob.status)}
                </div>
                {selectedJob.escrow_address && (
                  <p className="text-xs text-green-600 mt-1">
                    Escrow: {selectedJob.escrow_address.slice(0, 8)}...
                  </p>
                )}
              </CardHeader>

              <CardContent className="flex-1 overflow-y-auto space-y-3 py-4 bg-gray-50/50 dark:bg-gray-900/40">
                {msgsLoading ? (
                  <Skeleton className="h-20 w-full" />
                ) : liveMessages?.length ? (
                  liveMessages.map((msg, idx) => {
                    const isCurrentUser = msg.sender_id === user?.id
                    const nextMsg = liveMessages[idx + 1]
                    const prevMsg = liveMessages[idx - 1]
                    
                    const isLastInGroup = !nextMsg || nextMsg.sender_id !== msg.sender_id
                    const isFirstInGroup = !prevMsg || prevMsg.sender_id !== msg.sender_id

                    return (
                      <motion.div
                        key={msg.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ duration: 0.2 }}
                        className={`flex gap-2 mb-1 ${isCurrentUser ? 'justify-end' : 'justify-start'} ${isLastInGroup ? 'mb-4' : ''}`}
                      >
                        {/* Avatar for received messages */}
                        {!isCurrentUser && (
                          <div className="w-8 flex-shrink-0 flex items-end">
                            {isLastInGroup && (
                              <Avatar className="w-8 h-8">
                                <AvatarImage src={msg.sender_image_url || undefined} referrerPolicy="no-referrer" />
                                <AvatarFallback className="bg-black text-white text-xs">
                                  {msg.sender_name?.[0]?.toUpperCase() || '?'}
                                </AvatarFallback>
                              </Avatar>
                            )}
                          </div>
                        )}
                        
                        <div className={`flex flex-col ${isCurrentUser ? 'items-end' : 'items-start'} max-w-[75%]`}>
                          {/* Sender name on the first message of a group (for received messages) */}
                          {!isCurrentUser && isFirstInGroup && msg.sender_name && (
                            <span className="text-xs text-gray-500 ml-1 mb-1">{msg.sender_name}</span>
                          )}
                          
                          <div
                            className={`px-3.5 py-2.5 shadow-sm ${
                              isCurrentUser
                                ? `bg-black text-white rounded-2xl ${isLastInGroup ? 'rounded-br-sm' : 'rounded-br-md'} ${isFirstInGroup ? 'rounded-tr-2xl' : 'rounded-tr-md'}`
                                : `bg-gray-100 dark:bg-gray-800 text-black dark:text-white rounded-2xl ${isLastInGroup ? 'rounded-bl-sm' : 'rounded-bl-md'} ${isFirstInGroup ? 'rounded-tl-2xl' : 'rounded-tl-md'}`
                            }`}
                          >
                            <ChatMessageContent
                              content={msg.content}
                              imageUrl={msg.image_url}
                              onImageClick={setLightboxSrc}
                            />
                            <div className="flex justify-end items-center gap-1 mt-1">
                              <span className="block text-[10px] opacity-60">
                                {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            </div>
                          </div>
                        </div>
                      </motion.div>
                    )
                  })
                ) : (
                  <p className="text-center text-gray-500 text-sm">
                    No messages yet. Start the conversation.
                  </p>
                )}

                {amendments?.map((am: any) => (
                  <div key={am.id} className="flex justify-center">
                    <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 max-w-[85%] text-sm">
                      <p className="font-medium">Scope Amendment Proposed</p>
                      <p>{am.reason}</p>
                      <p className="font-semibold">
                        New price: ₦{parseFloat(am.new_total_price as string).toLocaleString()}
                      </p>
                      {am.image_url && (
                        <img src={am.image_url} className="rounded-lg w-20 h-20 object-cover mt-1 cursor-pointer" onClick={() => setLightboxSrc(am.image_url!)} />
                      )}
                      <p className="text-xs text-gray-500 mt-1">
                        {am.is_accepted === null ? 'Pending' : am.is_accepted ? 'Accepted' : 'Rejected'}
                      </p>
                    </div>
                  </div>
                ))}
                <div ref={messagesEndRef} />
              </CardContent>

              {/* Input area */}
              {!showScopeAmend ? (
                <div className="border-t p-3 flex gap-2 items-center">
                  <label className="cursor-pointer">
                    <ImagePlus className="w-5 h-5 text-gray-500 hover:text-black" />
                    <input
                      type="file"
                      accept="image/*, .heic, .heif, .webp"
                      className="hidden"
                      onChange={handleImageSelect}
                    />
                  </label>
                  <Input
                    placeholder="Type a message..."
                    value={messageText}
                    onChange={(e) => setMessageText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !isSending) handleSendMessage()
                    }}
                    onFocus={(e) => {
                      // When the keyboard opens, make sure the input scrolls
                      // into the visible area above it.
                      setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300)
                    }}
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    onClick={handleSendMessage}
                    disabled={!messageText.trim() || isSending}
                    className="bg-black text-white min-w-[40px]"
                  >
                    {isSending ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <Send className="w-4 h-4" />
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowScopeAmend(true)}
                  >
                    <FileText className="w-4 h-4 mr-1" /> Amend
                  </Button>
                </div>
              ) : (
                <div className="border-t p-3 space-y-2">
                  <Textarea
                    placeholder="Reason for amendment..."
                    value={amendReason}
                    onChange={(e) => setAmendReason(e.target.value)}
                  />
                  <Input
                    placeholder="New total price"
                    type="number"
                    value={amendNewPrice}
                    onChange={(e) => setAmendNewPrice(e.target.value)}
                  />
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() =>
                        document
                          .getElementById('msgAmendImage')
                          ?.click()
                      }
                    >
                      <ImagePlus className="w-4 h-4 mr-1" /> Attach Image
                    </Button>
                    <input
                      id="msgAmendImage"
                      type="file"
                      accept="image/*, .heic, .heif, .webp"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (file) {
                          const processed = await processImageFile(file)
                          setAmendImage(processed)
                          setAmendImagePreview(URL.createObjectURL(processed))
                        }
                      }}
                    />
                    {amendImagePreview && (
                      <img
                        src={amendImagePreview}
                        className="w-12 h-12 rounded-lg object-cover"
                      />
                    )}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      onClick={() => scopeAmendMutation.mutate()}
                      disabled={!amendReason || !amendNewPrice}
                      className="bg-black text-white"
                    >
                      Submit Amendment
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setShowScopeAmend(false)}
                    >
                      Cancel
                    </Button>
                  </div>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
      {lightboxSrc && (
        <ImageViewer open={!!lightboxSrc} onClose={() => setLightboxSrc(null)} src={lightboxSrc} />
      )}
    </div>
  )
}