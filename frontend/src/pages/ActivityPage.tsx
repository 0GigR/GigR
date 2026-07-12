import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import api, { extractError } from '@/lib/api'
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Link } from 'react-router-dom'
import UserChip from '@/components/UserChip'
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
  Flag,
  Briefcase,
} from 'lucide-react'
import type { components } from '@/types/api'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ImageViewer } from '@/components/ImageViewer'
import ChatMessageContent from '@/components/ChatMessageContent'
import { EmptyState } from '@/components/EmptyState'
import { processImageFile } from '@/lib/imageUtils'

type Job = components['schemas']['JobOut']
type Message = components['schemas']['MessageOut']
type ScopeAmendment = components['schemas']['ScopeAmendmentOut']
type Vouch = components['schemas']['VouchOut']

// Helper to fetch user info
function useUserInfo(userId: string | undefined) {
  return useQuery({
    queryKey: ['user', userId],
    queryFn: async () => {
      const { data } = await api.get(`/users/${userId}`)
      return data
    },
    enabled: !!userId,
  })
}

function ActivityJobCard({ job, tab, onOpenContractRoom, onFund, onSubmitWork, onAccept, onCancel, onVouch, onLightbox, onDispute, onRate, fundPending, submitPending, acceptPending, cancelPending, vouchPending, vouched, rated }: any) {
  const { user } = useAuthStore()
  
  // Determine counterpart ID
  let counterpartId = null
  let roleLabel = ''
  
  if (tab === 'clienting') {
    counterpartId = job.provider_id
    roleLabel = 'Provider'
  } else if (tab === 'providing') {
    counterpartId = job.client_id
    roleLabel = 'Client'
  } else {
    // For completed/cancelled, guess based on our ID
    if (job.client_id === user?.id) {
      counterpartId = job.provider_id
      roleLabel = 'Provider'
    } else {
      counterpartId = job.client_id
      roleLabel = 'Client'
    }
  }

  const { data: counterpart } = useUserInfo(counterpartId)

  return (
    <Card className="bg-card text-card-foreground border-border relative">
      <CardHeader className="pb-2">
        <div className="flex justify-between items-start">
          <div>
            <CardTitle className="text-base mb-2">{job.title}</CardTitle>
            {counterpart && (
              <div className="mb-2 hover:opacity-80 transition-opacity w-fit">
                <Link to={`/dashboard/user/${counterpartId}`}>
                  <UserChip
                    userId={counterpartId}
                    name={counterpart.display_name}
                    avatarUrl={counterpart.profile_image_url}
                    lastSeenAt={(counterpart as any)?.last_seen_at}
                  />
                </Link>
                <span className="text-[10px] text-gray-400 ml-1 uppercase tracking-wider">{roleLabel}</span>
              </div>
            )}
          </div>
          {statusBadge(job.status)}
        </div>
      </CardHeader>
      <CardContent className="text-sm">
        <p className="text-gray-600 mb-2">₦{parseFloat(job.price as string).toLocaleString()}</p>
        {job.escrow_address && <p className="text-xs text-green-600 mb-2">Escrow: {job.escrow_address.slice(0, 8)}...</p>}
        {job.image_url && <img src={job.image_url} className="rounded-lg w-20 h-20 object-cover mb-2 cursor-pointer" onClick={() => onLightbox(job.image_url)} />}
        
        <div className="flex gap-2 flex-wrap">
          <Button size="sm" variant="outline" onClick={() => onOpenContractRoom(job)}>
            <MessageCircle className="w-3 h-3 mr-1" /> Contract Room
          </Button>
          {tab === 'clienting' && job.status === 'assigned' && (
            <Button size="sm" onClick={() => onFund({ type: 'fund', jobId: job.id, title: job.title })} className="bg-green-600 text-white" disabled={fundPending}>
              {fundPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Shield className="w-3 h-3 mr-1" />} Fund
            </Button>
          )}
          {tab === 'providing' && job.status === 'funded' && (
            <Button size="sm" onClick={() => onSubmitWork({ type: 'submit', jobId: job.id, title: job.title })} className="bg-purple-600 text-white" disabled={submitPending}>
              {submitPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle className="w-3 h-3 mr-1" />} Submit Work
            </Button>
          )}
          {tab === 'clienting' && (job.status === 'funded' || job.status === 'in_progress') && (
            <>
              <Button size="sm" onClick={() => onAccept({ type: 'release', jobId: job.id, title: job.title })} className="bg-black text-white" disabled={acceptPending}>
                <CheckCircle className="w-3 h-3 mr-1" /> Accept & Pay
              </Button>
              <Button size="sm" variant="outline" onClick={() => onDispute(job.id)} className="text-red-600 hover:text-red-700">
                <Flag className="w-3 h-3 mr-1" /> Dispute
              </Button>
            </>
          )}
          {(job.status === 'open' || job.status === 'assigned') && tab === 'clienting' && (
            <Button size="sm" variant="outline" onClick={() => onCancel({ type: 'cancel', jobId: job.id, title: job.title })} className="text-red-600 hover:text-red-700" disabled={cancelPending}>
              {cancelPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : null}
              Cancel
            </Button>
          )}
          {job.status === 'completed' && (
            <>
              <Button size="sm" variant={rated ? "secondary" : "outline"} onClick={() => onRate(job.id)} disabled={rated}>
                <Star className="w-3 h-3 mr-1" /> {rated ? 'Rated' : 'Rate'}
              </Button>
              {/* Only the client can vouch (backend enforces); hide for the provider */}
              {job.client_id === user?.id && (
                <Button size="sm" variant={vouched ? "secondary" : "outline"} onClick={() => onVouch(job.id)} disabled={vouched || vouchPending}>
                  <Shield className="w-3 h-3 mr-1" /> {vouched ? 'Vouched' : 'Vouch & Mint'}
                </Button>
              )}
            </>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

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
  const [activeTab, setActiveTab] = useState<'clienting' | 'providing' | 'completed' | 'cancelled'>('clienting')
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')

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
  const [ratingJobId, setRatingJobId] = useState<string | null>(null)
  const [ratingScore, setRatingScore] = useState(5)
  const [ratingComment, setRatingComment] = useState('')

  const { data: myVouchJobIds } = useQuery<string[]>({
    queryKey: ['myVouchJobIds'],
    queryFn: async () => {
      const { data } = await api.get('/vouches/user/' + user?.id)
      return (data as Vouch[]).map(v => v.job_id)
    },
    enabled: !!user?.id,
  })
  const vouchedJobIds = new Set(myVouchJobIds || [])

  const { data: myRatedJobIds } = useQuery<string[]>({
    queryKey: ['myRatedJobIds'],
    queryFn: async () => {
      const { data } = await api.get('/ratings/mine')
      return data
    },
    enabled: !!user?.id,
  })
  const ratedJobIds = new Set(myRatedJobIds || [])

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

  // Categorize and filter jobs
  const filterJobs = (jobs: Job[] | undefined) => {
    if (!jobs) return []
    return jobs.filter((j) => {
      const matchesSearch = j.title.toLowerCase().includes(searchQuery.toLowerCase())
      const matchesStatus = statusFilter === 'all' || j.status === statusFilter
      return matchesSearch && matchesStatus
    })
  }

  const safeJobs = Array.isArray(allJobs) ? allJobs : []
  const clientingJobs = filterJobs(safeJobs.filter((j) => j.client_id === user?.id && !['completed', 'cancelled'].includes(j.status)))
  const providingJobs = filterJobs(safeJobs.filter((j) => j.provider_id === user?.id && !['completed', 'cancelled'].includes(j.status)))
  const completedJobs = filterJobs(safeJobs.filter((j) => j.status === 'completed'))
  const cancelledJobs = filterJobs(safeJobs.filter((j) => j.status === 'cancelled'))

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
    onError: (err: any) => toast.error(extractError(err, 'Funding failed')),
  })

  const releaseMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post(`/jobs/${jobId}/release`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myActivity'] })
      toast.success('Payment released!')
    },
    onError: (err: any) => toast.error(extractError(err, 'Release failed')),
  })

  const submitWorkMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post(`/jobs/${jobId}/submit-work`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myActivity'] })
      toast.success('Work submitted — the client has been notified.')
    },
    onError: (err: any) => toast.error(extractError(err, 'Submit failed')),
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
    onError: (err: any) => toast.error(extractError(err, 'Vouch failed')),
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
    onError: (err: any) => toast.error(extractError(err, 'Message failed')),
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
      toast.error(extractError(err, 'Amendment failed')),
  })

  const cancelMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post(`/jobs/${jobId}/cancel`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['myActivity'] })
      toast.success('Job cancelled.')
    },
    onError: (err: any) => toast.error(extractError(err, 'Cancel failed')),
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
    onError: (err: any) => toast.error(extractError(err, 'Action failed')),
  })

  const ratingMutation = useMutation({
    mutationFn: async ({ jobId, score, comment }: { jobId: string; score: number; comment: string }) => {
      await api.post('/ratings/', { job_id: jobId, score, comment: comment || undefined })
    },
    onSuccess: () => {
      toast.success('Rating submitted — thank you!')
      setRatingJobId(null)
      setRatingComment('')
      setRatingScore(5)
      queryClient.invalidateQueries({ queryKey: ['myActivity'] })
      queryClient.invalidateQueries({ queryKey: ['myRatedJobIds'] })
    },
    onError: (err: any) => toast.error(extractError(err, 'Rating failed')),
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
    onError: (err: any) => toast.error(extractError(err, 'Failed to raise dispute')),
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
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">My Activity</h1>
          <p className="text-gray-500">
            Track your jobs, escrow, and reputation
          </p>
        </div>
        <div className="flex items-center gap-2 w-full md:w-auto">
          <Input 
            placeholder="Search by title..." 
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full md:w-64 bg-background"
          />
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-[140px] bg-background">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Statuses</SelectItem>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="assigned">Assigned</SelectItem>
              <SelectItem value="funded">Funded</SelectItem>
              <SelectItem value="in_progress">In Progress</SelectItem>
            </SelectContent>
          </Select>
        </div>
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
                <EmptyState
                  icon={<Briefcase className="w-8 h-8" />}
                  title={tab === 'clienting' ? "No requests yet" : tab === 'providing' ? "No active jobs" : "No jobs"}
                  description={tab === 'clienting' 
                    ? "You haven't requested any services yet. Go find someone to help you!" 
                    : tab === 'providing'
                    ? "You aren't providing any services right now. Apply for a job!"
                    : "There are no jobs matching this status."}
                  actionLabel={tab === 'clienting' ? "Browse Services" : tab === 'providing' ? "Browse Jobs" : undefined}
                  actionHref={tab === 'clienting' ? "/dashboard/services" : tab === 'providing' ? "/dashboard/jobs" : undefined}
                />
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
                    <ActivityJobCard
                      key={job.id}
                      job={job}
                      tab={tab}
                      onOpenContractRoom={openContractRoom}
                      onFund={setConfirmAction}
                      onSubmitWork={setConfirmAction}
                      onAccept={setConfirmAction}
                      onCancel={setConfirmAction}
                      onVouch={(id: string) => vouchMutation.mutate(id)}
                      onLightbox={setLightboxSrc}
                      onDispute={(id: string) => { setDisputeJobId(id); setContractRoomOpen(false) }}
                      onRate={(id: string) => setRatingJobId(id)}
                      fundPending={fundMutation.isPending}
                      submitPending={submitWorkMutation.isPending}
                      acceptPending={releaseMutation.isPending}
                      vouchPending={vouchMutation.isPending}
                      vouched={vouchedJobIds.has(job.id)}
                      rated={ratedJobIds.has(job.id)}
                    />
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
          <DialogContent className="sm:max-w-lg bg-background text-foreground max-h-[80vh] flex flex-col">
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
                    <ChatMessageContent
                      content={msg.content}
                      imageUrl={(msg as any).image_url}
                      onImageClick={setLightboxSrc}
                    />
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
                      accept="image/*, .heic, .heif, .webp"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0]
                        if (file && contractRoomJob?.id) {
                          try {
                            const processed = await processImageFile(file)
                            const url = await uploadFile(processed)
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

        {/* Rating Dialog */}
      <Dialog open={ratingJobId !== null} onOpenChange={() => setRatingJobId(null)}>
        <DialogContent className="sm:max-w-md bg-background text-foreground">
          <DialogHeader><DialogTitle>Rate your experience</DialogTitle></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="flex justify-center gap-2">
              {[1,2,3,4,5].map(n => (
                <button key={n} onClick={() => setRatingScore(n)}
                  className={`text-3xl transition-transform hover:scale-110 ${n <= ratingScore ? 'text-amber-400' : 'text-gray-200'}`}>
                  ★
                </button>
              ))}
            </div>
            <p className="text-center text-sm text-gray-500">
              {ratingScore === 5 ? 'Excellent' : ratingScore === 4 ? 'Good' : ratingScore === 3 ? 'Average' : ratingScore === 2 ? 'Poor' : 'Terrible'}
            </p>
            <textarea
              placeholder="Leave a comment (optional)..."
              value={ratingComment}
              onChange={e => setRatingComment(e.target.value)}
              rows={3}
              className="w-full rounded-md border border-gray-200 px-3 py-2 text-sm resize-none focus:outline-none"
            />
            <div className="flex gap-2 justify-end">
              <Button variant="outline" onClick={() => setRatingJobId(null)}>Cancel</Button>
              <Button
                className="bg-black text-white"
                disabled={ratingMutation.isPending}
                onClick={() => ratingJobId && ratingMutation.mutate({ jobId: ratingJobId, score: ratingScore, comment: ratingComment })}
              >
                {ratingMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : null}
                Submit Rating
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Dispute Reason Dialog */}
      <Dialog open={disputeJobId !== null} onOpenChange={() => setDisputeJobId(null)}>
        <DialogContent className="sm:max-w-md bg-background text-foreground">
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