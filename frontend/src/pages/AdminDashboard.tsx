import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuthStore } from '@/store/authStore'
import { Shield, UserPlus, Trash2, MessageCircle, ImagePlus, X, Send } from 'lucide-react'
import { useState, useRef } from 'react'
import { Navigate } from 'react-router-dom'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

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
  return data.secure_url
}

export default function AdminDashboard() {
  const { user } = useAuthStore()
  const queryClient = useQueryClient()
  const [newAdminEmail, setNewAdminEmail] = useState('')
  const isSuperadmin = user?.role === 'superadmin'

  // Courtroom state
  const [selectedDispute, setSelectedDispute] = useState<any>(null)
  const [courtroomOpen, setCourtroomOpen] = useState(false)
  const [messageText, setMessageText] = useState('')
  const [msgImageFile, setMsgImageFile] = useState<File | null>(null)
  const [msgImagePreview, setMsgImagePreview] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Fetch all disputes
  const { data: disputes, isLoading } = useQuery({
    queryKey: ['admin-disputes'],
    queryFn: async () => {
      const { data } = await api.get('/disputes/')
      return data
    },
  })

  // Fetch all admins (superadmin only)
  const { data: admins } = useQuery({
    queryKey: ['admins'],
    queryFn: async () => {
      const { data } = await api.get('/admin/admins')
      return data
    },
    enabled: isSuperadmin,
  })

  // Fetch messages for selected dispute
  const { data: courtroomMessages, refetch: refetchMessages } = useQuery({
    queryKey: ['messages', selectedDispute?.job_id],
    queryFn: async () => {
      if (!selectedDispute?.job_id) return []
      const { data } = await api.get(`/messages/job/${selectedDispute.job_id}`)
      return data
    },
    enabled: !!selectedDispute?.job_id && courtroomOpen,
    refetchInterval: 5000,
  })

  // Fetch job details
  const { data: selectedJob } = useQuery({
    queryKey: ['job', selectedDispute?.job_id],
    queryFn: async () => {
      if (!selectedDispute?.job_id) return null
      const { data } = await api.get(`/jobs/${selectedDispute.job_id}`)
      return data
    },
    enabled: !!selectedDispute?.job_id && courtroomOpen,
  })

  // Mutations
  const createAdminMutation = useMutation({
    mutationFn: async (email: string) => {
      await api.post('/admin/admins/create', { email })
    },
    onSuccess: () => {
      toast.success('Admin created')
      queryClient.invalidateQueries({ queryKey: ['admins'] })
      setNewAdminEmail('')
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Failed'),
  })

  const deleteAdminMutation = useMutation({
    mutationFn: async (userId: string) => {
      await api.delete(`/admin/admins/${userId}`)
    },
    onSuccess: () => {
      toast.success('Admin removed')
      queryClient.invalidateQueries({ queryKey: ['admins'] })
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Failed'),
  })

  const resolveMutation = useMutation({
    mutationFn: async ({ disputeId, resolution }: { disputeId: string; resolution: string }) => {
      await api.post(`/disputes/${disputeId}/resolve`, { resolution })
    },
    onSuccess: () => {
      toast.success('Dispute resolved')
      queryClient.invalidateQueries({ queryKey: ['admin-disputes'] })
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Failed'),
  })

  const sendMessageMutation = useMutation({
    mutationFn: async ({ jobId, content, imageUrl }: { jobId: string; content: string; imageUrl?: string | null }) => {
      await api.post('/messages/', { job_id: jobId, content, image_url: imageUrl })
    },
    onSuccess: () => {
      refetchMessages()
      setMessageText('')
      setMsgImageFile(null)
      setMsgImagePreview(null)
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Message failed'),
  })

  const handleSendMessage = async () => {
    if (!messageText.trim() && !msgImageFile) return
    if (!selectedDispute?.job_id) return
    let imageUrl = null
    if (msgImageFile) {
      try { imageUrl = await uploadFile(msgImageFile) } catch { return }
    }
    sendMessageMutation.mutate({
      jobId: selectedDispute.job_id,
      content: messageText || 'Sent an image',
      imageUrl,
    })
    setMessageText('')
  }

  // Permission guard
  if (!user || (user.role !== 'admin' && user.role !== 'superadmin')) {
    return <Navigate to="/dashboard" replace />
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Shield className="w-7 h-7" /> Admin Dashboard
        </h1>
        <p className="text-gray-500">Manage disputes and administrators.</p>
      </div>
      <Tabs defaultValue="disputes">
        <TabsList>
          <TabsTrigger value="disputes">Active</TabsTrigger>
          <TabsTrigger value="resolved">Resolved</TabsTrigger>
          {isSuperadmin && <TabsTrigger value="admins">Admins</TabsTrigger>}
        </TabsList>

        <TabsContent value="disputes" className="mt-6">
          {isLoading ? <Skeleton className="h-24 w-full" /> : 
          (disputes as any[])?.filter(d => d.status === 'open').map((d: any) => (
            <Card key={d.id} className="bg-white border border-gray-100 mb-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex justify-between">
                  <span>{d.job_title || 'Untitled'} — {d.status}</span>
                  <Badge>{d.status}</Badge>
                </CardTitle>
                <p className="text-xs text-gray-500">
                  Client: {d.client_name} | Provider: {d.provider_name}
                </p>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <p>{d.reason}</p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => {
                    setSelectedDispute(d)
                    setCourtroomOpen(true)
                  }}>
                    <MessageCircle className="w-3 h-3 mr-1" /> View Courtroom
                  </Button>
                  <Button size="sm" onClick={() => resolveMutation.mutate({ disputeId: d.id, resolution: 'refund' })}>
                    Refund
                  </Button>
                  <Button size="sm" onClick={() => resolveMutation.mutate({ disputeId: d.id, resolution: 'release' })}>
                    Release
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="resolved" className="mt-6">
          {isLoading ? <Skeleton className="h-24 w-full" /> : 
          (disputes as any[])?.filter(d => d.status !== 'open').map((d: any) => (
            <Card key={d.id} className="bg-white border border-gray-100 mb-2 opacity-70">
              <CardHeader className="pb-2">
                <CardTitle className="text-base flex justify-between">
                  <span>{d.job_title || 'Untitled'} — {d.status}</span>
                  <Badge variant="secondary">{d.resolution || d.status}</Badge>
                </CardTitle>
                <p className="text-xs text-gray-500">
                  Client: {d.client_name} | Provider: {d.provider_name}
                </p>
              </CardHeader>
              <CardContent className="text-sm">
                <p>{d.reason}</p>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
        
        {isSuperadmin && (
          <TabsContent value="admins" className="mt-6">
            <div className="flex gap-2 mb-4">
              <Input placeholder="Email address" value={newAdminEmail} onChange={(e) => setNewAdminEmail(e.target.value)} />
              <Button onClick={() => createAdminMutation.mutate(newAdminEmail)} disabled={!newAdminEmail}>
                <UserPlus className="w-4 h-4 mr-1" /> Add Admin
              </Button>
            </div>
            {admins?.map((a: any) => (
              <Card key={a.id} className="bg-white border border-gray-100 mb-2">
                <CardHeader className="pb-2">
                  <div className="flex justify-between">
                    <CardTitle className="text-base">{a.display_name} ({a.email})</CardTitle>
                    <Badge>{a.role}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  <Button size="sm" variant="destructive" onClick={() => deleteAdminMutation.mutate(a.id)}>
                    <Trash2 className="w-4 h-4 mr-1" /> Remove
                  </Button>
                </CardContent>
              </Card>
            ))}
          </TabsContent>
        )}
      </Tabs>

      {/* Courtroom Dialog */}
      {selectedDispute && (
        <Dialog open={courtroomOpen} onOpenChange={setCourtroomOpen}>
          <DialogContent className="sm:max-w-2xl bg-white text-black max-h-[85vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Courtroom – Dispute {selectedDispute.id.slice(0,8)}</DialogTitle>
            </DialogHeader>

            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm space-y-2">
              <p><strong>Reason:</strong> {selectedDispute.reason}</p>
              {selectedJob && (
                <>
                  <p><strong>Job:</strong> {selectedJob.title} – ₦{parseFloat(selectedJob.price).toLocaleString()}</p>
                  <p><strong>Client:</strong> {selectedJob.client_id}</p>
                  <p><strong>Provider:</strong> {selectedJob.provider_id}</p>
                </>
              )}
            </div>

            <div className="flex-1 overflow-y-auto space-y-2 py-2">
              {courtroomMessages?.map((msg: any) => (
                <div key={msg.id} className={`flex ${msg.sender_id === user?.id ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[75%] rounded-lg p-3 ${msg.sender_id === user?.id ? 'bg-black text-white' : 'bg-gray-100 text-black'}`}>
                    <p className="text-sm">{msg.content}</p>
                    {msg.image_url && (
                      <a href={msg.image_url} target="_blank" rel="noopener noreferrer">
                        <img src={msg.image_url} className="rounded-lg max-h-40 object-cover mt-2" />
                      </a>
                    )}
                    <span className="text-xs opacity-70">{new Date(msg.created_at).toLocaleTimeString()}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Admin chat input */}
            <div className="border-t pt-2 flex flex-col gap-2">
              {msgImagePreview && (
                <div className="relative w-16 h-16">
                  <img src={msgImagePreview} className="rounded-lg object-cover w-full h-full" />
                  <X className="absolute -top-2 -right-2 h-4 w-4 bg-white text-black border border-gray-300 rounded-full cursor-pointer"
                     onClick={() => { setMsgImageFile(null); setMsgImagePreview(null) }} />
                </div>
              )}
              <div className="flex gap-2 items-center">
                <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                  <ImagePlus className="w-4 h-4" />
                </Button>
                <input type="file" accept="image/*" ref={fileInputRef} className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (file) {
                      setMsgImageFile(file)
                      setMsgImagePreview(URL.createObjectURL(file))
                    }
                  }}
                />
                <Input
                  placeholder="Ask a question as Admin..."
                  value={messageText}
                  onChange={(e) => setMessageText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                />
                <Button size="sm" onClick={handleSendMessage}
                  disabled={(!messageText.trim() && !msgImageFile) || sendMessageMutation.isPending}
                  className="bg-black text-white">
                  <Send className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}