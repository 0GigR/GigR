import { useState, useRef } from 'react'
import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuthStore } from '@/store/authStore'
import UserChip from '@/components/UserChip'
import { NeighborhoodMap } from '@/components/NeighborhoodMap'
import { useGeolocation } from '@/hooks/useGeolocation'
import {
  Plus, Send, Shield, CheckCircle, Star, Play, UserPlus,
  ImagePlus, ExternalLink, X, MessageCircle, FileText, Loader2, Map, List
} from 'lucide-react'
import type { components } from '@/types/api'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { ImageViewer } from '@/components/ImageViewer'

type Job = components['schemas']['JobOut']
type Application = components['schemas']['ApplicationOut']
type UserProfile = components['schemas']['UserOut']
type Message = components['schemas']['MessageOut']
type ScopeAmendment = components['schemas']['ScopeAmendmentOut']
type Vouch = components['schemas']['VouchOut']

const statusBadge = (status: string) => {
  switch (status) {
    case 'open': return <Badge className="bg-blue-100 text-blue-800">Open</Badge>
    case 'assigned': return <Badge className="bg-yellow-100 text-yellow-800">Assigned</Badge>
    case 'funded': return <Badge className="bg-green-100 text-green-800">Funded</Badge>
    case 'in_progress': return <Badge className="bg-purple-100 text-purple-800">In Progress</Badge>
    case 'completed': return <Badge className="bg-black text-white">Completed</Badge>
    case 'cancelled': return <Badge className="bg-red-100 text-red-800">Canceled</Badge>
    default: return <Badge>{status}</Badge>
  }
}

// Fetch user info
function useUserInfo(userId: string | undefined) {
  return useQuery<UserProfile>({
    queryKey: ['user', userId],
    queryFn: async () => {
      const { data } = await api.get(`/users/${userId}`)
      return data
    },
    enabled: !!userId,
  })
}

// Cloudinary image upload
async function uploadFile(file: File): Promise<string> {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
  const preset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET
  const formData = new FormData()
  formData.append('file', file)
  formData.append('upload_preset', preset)
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: formData,
  })
  const data = await res.json()
  if (!res.ok) {
    toast.error('Image upload failed: ' + (data.error?.message || ''))
    throw new Error(data.error?.message || 'Upload failed')
  }
  toast.success('Image uploaded')
  return data.secure_url
}

