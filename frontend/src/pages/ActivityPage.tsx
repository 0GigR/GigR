import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import api from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
// import { Separator } from '@/components/ui/separator'
// import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { useAuthStore } from '@/store/authStore'
import {
  MessageCircle,
  Shield,
  CheckCircle,
  Star,
  FileText,
  ImagePlus,
  Loader2,
  Send,
} from 'lucide-react'
import type { components } from '@/types/api'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ImageViewer } from '@/components/ImageViewer'

type Job = components['schemas']['JobOut']
type Message = components['schemas']['MessageOut']
type ScopeAmendment = components['schemas']['ScopeAmendmentOut']
type Vouch = components['schemas']['VouchOut']

// Helper to fetch user info
// function useUserInfo(userId: string | undefined) {
//   return useQuery({
//     queryKey: ['user', userId],
//     queryFn: async () => {
//       const { data } = await api.get(`/users/${userId}`)
//       return data
//     },
//     enabled: !!userId,
//   })
// }

// Cloudinary upload helper
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
  switch (status) {
    case 'open':
      return <Badge className="bg-blue-100 text-blue-800">Open</Badge>
    case 'assigned':
      return <Badge className="bg-yellow-100 text-yellow-800">Assigned</Badge>
    case 'funded':
      return <Badge className="bg-green-100 text-green-800">Funded</Badge>
    case 'in_progress':
      return <Badge className="bg-purple-100 text-purple-800">In Progress</Badge>
    case 'completed':
      return <Badge className="bg-black text-white">Completed</Badge>
    case 'cancelled':
      return <Badge className="bg-red-100 text-red-800">Canceled</Badge>
    default:
      return <Badge>{status}</Badge>
  }
}

export default function ActivityPage() {
  const { user } = useAuthStore()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<'clienting' | 'providing' | 'completed'>('clienting')

  // Contract room state
  const [contractRoomOpen, setContractRoomOpen] = useState(false)
  const [contractRoomJob, setContractRoomJob] = useState<Job | null>(null)
  const [messageText, setMessageText] = useState('')
  const [showScopeAmend, setShowScopeAmend] = useState(false)
  const [amendReason, setAmendReason] = useState('')
  const [amendNewPrice, setAmendNewPrice] = useState('')
  const [amendImage, setAmendImage] = useState<File | null>(null)
  const [amendImagePreview, setAmendImagePreview] = useState<string | null>(null)
  const [confirmAction, setConfirmAction] = useState<{ type: string; jobId: string; title: string } | null>(null)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)
  const [disputeReason, setDisputeReason] = useState('')
  const [disputeJobId, setDisputeJobId] = useState<string | null>(null)

  const { data: myVouchJobIds } = useQuery<string[]>({
    queryKey: ['myVouchJobIds'],
    queryFn: async () => {
      const { data } = await api.get('/vouches/user/' + user?.id)
      return (data as Vouch[]).map(v => v.job_id)
    },
    enabled: !!user?.id,
  })
  const vouchedJobIds = new Set(myVouchJobIds || [])

  // Fetch all my jobs
  const { data: allJobs, isLoading } = useQuery<Job[]>({
    queryKey: ['myActivity'],
    queryFn: async () => {
      const [c, p] = await Promise.all([
        api.get('/jobs/', { params: { my: 'client' } }),
        api.get('/jobs/', { params: { my: 'provider' } }),
      ])
      return [...c.data, ...p.data]
    },
  })

  // Categorize jobs
  const clientingJobs =
    allJobs?.filter(
      (j) => j.client_id === user?.id && !['completed', 'cancelled'].includes(j.status)
    ) || []
  const providingJobs =
    allJobs?.filter(
      (j) => j.provider_id === user?.id && !['completed', 'cancelled'].includes(j.status)
    ) || []
  const completedJobs =
    allJobs?.filter((j) => j.status === 'completed') || []
  const cancelledJobs =
    allJobs?.filter((j) => j.status === 'cancelled') || []

  // Contract room messages
  const { data: contractMessages, refetch: refetchMessages } = useQuery<Message[]>({
    queryKey: ['messages', contractRoomJob?.id],
    queryFn: async () => {
      if (!contractRoomJob?.id) return []
      const { data } = await api.get(`/messages/job/${contractRoomJob.id}`)
      return data
    },
    enabled: !!contractRoomJob?.id && contractRoomOpen,
    refetchInterval: 5000,
  })

  // Contract room amendments
  const { data: contractAmendments, refetch: refetchAmendments } = useQuery<ScopeAmendment[]>({
    queryKey: ['amendments', contractRoomJob?.id],
    queryFn: async () => {
      if (!contractRoomJob?.id) return []
      const { data } = await api.get(`/amendments/job/${contractRoomJob.id}`)
      return data
    },
    enabled: !!contractRoomJob?.id && contractRoomOpen,
    refetchInterval: 5000,
  })

  // Mutations
  const fundMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post(`/jobs/${jobId}/fund`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myActivity'] })
      toast.success('Escrow funded on Solana!')
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Funding failed'),
  })

  const releaseMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post(`/jobs/${jobId}/release`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myActivity'] })
      toast.success('Payment released!')
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Release failed'),
  })

  const submitWorkMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post(`/jobs/${jobId}/submit-work`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myActivity'] })
      toast.success('Work submitted — the client has been notified.')
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Submit failed'),
  })

  const vouchMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post('/vouches/', { job_id: jobId })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myActivity'] })
      queryClient.invalidateQueries({ queryKey: ['myVouchJobIds'] })
      toast.success('Vouch recorded – cNFT minting...')
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['myActivity'] })
        queryClient.invalidateQueries({ queryKey: ['myVouchJobIds'] })
        toast.success('cNFT minted on Solana!', { id: 'cnft-minted' })
      }, 5000)
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Vouch failed'),
  })

  const sendMessageMutation = useMutation({
    mutationFn: async ({
      jobId,
      content,
    }: {
      jobId: string
      content: string
    }) => {
      await api.post('/messages/', { job_id: jobId, content })
    },
    onSuccess: () => {
      refetchMessages()
      setMessageText('')
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Message failed'),
  })

  const scopeAmendMutation = useMutation({
    mutationFn: async () => {
      if (!contractRoomJob?.id || !amendReason || !amendNewPrice) return
      let imageUrl: string | undefined
      if (amendImage) {
        imageUrl = await uploadFile(amendImage)
      }
      await api.post(`/amendments/${contractRoomJob.id}`, {
        job_id: contractRoomJob.id,
        proposed_by: user?.id === contractRoomJob?.provider_id ? 'provider' : 'client',
        reason: amendReason,
        new_total_price: amendNewPrice,
        additional_cost: '0',
        image_url: imageUrl,
      })
    },
    onSuccess: () => {
      toast.success('Scope amendment proposed')
      setShowScopeAmend(false)
      setAmendReason('')
      setAmendNewPrice('')
      setAmendImage(null)
      setAmendImagePreview(null)
      refetchAmendments()
    },
    onError: (err: any) =>
      toast.error(err.response?.data?.detail || 'Amendment failed'),
  })

  const cancelMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post(`/jobs/${jobId}/cancel`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myActivity'] })
      toast.success('Job cancelled.')
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Cancel failed'),
  })

  const acceptAmendMutation = useMutation({
    mutationFn: async ({ id, accept }: { id: string; accept: boolean }) => {
      await api.post(`/amendments/${id}/accept`, { accept })
    },
    onSuccess: (_, variables) => {
      toast.success(variables.accept ? 'Amendment accepted!' : 'Amendment rejected!')
      queryClient.invalidateQueries({ queryKey: ['myActivity'] })
      refetchAmendments()
      setContractRoomOpen(false)
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Action failed'),
  })

  const raiseDisputeMutation = useMutation({
    mutationFn: async ({ jobId, reason }: { jobId: string; reason: string }) => {
      await api.post('/disputes/', { job_id: jobId, reason })
    },
    onSuccess: () => {
      toast.success('Dispute raised — a jury will be selected to review it.')
      queryClient.invalidateQueries({ queryKey: ['myActivity'] })
      setContractRoomOpen(false)
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Failed to raise dispute'),
  })

  const openContractRoom = (job: Job) => {
    setContractRoomJob(job)
    setContractRoomOpen(true)
    setShowScopeAmend(false)
  }

  const handleSendMessage = () => {
    if (!messageText.trim() || !contractRoomJob?.id) return
    sendMessageMutation.mutate({
      jobId: contractRoomJob.id,
      content: messageText,
    })
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold">My Activity</h1>
        <p className="text-gray-500">
          Track your jobs, escrow, and reputation
        </p>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as typeof activeTab)}
      >
        <TabsList>
          <TabsTrigger value="clienting">
            Clienting ({clientingJobs.length})
          </TabsTrigger>
          <TabsTrigger value="providing">
            Providing ({providingJobs.length})
          </TabsTrigger>
          <TabsTrigger value="completed">
            Completed ({completedJobs.length})
          </TabsTrigger>
          <TabsTrigger value="cancelled">
            Cancelled ({cancelledJobs.length})
          </TabsTrigger>
        </TabsList>

        {(['clienting', 'providing', 'completed', 'cancelled'] as const).map((tab) => (
          <TabsContent key={tab} value={tab} className="mt-4">
            {isLoading ? (
              <Skeleton className="h-20 w-full" />
            ) : (
              (tab === 'clienting'
                ? clientingJobs
                : tab === 'providing'
                ? providingJobs
                : tab === 'completed' 
                ? completedJobs 
                : cancelledJobs
              ).length === 0 ? (
                <div className="text-center py-12 text-gray-500">
                  No jobs here yet.
                </div>
              ) : (
                <div className="space-y-3">
                  {(tab === 'clienting'
                    ? clientingJobs
                    : tab === 'providing'
                    ? providingJobs
                    : tab === 'completed'
                    ? completedJobs
                    : cancelledJobs
                  ).map((job) => (
                    <Card
                      key={job.id}
                      className="bg-white border border-gray-100"
                    >
                      <CardHeader className="pb-2">
                        <div className="flex justify-between">
                          <CardTitle className="text-base">
                            {job.title}
                          </CardTitle>
                          {statusBadge(job.status)}
                        </div>
                      </CardHeader>
                      <CardContent className="text-sm">
                        <p className="text-gray-600 mb-2">
                          ₦
                          {parseFloat(
                            job.price as string
                          ).toLocaleString()}
                        </p>
                        {job.escrow_address && (
                          <p className="text-xs text-green-600 mb-2">
                            Escrow: {job.escrow_address.slice(0, 8)}...
                          </p>
                        )}
                        {job.image_url && (
                          <img
                            src={job.image_url}
                            className="rounded-lg w-20 h-20 object-cover mb-2 cursor-pointer"
                            onClick={() => setLightboxSrc(job.image_url!)}
                          />
                        )}
                        <div className="flex gap-2 flex-wrap">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => openContractRoom(job)}
                          >
                            <MessageCircle className="w-3 h-3 mr-1" />{' '}
                            Contract Room
                          </Button>
                          {tab === 'clienting' &&
                            job.status === 'assigned' && (
                              <Button
                                size="sm"
                                onClick={() => setConfirmAction({ type: 'fund', jobId: job.id, title: job.title })}
                                className="bg-green-600 text-white"
                                disabled={fundMutation.isPending}
                              >
                                {fundMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Shield className="w-3 h-3 mr-1" />}
                                Fund
                              </Button>
                          )}
                          {tab === 'providing' &&
                            job.status === 'funded' && (
                              <Button
                                size="sm"
                                onClick={() => setConfirmAction({ type: 'submit', jobId: job.id, title: job.title })}
                                className="bg-purple-600 text-white"
                                disabled={submitWorkMutation.isPending}
                              >
                                {submitWorkMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle className="w-3 h-3 mr-1" />}
                                Submit Work
                              </Button>
                          )}
                          {tab === 'clienting' &&
                            (job.status === 'funded' ||
                              job.status === 'in_progress') && (
                              <Button
                                size="sm"
                                onClick={() => setConfirmAction({ type: 'release', jobId: job.id, title: job.title })}
                                className="bg-blue-600 text-white"
                                disabled={releaseMutation.isPending}
                              >
                                {releaseMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle className="w-3 h-3 mr-1" />}
                                Release
                              </Button>
                          )}
                          {job.status === 'in_progress' &&
                            (job as any).auto_release_at && (
                              <span className="text-xs text-purple-600 self-center">
                                Auto-releases{' '}
                                {new Date(
                                  (job as any).auto_release_at
                                ).toLocaleString()}
                              </span>
                            )}
                          {/* Cancel button — pre-funding only */}
                          {['open', 'assigned', 'requested'].includes(job.status) && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-red-300 text-red-600 hover:bg-red-50"
                              onClick={() => setConfirmAction({ type: 'cancel', jobId: job.id, title: job.title })}
                              disabled={cancelMutation.isPending}
                            >
                              {cancelMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                              Cancel Job
                            </Button>
                          )}
                          {tab === 'completed' &&
                            job.client_id === user?.id && (
                              <Button
                                size="sm"
                                onClick={() => vouchMutation.mutate(job.id)}
                                disabled={vouchMutation.isPending || vouchedJobIds.has(job.id)}
                                className="bg-yellow-600 text-white disabled:opacity-60"
                              >
                                {vouchedJobIds.has(job.id) ? (
                                  <><CheckCircle className="w-3 h-3 mr-1" /> Already Vouched</>
                                ) : vouchMutation.isPending ? (
                                  <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Vouching...</>
                                ) : (
                                  <><Star className="w-3 h-3 mr-1" /> Vouch</>
                                )}
                              </Button>
                            )}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )
            )}
          </TabsContent>
        ))}
      </Tabs>

      {/* Contract Room Dialog */}
      {contractRoomJob && (
        <Dialog
          open={contractRoomOpen}
          onOpenChange={setContractRoomOpen}
        >
          <DialogContent className="sm:max-w-lg bg-white text-black max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>
                {contractRoomJob.title} — Contract Room
              </DialogTitle>
            </DialogHeader>

            {/* Job info */}
            <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
              <p>Status: {statusBadge(contractRoomJob.status)}</p>
              <p>
                Price: ₦
                {parseFloat(
                  contractRoomJob.price as string
                ).toLocaleString()}
              </p>
              {contractRoomJob.escrow_address && (
                <p className="text-xs text-green-600">
                  Escrow: {contractRoomJob.escrow_address.slice(0, 8)}...
                </p>
              )}
              {contractRoomJob.image_url && (
                <img
                  src={contractRoomJob.image_url}
                  className="rounded-lg w-20 h-20 object-cover mt-2 cursor-pointer"
                  onClick={() => setLightboxSrc(contractRoomJob.image_url!)}
                />
              )}
            </div>

            {/* Pending Amendments */}
            {contractAmendments?.filter(a => a.is_accepted === null).map((amend) => (
              <div key={amend.id} className="bg-yellow-50 border border-yellow-200 rounded-lg p-3 text-sm space-y-2 mt-2">
                <p className="font-bold text-yellow-800">Scope Amendment Proposed</p>
                <p><strong>Reason:</strong> {amend.reason}</p>
                <p><strong>New Price:</strong> ₦{parseFloat(amend.new_total_price as string).toLocaleString()}</p>
                {(amend as any).image_url && <img src={(amend as any).image_url} className="rounded-lg w-full max-h-32 object-cover mt-2 cursor-pointer" onClick={() => setLightboxSrc((amend as any).image_url)} />}
                {contractRoomJob?.client_id === user?.id && (
                  <div className="flex gap-2 pt-2">
                    <Button
                      size="sm"
                      className="bg-green-600 text-white"
                      onClick={() => acceptAmendMutation.mutate({ id: amend.id, accept: true })}
                      disabled={acceptAmendMutation.isPending}
                    >
                      {acceptAmendMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle className="w-3 h-3 mr-1" />}
                      Accept
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => acceptAmendMutation.mutate({ id: amend.id, accept: false })}
                      disabled={acceptAmendMutation.isPending}
                    >
                      {acceptAmendMutation.isPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
                      Reject
                    </Button>
                  </div>
                )}
                {contractRoomJob?.provider_id === user?.id && (
                  <p className="text-xs text-yellow-600">Waiting for client to accept...</p>
                )}
              </div>
            ))}

            {/* Messages */}
            <div className="flex-1 overflow-y-auto space-y-2 py-2">
              {contractMessages?.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex ${
                    msg.sender_id === user?.id
                      ? 'justify-end'
                      : 'justify-start'
                  }`}
                >
                  <div
                    className={`max-w-[75%] rounded-lg p-3 ${
                      msg.sender_id === user?.id
                        ? 'bg-black text-white'
                        : 'bg-gray-100 text-black'
                    }`}
                  >
                    {msg.content.match(/^https?:\/\/.+\.(jpg|jpeg|png|gif|webp)(\?.*)?$/i) ? (
                      <img
                        src={msg.content}
                        alt="sent image"
                        className="rounded-lg max-h-40 object-cover mb-1 cursor-pointer"
                        onClick={() => setLightboxSrc(msg.content)}
                      />
                    ) : (
                      <p className="text-sm">{msg.content}</p>
                    )}
                    <span className="text-xs opacity-70">
                      {new Date(msg.created_at).toLocaleTimeString()}
                    </span>
                  </div>
                </div>
              ))}
            </div>

            {/* Message input or amendment form */}
            {!showScopeAmend ? (
              <div className="border-t pt-2 flex flex-col gap-2">
                <div className="flex gap-2 items-center">
                  <label className="cursor-pointer">
                    <ImagePlus className="w-5 h-5 text-gray-500 hover:text-black" />
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (file && contractRoomJob?.id) {
                          try {
                            const url = await uploadFile(file)
                            await api.post('/messages/', {
                              job_id: contractRoomJob.id,
                              content: url,
                            })
                            refetchMessages()
                            toast.success('Image sent')
                          } catch {
                            // upload failed
                          }
                        }
                      }}
                    />
                  </label>
                  <Input
                    placeholder="Type a message..."
                    value={messageText}
                    onChange={(e) => setMessageText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                  />
                  <Button
                    size="sm"
                    onClick={handleSendMessage}
                    disabled={!messageText.trim() || sendMessageMutation.isPending}
                    className="bg-black text-white"
                  >
                    {sendMessageMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setShowScopeAmend(true)}
                  >
                    <FileText className="w-4 h-4 mr-1" /> Amend
                  </Button>
                  {(contractRoomJob.status === 'funded' ||
                    contractRoomJob.status === 'in_progress') && (
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={() => setConfirmAction({ type: 'dispute', jobId: contractRoomJob.id, title: contractRoomJob.title })}
                      disabled={raiseDisputeMutation.isPending}
                    >
                      <Shield className="w-4 h-4 mr-1" /> Dispute
                    </Button>
                  )}
                </div>
              </div>
            ) : (
              <div className="border-t pt-2 space-y-2">
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
                        .getElementById('activityAmendImage')
                        ?.click()
                    }
                  >
                    <ImagePlus className="w-4 h-4 mr-1" /> Attach
                    Image
                  </Button>
                  <input
                    id="activityAmendImage"
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) {
                        setAmendImage(file)
                        setAmendImagePreview(
                          URL.createObjectURL(file)
                        )
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
          </DialogContent>
        </Dialog>
      )}

      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={() => setConfirmAction(null)}
        title={
          confirmAction?.type === 'fund' ? 'Fund Escrow' :
          confirmAction?.type === 'release' ? 'Release Payment' :
          confirmAction?.type === 'submit' ? 'Submit Work' :
          confirmAction?.type === 'dispute' ? 'Raise Dispute' :
          confirmAction?.type === 'cancel' ? 'Cancel Job' : ''
        }
        description={
          confirmAction?.type === 'fund'
            ? `Are you sure you want to fund "${confirmAction?.title}"? USDC will be locked in a smart contract.`
            : confirmAction?.type === 'release'
            ? `Are you sure you want to release payment for "${confirmAction?.title}"? This will transfer USDC to the provider.`
            : confirmAction?.type === 'submit'
            ? `Submit work for "${confirmAction?.title}"? The client will be notified and auto-release will start.`
            : confirmAction?.type === 'dispute'
            ? `Raise a dispute for "${confirmAction?.title}"? A reason will be requested next.`
            : confirmAction?.type === 'cancel'
            ? `Are you sure you want to cancel "${confirmAction?.title}"? This action cannot be undone.`
            : ''
        }
        onConfirm={() => {
          if (!confirmAction) return
          const { type, jobId } = confirmAction
          if (type === 'fund') fundMutation.mutate(jobId)
          else if (type === 'release') releaseMutation.mutate(jobId)
          else if (type === 'submit') submitWorkMutation.mutate(jobId)
          else if (type === 'cancel') cancelMutation.mutate(jobId)
          else if (type === 'dispute') {
            setDisputeJobId(jobId)
            setDisputeReason('')
            setConfirmAction(null)
            setTimeout(() => document.getElementById('dispute-reason-dialog')?.focus(), 100)
          }
          if (type !== 'dispute') setConfirmAction(null)
        }}
        confirmLabel="Proceed"
        cancelLabel="Cancel"
        loading={
          confirmAction?.type === 'fund' ? fundMutation.isPending :
          confirmAction?.type === 'release' ? releaseMutation.isPending :
          confirmAction?.type === 'submit' ? submitWorkMutation.isPending :
          confirmAction?.type === 'cancel' ? cancelMutation.isPending :
          false
        }
      />
      {lightboxSrc && <ImageViewer open={!!lightboxSrc} onClose={() => setLightboxSrc(null)} src={lightboxSrc} />}

        {/* Dispute Reason Dialog */}
      <Dialog open={disputeJobId !== null} onOpenChange={() => setDisputeJobId(null)}>
        <DialogContent className="sm:max-w-md bg-white text-black">
          <DialogHeader>
            <DialogTitle>Describe the problem</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <Textarea
              id="dispute-reason-dialog"
              placeholder="Briefly describe the problem you want the jury to review..."
              value={disputeReason}
              onChange={(e) => setDisputeReason(e.target.value)}
              rows={4}
            />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setDisputeJobId(null)} className="border-gray-200">
                Cancel
              </Button>
              <Button
                onClick={() => {
                  if (!disputeReason.trim() || !disputeJobId) return
                  raiseDisputeMutation.mutate({ jobId: disputeJobId, reason: disputeReason })
                  setDisputeJobId(null)
                  setDisputeReason('')
                }}
                disabled={!disputeReason.trim() || raiseDisputeMutation.isPending}
                className="bg-black text-white"
              >
                Submit Dispute
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}