export default function JobsPage() {
  const queryClient = useQueryClient()
  const { user } = useAuthStore()
  const [activeTab, setActiveTab] = useState<'open' | 'mine' | 'map'>('open')
  const geo = useGeolocation()

  // Create Job dialog state
  const [createOpen, setCreateOpen] = useState(false)
  const [formData, setFormData] = useState({
    title: '', description: '', price: '',
    min_price: '', max_price: '',
  })
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreview, setImagePreview] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  // Apply dialog state
  const [applyOpen, setApplyOpen] = useState(false)
  const [applyJobId, setApplyJobId] = useState<string | null>(null)
  const [applyTargetJob, setApplyTargetJob] = useState<Job | null>(null)
  const [applyData, setApplyData] = useState({
    message: '', proposed_price: '', portfolio_url: '',
  })

  // Contract room state
  const [contractRoomOpen, setContractRoomOpen] = useState(false)
  const [contractRoomJobId, setContractRoomJobId] = useState<string | null>(null)
  const [contractRoomJob, setContractRoomJob] = useState<Job | null>(null)
  const [messageText, setMessageText] = useState('')
  const [messageImageFile, setMessageImageFile] = useState<File | null>(null)
  const [messageImagePreview, setMessageImagePreview] = useState<string | null>(null)
  const [showScopeAmend, setShowScopeAmend] = useState(false)
  const [amendReason, setAmendReason] = useState('')
  const [amendNewPrice, setAmendNewPrice] = useState('')
  const [amendImage, setAmendImage] = useState<File | null>(null)
  const [amendImagePreview, setAmendImagePreview] = useState<string | null>(null)

  // Detail modal
  const [detailJob, setDetailJob] = useState<Job | null>(null)

  // Confirmation dialogs
  const [confirmAction, setConfirmAction] = useState<{ type: string; jobId: string; title: string } | null>(null)
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null)

  // Filters & Sorting
  const [sortOrder, setSortOrder] = useState('newest') // newest, oldest, price_high, price_low
  const [statusFilter, setStatusFilter] = useState('all') // all, open, assigned, in_progress, completed, cancelled

  // Paginated open jobs ("Load More" pattern)
  const PAGE_SIZE = 20
  const {
    data: openJobsPages,
    isLoading: openLoading,
    fetchNextPage: fetchMoreOpenJobs,
    hasNextPage: hasMoreOpenJobs,
    isFetchingNextPage: loadingMoreOpenJobs,
  } = useInfiniteQuery<Job[]>({
    queryKey: ['jobs', 'open'],
    queryFn: async ({ pageParam = 0 }) => {
      const res = await api.get('/jobs/', { params: { status: 'open,requested', limit: PAGE_SIZE, offset: pageParam } })
      const all: Job[] = res.data
      return all.filter(job => !(job.status === 'requested' && job.client_id === user?.id))
    },
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      if (lastPage.length < PAGE_SIZE) return undefined
      return allPages.flat().length
    },
    refetchInterval: 10000,
  })
  const openJobs = openJobsPages?.pages.flat() ?? []

  const { data: myJobs, isLoading: myLoading } = useQuery<Job[]>({
    queryKey: ['jobs', 'mine'],
    queryFn: async () => {
      const [c, p] = await Promise.all([
        api.get('/jobs/', { params: { my: 'client' } }),
        api.get('/jobs/', { params: { my: 'provider' } }),
      ])
      return [...c.data, ...p.data]
    },
  })

  // Live NGN → USDC exchange rate (cached 60 min server-side, refetch every hour client-side)
  const { data: rateData } = useQuery<{ ngn_per_usd: number }>({
    queryKey: ['exchange-rate'],
    queryFn: async () => {
      const { data } = await api.get('/jobs/exchange-rate')
      return data
    },
    staleTime: 1000 * 60 * 60, // 1 hour
    refetchInterval: 1000 * 60 * 60,
  })
  const ngnRate = rateData?.ngn_per_usd ?? null

  // Jobs the current user has already applied to (for the "Applied" indicator)
  const { data: myApplied } = useQuery<string[]>({
    queryKey: ['myApplications'],
    queryFn: async () => {
      const { data } = await api.get('/applications/mine')
      return data.job_ids as string[]
    },
  })
  const appliedJobIds = new Set(myApplied || [])

  // User's existing vouch job IDs
  const { data: myVouchJobIds } = useQuery<string[]>({
    queryKey: ['myVouchJobIds'],
    queryFn: async () => {
      const { data } = await api.get('/vouches/user/' + user?.id)
      return (data as Vouch[]).map(v => v.job_id)
    },
    enabled: !!user?.id,
  })
  const vouchedJobIds = new Set(myVouchJobIds || [])

  // Contract room messages
  const { data: contractMessages, refetch: refetchMessages } = useQuery<Message[]>({
    queryKey: ['messages', contractRoomJobId],
    queryFn: async () => {
      if (!contractRoomJobId) return []
      const { data } = await api.get(`/messages/job/${contractRoomJobId}`)
      return data
    },
    enabled: !!contractRoomJobId && contractRoomOpen,
    refetchInterval: 5000,
  })

  // Contract room amendments
  const { data: contractAmendments, refetch: refetchAmendments } = useQuery<ScopeAmendment[]>({
    queryKey: ['amendments', contractRoomJobId],
    queryFn: async () => {
      if (!contractRoomJobId) return []
      const { data } = await api.get(`/amendments/job/${contractRoomJobId}`)
      return data
    },
    enabled: !!contractRoomJobId && contractRoomOpen,
    refetchInterval: 5000,
  })

  // Mutations
  const createMutation = useMutation({
    mutationFn: async (payload: any) => {
      const { data } = await api.post('/jobs/', payload)
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      toast.success('Job posted')
      setCreateOpen(false)
      setImageFile(null); setImagePreview(null)
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Failed to post'),
  })

  const applyMutation = useMutation({
    mutationFn: async () => {
      await api.post('/applications/', {
        job_id: applyJobId,
        message: applyData.message,
        proposed_price: applyData.proposed_price || undefined,
        portfolio_url: applyData.portfolio_url || undefined,
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['myApplications'] })
      queryClient.invalidateQueries({ queryKey: ['applicationCount', applyJobId] })
      toast.success('Application sent!')
      setApplyOpen(false)
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Failed to apply'),
  })

  const assignMutation = useMutation({
    mutationFn: async ({ jobId, providerId }: { jobId: string; providerId: string }) => {
      const { data } = await api.post(`/jobs/${jobId}/assign`, { provider_id: providerId })
      return data
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      toast.success('Job assigned! Other applicants notified.')
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Assign failed'),
  })

  const fundMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post(`/jobs/${jobId}/fund`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      toast.success('Escrow funded on Solana!')
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Funding failed'),
  })

  const releaseMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post(`/jobs/${jobId}/release`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      toast.success('Payment released!')
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Release failed'),
  })

  const vouchMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post('/vouches/', { job_id: jobId })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      queryClient.invalidateQueries({ queryKey: ['myVouchJobIds'] })
      toast.success('Vouch recorded – cNFT minting...')
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['jobs'] })
        queryClient.invalidateQueries({ queryKey: ['myVouchJobIds'] })
        toast.success('cNFT minted on Solana!', { id: 'cnft-minted' })
      }, 5000)
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Vouch failed'),
  })

  const sendMessageMutation = useMutation({
    mutationFn: async ({ jobId, content, imageUrl }: { jobId: string; content: string; imageUrl?: string | null }) => {
      await api.post('/messages/', { job_id: jobId, content, image_url: imageUrl })
    },
    onSuccess: () => {
      refetchMessages()
      setMessageText('')
      setMessageImageFile(null)
      setMessageImagePreview(null)
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Message failed'),
  })

  const scopeAmendMutation = useMutation({
    mutationFn: async () => {
      if (!contractRoomJobId || !amendReason || !amendNewPrice) return
      let imageUrl = ''
      if (amendImage) {
        try {
          imageUrl = await uploadFile(amendImage)
        } catch {
          return // upload failed, toast already shown
        }
      }
      await api.post(`/amendments/${contractRoomJobId}`, {
        job_id: contractRoomJobId,
        proposed_by: user?.id === contractRoomJob?.provider_id ? 'provider' : 'client',
        reason: amendReason,
        new_total_price: amendNewPrice,
        additional_cost: 0,
        image_url: imageUrl || undefined,
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
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Amendment failed'),
  })

  const acceptAmendMutation = useMutation({
    mutationFn: async ({ id, accept }: { id: string; accept: boolean }) => {
      await api.post(`/amendments/${id}/accept`, { accept })
    },
    onSuccess: (_, variables) => {
      toast.success(variables.accept ? 'Amendment accepted!' : 'Amendment rejected!')
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      refetchAmendments()
      setContractRoomOpen(false)
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Action failed'),
  })

  const cancelMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post(`/jobs/${jobId}/cancel`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      toast.success('Job cancelled.')
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Cancel failed'),
  })

  // Handlers
  const handlePostJob = async () => {
    if (!formData.title || !formData.price) return toast.error('Title and price required')
    let imageUrl = null
    if (imageFile) {
      try { imageUrl = await uploadFile(imageFile) } catch { return }
    }
    createMutation.mutate({
      title: formData.title,
      description: formData.description,
      price: formData.price,
      min_price: formData.min_price || undefined,
      max_price: formData.max_price || undefined,
      image_url: imageUrl,
    })
  }

  const handleApply = (job: Job) => {
    setApplyJobId(job.id)
    setApplyTargetJob(job)
    setApplyOpen(true)
  }

  const handleAssign = (jobId: string, providerId: string) => assignMutation.mutate({ jobId, providerId })

  const openContractRoom = (job: Job) => {
    setContractRoomJobId(job.id)
    setContractRoomJob(job)
    setContractRoomOpen(true)
  }

  const handleSendMessage = async () => {
    if (sendMessageMutation.isPending) return
    if (!messageText.trim() && !messageImageFile || !contractRoomJobId) return
    let imageUrl = null
    if (messageImageFile) {
      try { imageUrl = await uploadFile(messageImageFile) } catch { return }
    }
    sendMessageMutation.mutate({ jobId: contractRoomJobId, content: messageText || 'Sent an image', imageUrl })
  }

  const acceptMutation = useMutation({
    mutationFn: async (jobId: string) => {
      await api.post(`/jobs/${jobId}/accept-request`)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['jobs'] })
      toast.success('Request accepted! Client can now fund.')
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Failed to accept'),
  })
  
  const handleAccept = (jobId: string) => acceptMutation.mutate(jobId)

  // Derived filtered/sorted arrays
  const applyFiltersAndSort = (jobs: Job[]) => {
    let result = [...jobs]
    if (statusFilter !== 'all') {
      result = result.filter(j => j.status === statusFilter)
    }
    result.sort((a, b) => {
      if (sortOrder === 'newest') return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      if (sortOrder === 'oldest') return new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
      if (sortOrder === 'price_high') return parseFloat(b.price as string) - parseFloat(a.price as string)
      if (sortOrder === 'price_low') return parseFloat(a.price as string) - parseFloat(b.price as string)
      return 0
    })
    return result
  }

  const processedOpenJobs = applyFiltersAndSort(openJobs)
  const processedMyJobs = applyFiltersAndSort(myJobs || [])

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Jobs</h1>
          <p className="text-gray-500">Find work or get things done</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {activeTab === 'mine' && (
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[140px] bg-white border-gray-200">
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="open">Open</SelectItem>
                <SelectItem value="requested">Requested</SelectItem>
                <SelectItem value="assigned">Assigned</SelectItem>
                <SelectItem value="funded">Funded</SelectItem>
                <SelectItem value="in_progress">In Progress</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
                <SelectItem value="cancelled">Cancelled</SelectItem>
              </SelectContent>
            </Select>
          )}
          <Select value={sortOrder} onValueChange={setSortOrder}>
            <SelectTrigger className="w-[160px] bg-white border-gray-200">
              <SelectValue placeholder="Sort by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="newest">Newest First</SelectItem>
              <SelectItem value="oldest">Oldest First</SelectItem>
              <SelectItem value="price_high">Price: High to Low</SelectItem>
              <SelectItem value="price_low">Price: Low to High</SelectItem>
            </SelectContent>
          </Select>
          <Button onClick={() => setCreateOpen(true)} className="bg-black text-white hover:bg-gray-800">
            <Plus className="w-4 h-4 mr-2" /> Post Job
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'open' | 'mine' | 'map')}>
        <TabsList>
          <TabsTrigger value="open"><List className="w-3.5 h-3.5 mr-1.5" />Open Jobs</TabsTrigger>
          <TabsTrigger value="mine">My Jobs</TabsTrigger>
          <TabsTrigger value="map"><Map className="w-3.5 h-3.5 mr-1.5" />Map</TabsTrigger>
        </TabsList>

        <TabsContent value="open" className="mt-6">
          <div className="grid gap-4 md:grid-cols-2">
            {openLoading ? (
              [1,2].map(i => <Card key={i}><CardHeader><Skeleton className="h-5 w-3/4" /></CardHeader></Card>)
            ) : processedOpenJobs.length ? (
              processedOpenJobs.map(job => (
                <JobCard
                  key={job.id}
                  job={job}
                  user={user}
                  onApply={handleApply}
                  onAssign={handleAssign}
                  onFund={(jobId: string) => {
                    const j = openJobs?.find(j => j.id === jobId) || myJobs?.find(j => j.id === jobId)
                    if (j) setConfirmAction({ type: 'fund', jobId, title: j.title })
                  }}
                  onRelease={(jobId: string) => {
                    const j = openJobs?.find(j => j.id === jobId) || myJobs?.find(j => j.id === jobId)
                    if (j) setConfirmAction({ type: 'release', jobId, title: j.title })
                  }}
                  onAccept={(jobId: string) => {
                    const j = openJobs?.find(j => j.id === jobId) || myJobs?.find(j => j.id === jobId)
                    if (j) setConfirmAction({ type: 'accept', jobId, title: j.title })
                  }}
                  onCancel={(jobId: string, title: string) => setConfirmAction({ type: 'cancel', jobId, title })}
                  onVouch={vouchMutation.mutate}
                  onDetail={setDetailJob}
                  onContractRoom={openContractRoom}
                  hasApplied={appliedJobIds.has(job.id)}
                  hasVouched={vouchedJobIds.has(job.id)}
                  onImageClick={setLightboxSrc}
                  applyPending={applyMutation.isPending}
                  assignPending={assignMutation.isPending}
                  fundPending={fundMutation.isPending}
                  releasePending={releaseMutation.isPending}
                  vouchPending={vouchMutation.isPending}
                  acceptPending={acceptMutation.isPending}
                />
              ))
            ) : (
              <div className="col-span-2 text-center py-12 text-gray-500">No open jobs nearby.</div>
            )}
          </div>
          {hasMoreOpenJobs && (
            <div className="flex justify-center mt-6">
              <Button
                variant="outline"
                onClick={() => fetchMoreOpenJobs()}
                disabled={loadingMoreOpenJobs}
                className="px-8"
              >
                {loadingMoreOpenJobs ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
                {loadingMoreOpenJobs ? 'Loading...' : 'Load More Jobs'}
              </Button>
            </div>
          )}
        </TabsContent>

        <TabsContent value="mine" className="mt-6">
          <div className="grid gap-4 md:grid-cols-2">
            {myLoading ? (
              [1].map(i => <Card key={i}><CardHeader><Skeleton className="h-5 w-3/4" /></CardHeader></Card>)
            ) : processedMyJobs.length ? (
              processedMyJobs.map(job => (
                <JobCard
                  key={job.id}
                  job={job}
                  user={user}
                  onApply={handleApply}
                  onAssign={handleAssign}
                  onFund={fundMutation.mutate}
                  onRelease={releaseMutation.mutate}
                  onVouch={vouchMutation.mutate}
                  onDetail={setDetailJob}
                  onContractRoom={openContractRoom}
                  onAccept={handleAccept}
                  onCancel={(jobId, title) => setConfirmAction({ type: 'cancel', jobId, title })}
                  hasApplied={appliedJobIds.has(job.id)}
                  hasVouched={vouchedJobIds.has(job.id)}
                  onImageClick={setLightboxSrc}
                  applyPending={applyMutation.isPending}
                  assignPending={assignMutation.isPending}
                  fundPending={fundMutation.isPending}
                  releasePending={releaseMutation.isPending}
                  vouchPending={vouchMutation.isPending}
                  acceptPending={acceptMutation.isPending}
                />
              ))
            ) : (
              <div className="col-span-2 text-center py-12 text-gray-500">No jobs yet.</div>
            )}
          </div>
        </TabsContent>

        {/* Map Tab */}
        <TabsContent value="map" className="mt-6">
          {geo.latitude && geo.longitude ? (
            <div className="rounded-xl overflow-hidden border border-gray-200 h-[500px]">
              <NeighborhoodMap latitude={geo.latitude} longitude={geo.longitude} type="jobs" />
            </div>
          ) : (
            <div className="text-center py-16 text-gray-500 border border-dashed rounded-xl">
              <Map className="w-10 h-10 mx-auto mb-3 text-gray-300" />
              <p className="font-medium">Location access needed</p>
              <p className="text-sm mt-1">Allow location access in your browser to see jobs on the map.</p>
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Create Job Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg bg-white text-black">
          <DialogHeader><DialogTitle>Post a New Job</DialogTitle></DialogHeader>
          <div className="space-y-4 py-4">
            <Input placeholder="Title *" value={formData.title} onChange={e => setFormData({...formData, title: e.target.value})} />
            <Textarea placeholder="Describe what you want done." value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})} />
            <Input placeholder="Price (₦) *" type="number" value={formData.price} onChange={e => setFormData({...formData, price: e.target.value})} />
            {/* Live NGN → USDC conversion hint */}
            {ngnRate && formData.price && parseFloat(formData.price) > 0 && (
              <p className="text-xs text-gray-500 -mt-2">
                ₦{parseFloat(formData.price).toLocaleString()} ≈{' '}
                <span className="font-medium text-green-700">
                  ${(parseFloat(formData.price) / ngnRate).toFixed(2)} USDC
                </span>
                {' '}(rate: ₦{ngnRate.toFixed(0)}/USD)
              </p>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Input placeholder="Min Price" type="number" value={formData.min_price} onChange={e => setFormData({...formData, min_price: e.target.value})} />
              <Input placeholder="Max Price" type="number" value={formData.max_price} onChange={e => setFormData({...formData, max_price: e.target.value})} />
            </div>
            {/* Image upload */}
            <div>
              <input type="file" accept="image/*" ref={fileRef} className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) { setImageFile(file); setImagePreview(URL.createObjectURL(file)) }
                }}
              />
              {imagePreview ? (
                <div className="relative w-32 h-32">
                  <img src={imagePreview} className="rounded-lg object-cover w-full h-full" />
                  <X className="absolute top-1 right-1 h-4 w-4 bg-white rounded-full cursor-pointer" onClick={() => { setImageFile(null); setImagePreview(null) }} />
                </div>
              ) : (
                <Button variant="outline" onClick={() => fileRef.current?.click()} className="w-full">
                  <ImagePlus className="w-4 h-4 mr-2" /> Add Photo (optional)
                </Button>
              )}
            </div>
            <Button onClick={handlePostJob} disabled={createMutation.isPending} className="w-full bg-black text-white">
              {createMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              {createMutation.isPending ? 'Posting...' : 'Post Job'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Apply Dialog */}
      <Dialog open={applyOpen} onOpenChange={setApplyOpen}>
        <DialogContent className="sm:max-w-md bg-white text-black">
          <DialogHeader><DialogTitle>Apply for {applyTargetJob?.title}</DialogTitle></DialogHeader>
          {applyTargetJob?.image_url && <img src={applyTargetJob.image_url} className="rounded-lg max-h-48 object-cover mb-4" />}
          <div className="space-y-4 py-4">
            <Textarea placeholder="Why are you a good fit?" value={applyData.message} onChange={e => setApplyData({...applyData, message: e.target.value})} />
            <Input placeholder="Proposed price (optional)" type="number" value={applyData.proposed_price} onChange={e => setApplyData({...applyData, proposed_price: e.target.value})} />
            <Input placeholder="Portfolio URL (optional)" value={applyData.portfolio_url} onChange={e => setApplyData({...applyData, portfolio_url: e.target.value})} />
            <Button onClick={() => applyMutation.mutate()} disabled={applyMutation.isPending} className="w-full bg-black text-white">
              {applyMutation.isPending ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : null}
              {applyMutation.isPending ? 'Sending...' : 'Submit Application'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Contract Room Dialog */}
      <Dialog open={contractRoomOpen} onOpenChange={setContractRoomOpen}>
        <DialogContent className="sm:max-w-lg bg-white text-black max-h-[80vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>{contractRoomJob?.title} – Contract Room</DialogTitle>
          </DialogHeader>
          {/* Show job details */}
          {contractRoomJob && (
            <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
              <p>Status: {statusBadge(contractRoomJob.status)}</p>
              <p>Price: ₦{parseFloat(contractRoomJob.price as string).toLocaleString()}</p>
              {contractRoomJob.escrow_address && <p className="text-xs text-green-600">Escrow: {contractRoomJob.escrow_address.slice(0, 8)}...</p>}
              {contractRoomJob.image_url && <img src={contractRoomJob.image_url} className="rounded-lg w-20 h-20 object-cover mt-2 cursor-pointer" onClick={() => setLightboxSrc(contractRoomJob.image_url!)} />}
            </div>
          )}
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
            {contractMessages?.map(msg => (
              <div key={msg.id} className={`flex ${msg.sender_id === user?.id ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[75%] rounded-lg p-3 ${msg.sender_id === user?.id ? 'bg-black text-white' : 'bg-gray-100 text-black'}`}>
                  {msg.image_url && (
                    <img src={msg.image_url} className="rounded-lg max-h-40 object-cover mb-2 cursor-pointer" onClick={() => setLightboxSrc(msg.image_url!)} />
                  )}
                  <p className="text-sm">{msg.content}</p>
                  <span className="text-xs opacity-70">{new Date(msg.created_at).toLocaleTimeString()}</span>
                </div>
              </div>
            ))}
          </div>
          {/* Scope Amendment toggle */}
          {!showScopeAmend ? (
            <div className="border-t pt-2 flex flex-col gap-2">
              {messageImagePreview && (
                <div className="relative w-16 h-16">
                  <img src={messageImagePreview} className="rounded-lg object-cover w-full h-full" />
                  <X className="absolute -top-2 -right-2 h-4 w-4 bg-white text-black border border-gray-300 rounded-full cursor-pointer" onClick={() => { setMessageImageFile(null); setMessageImagePreview(null) }} />
                </div>
              )}
              <div className="flex gap-2 items-center">
                <Button variant="outline" size="sm" onClick={() => document.getElementById('msgImageInput')?.click()}>
                  <ImagePlus className="w-4 h-4" />
                </Button>
                <input id="msgImageInput" type="file" accept="image/*" className="hidden" onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) { setMessageImageFile(file); setMessageImagePreview(URL.createObjectURL(file)) }
                }} />
                <Input placeholder="Type a message..." value={messageText} onChange={e => setMessageText(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleSendMessage()} />
                <Button size="sm" onClick={handleSendMessage} disabled={(!messageText.trim() && !messageImageFile) || sendMessageMutation.isPending} className="bg-black text-white">
                  {sendMessageMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-3 h-3" />}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setShowScopeAmend(true)}><FileText className="w-4 h-4 mr-1" /> Amend</Button>
              </div>
            </div>
          ) : (
            <div className="border-t pt-2 space-y-2">
              <Textarea placeholder="Reason for amendment..." value={amendReason} onChange={e => setAmendReason(e.target.value)} />
              <Input placeholder="New total price" type="number" value={amendNewPrice} onChange={e => setAmendNewPrice(e.target.value)} />
              <div className="flex items-center gap-2">
                <Button variant="outline" onClick={() => document.getElementById('amendImageInput')?.click()}>
                  <ImagePlus className="w-4 h-4 mr-1" /> Attach Image
                </Button>
                <input id="amendImageInput" type="file" accept="image/*" className="hidden" onChange={e => {
                  const file = e.target.files?.[0]
                  if (file) { setAmendImage(file); setAmendImagePreview(URL.createObjectURL(file)) }
                }} />
                {amendImagePreview && <img src={amendImagePreview} className="w-12 h-12 rounded-lg object-cover" />}
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => scopeAmendMutation.mutate()} disabled={!amendReason || !amendNewPrice} className="bg-black text-white">Submit Amendment</Button>
                <Button size="sm" variant="outline" onClick={() => setShowScopeAmend(false)}>Cancel</Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Job Detail Modal */}
      {detailJob && (
        <Dialog open={!!detailJob} onOpenChange={() => setDetailJob(null)}>
          <DialogContent className="sm:max-w-2xl bg-white text-black">
            <DialogHeader><DialogTitle>{detailJob.title}</DialogTitle></DialogHeader>
            <div className="space-y-4">
              {detailJob.image_url && <img src={detailJob.image_url} className="rounded-lg max-h-64 object-cover cursor-pointer" onClick={() => setLightboxSrc(detailJob.image_url!)} />}
              <p>{detailJob.description}</p>
              <div className="flex gap-4 text-sm">
                <span>Price: ₦{parseFloat(detailJob.price as string).toLocaleString()}</span>
                {detailJob.min_price && detailJob.max_price && <span>Range: ₦{detailJob.min_price} – ₦{detailJob.max_price}</span>}
                <span>Status: {statusBadge(detailJob.status)}</span>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {/* Confirmation Dialogs */}
      <ConfirmDialog
        open={confirmAction !== null}
        onOpenChange={() => setConfirmAction(null)}
        title={
          confirmAction?.type === 'fund' ? 'Fund Escrow' :
          confirmAction?.type === 'release' ? 'Release Payment' :
          confirmAction?.type === 'accept' ? 'Accept Request' :
          confirmAction?.type === 'cancel' ? 'Cancel Job' : ''
        }
        description={
          confirmAction?.type === 'fund'
            ? `Are you sure you want to fund "${confirmAction?.title}"? USDC will be locked in a smart contract.`
            : confirmAction?.type === 'release'
            ? `Are you sure you want to release payment for "${confirmAction?.title}"? This will transfer USDC to the provider.`
            : confirmAction?.type === 'accept'
            ? `Accept "${confirmAction?.title}"? The client can then fund the escrow.`
            : confirmAction?.type === 'cancel'
            ? `Are you sure you want to cancel "${confirmAction?.title}"? This action cannot be undone.`
            : ''
        }
        onConfirm={() => {
          if (!confirmAction) return
          const { type, jobId } = confirmAction
          if (type === 'fund') fundMutation.mutate(jobId)
          else if (type === 'release') releaseMutation.mutate(jobId)
          else if (type === 'accept') acceptMutation.mutate(jobId)
          else if (type === 'cancel') cancelMutation.mutate(jobId)
          setConfirmAction(null)
        }}
        confirmLabel="Proceed"
        cancelLabel="Cancel"
        loading={
          confirmAction?.type === 'fund' ? fundMutation.isPending :
          confirmAction?.type === 'release' ? releaseMutation.isPending :
          confirmAction?.type === 'accept' ? acceptMutation.isPending :
          confirmAction?.type === 'cancel' ? cancelMutation.isPending :
          false
        }
      />
      {lightboxSrc && (
        <ImageViewer open={!!lightboxSrc} onClose={() => setLightboxSrc(null)} src={lightboxSrc} />
      )}
    </div>
  )
}

// ─── JobCard ─────────────────────────────────────────
function JobCard({
  job, user,
  onApply, onAssign, onFund, onRelease, onVouch, onDetail, onContractRoom, onAccept, onCancel,
  hasApplied, hasVouched, onImageClick,
  applyPending, assignPending, fundPending, releasePending, vouchPending, acceptPending,
}: {
  job: Job
  user: any
  onApply: (job: Job) => void
  onAssign: (jobId: string, providerId: string) => void
  onFund: (jobId: string) => void
  onRelease: (jobId: string) => void
  onVouch: (jobId: string) => void
  onDetail: (job: Job) => void
  onContractRoom: (job: Job) => void
  onAccept: (jobId: string) => void
  onCancel: (jobId: string, title: string) => void
  hasApplied?: boolean
  hasVouched?: boolean
  onImageClick?: (url: string) => void
  applyPending?: boolean
  assignPending?: boolean
  fundPending?: boolean
  releasePending?: boolean
  vouchPending?: boolean
  acceptPending?: boolean
}) {
  const isClient = user?.id === job.client_id
  const isProvider = user?.id === job.provider_id
  const [showAssign, setShowAssign] = useState(false)
  const [showFullDesc, setShowFullDesc] = useState(false)

  const { data: poster } = useUserInfo(job.client_id)
  const { data: appCount } = useQuery<number>({
    queryKey: ['applicationCount', job.id],
    queryFn: async () => {
      const { data } = await api.get(`/applications/job/${job.id}/count`)
      return data.count as number
    },
  })
  const { data: applicants, isLoading: appsLoading } = useQuery<Application[]>({
    queryKey: ['applicants', job.id],
    queryFn: async () => {
      const { data } = await api.get(`/applications/job/${job.id}`)
      return data
    },
    enabled: showAssign && isClient,
  })

  return (
    <Card className="bg-white border border-gray-100 shadow-sm hover:shadow-md transition-shadow">
      <CardHeader className="pb-2">
        {/* Poster info */}
        <div className="mb-2">
          <UserChip
            userId={job.client_id}
            name={poster?.display_name}
            avatarUrl={poster?.profile_image_url}
            lastSeenAt={(poster as any)?.last_seen_at}
          />
        </div>
        <div className="flex justify-between items-start">
          <div className="flex flex-col items-start gap-1">
            <CardTitle className="text-lg cursor-pointer hover:underline" onClick={() => onDetail(job)}>{job.title}</CardTitle>
            {isClient ? (
              <Badge variant="outline" className="text-blue-600 bg-blue-50 border-blue-200 font-normal">You are the Client</Badge>
            ) : isProvider ? (
              <Badge variant="outline" className="text-purple-600 bg-purple-50 border-purple-200 font-normal">You are the Provider</Badge>
            ) : null}
          </div>
          {statusBadge(job.status)}
        </div>
      </CardHeader>
      <CardContent className="text-sm text-gray-600">
        <div>
          <p className={`mb-1 ${!showFullDesc ? 'line-clamp-2' : ''}`}>{job.description}</p>
          {job.description && job.description.length > 100 && (
            <button className="text-xs text-blue-600 hover:underline" onClick={() => setShowFullDesc(!showFullDesc)}>
              {showFullDesc ? 'See less' : 'See more'}
            </button>
          )}
        </div>
        {job.image_url && (
          <div className="mb-3">
            <img
              src={job.image_url}
              className="rounded-lg w-full h-40 object-cover hover:opacity-90 transition-opacity cursor-pointer"
              onClick={() => onImageClick?.(job.image_url!)}
            />
          </div>
        )}
        <div className="flex justify-between items-center">
          <span className="font-semibold">₦{parseFloat(job.price as string).toLocaleString()}</span>
          {job.escrow_address && <span className="text-xs bg-green-100 text-green-700 px-2 rounded">Escrowed</span>}
        </div>
        {/* Indicators */}
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          {appCount !== undefined && (
            <span className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-700 px-2 py-0.5 rounded-full">
              <UserPlus className="w-3 h-3" /> {appCount} application{appCount !== 1 ? 's' : ''}
            </span>
          )}
          {hasApplied && (
            <span className="inline-flex items-center gap-1 text-xs bg-black text-white px-2 py-0.5 rounded-full">
              <CheckCircle className="w-3 h-3" /> You applied
            </span>
          )}
        </div>
      </CardContent>
      <CardFooter className="pt-4 flex gap-2 flex-wrap">
        {/* Actions based on role and status */}
        {job.status === 'open' && (
          <Button size="sm" variant="outline" onClick={() => onContractRoom(job)}>
            <MessageCircle className="w-3 h-3 mr-1" /> Discuss
          </Button>
        )}
        {job.status === 'open' && !isClient && (
          <Button size="sm" onClick={() => onApply(job)} disabled={hasApplied || applyPending} className="bg-black text-white disabled:opacity-60">
            {applyPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Send className="w-3 h-3 mr-1" />}
            {hasApplied ? 'Applied' : applyPending ? 'Sending...' : 'Apply'}
          </Button>
        )}
        {job.status === 'open' && isClient && (
          <>
            <Button size="sm" variant="outline" className="border-red-300 text-red-600 hover:bg-red-50" onClick={() => onCancel(job.id, job.title)}>
              Cancel
            </Button>
            <Button size="sm" variant="outline" onClick={() => setShowAssign(!showAssign)}>
              <UserPlus className="w-3 h-3 mr-1" /> {showAssign ? 'Hide' : 'View Applicants'}
            </Button>
            {showAssign && (
              <div className="w-full mt-2 space-y-2">
                {appsLoading ? <Skeleton className="h-12 w-full" /> : applicants?.length ? (
                  applicants.map(app => (
                    <div key={app.id} className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                      <div className="flex items-center gap-3">
                        <UserChip
                          userId={app.applicant_id}
                          name={app.applicant_name}
                          avatarUrl={app.applicant_profile_image}
                        />
                        <div>
                          {app.applicant_vouch_count !== undefined && (
                            <p className="text-xs text-gray-500">{app.applicant_vouch_count} vouch{app.applicant_vouch_count !== 1 ? 'es' : ''}</p>
                          )}
                          {app.message && <p className="text-xs text-gray-500 mt-1">{app.message}</p>}
                          {app.proposed_price && <p className="text-xs">Proposed: ₦{app.proposed_price}</p>}
                        </div>
                        {app.portfolio_url && (
                          <a href={app.portfolio_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>
                      <Button size="sm" onClick={() => onAssign(job.id, app.applicant_id)} disabled={assignPending}>
                        Hire
                      </Button>
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-gray-500">No applicants yet.</p>
                )}
              </div>
            )}
          </>
        )}
        {job.status === 'assigned' && isClient && (
          <>
            <Button size="sm" variant="outline" className="border-red-300 text-red-600 hover:bg-red-50" onClick={() => onCancel(job.id, job.title)}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => onFund(job.id)} disabled={fundPending} className="bg-green-600 text-white">
              {fundPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <Shield className="w-3 h-3 mr-1" />}
              {fundPending ? 'Funding...' : 'Fund Escrow'}
            </Button>
          </>
        )}
        {job.status === 'funded' && isClient && (
          <Button size="sm" onClick={() => onRelease(job.id)} disabled={releasePending} className="bg-blue-600 text-white">
            {releasePending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle className="w-3 h-3 mr-1" />}
            {releasePending ? 'Releasing...' : 'Release Pay'}
          </Button>
        )}
        {job.status === 'completed' && isClient && (
          <Button
            size="sm"
            onClick={() => onVouch(job.id)}
            disabled={vouchPending || hasVouched}
            className="bg-yellow-600 text-white disabled:opacity-60"
          >
            {hasVouched ? (
              <><CheckCircle className="w-3 h-3 mr-1" /> Already Vouched</>
            ) : vouchPending ? (
              <><Loader2 className="w-3 h-3 mr-1 animate-spin" /> Vouching...</>
            ) : (
              <><Star className="w-3 h-3 mr-1" /> Vouch</>
            )}
          </Button>
        )}
        {job.status === 'assigned' && isProvider && (
          <Button size="sm" variant="outline" className="border-green-600 text-green-600" onClick={() => onContractRoom(job)}>
            <Play className="w-3 h-3 mr-1" /> Start Working
          </Button>
        )}
        {job.status === 'requested' && isProvider && (
          <>
            <Button size="sm" variant="outline" className="border-red-300 text-red-600 hover:bg-red-50" onClick={() => onCancel(job.id, job.title)}>
              Decline
            </Button>
            <Button size="sm" onClick={() => onAccept(job.id)} disabled={acceptPending} className="bg-green-600 text-white">
              {acceptPending ? <Loader2 className="w-3 h-3 mr-1 animate-spin" /> : <CheckCircle className="w-3 h-3 mr-1" />}
              {acceptPending ? 'Accepting...' : 'Accept'}
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  )
}