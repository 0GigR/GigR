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
import { Shield, UserPlus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { Navigate } from 'react-router-dom'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { MessageCircle } from 'lucide-react'

export default function AdminDashboard() {
  const { user } = useAuthStore()
  const queryClient = useQueryClient()
  const [newAdminEmail, setNewAdminEmail] = useState('')
  const isSuperadmin = user?.role === 'superadmin'
  const [selectedDispute, setSelectedDispute] = useState<any>(null)
  const [courtroomOpen, setCourtroomOpen] = useState(false)

  // Fetch messages for the selected dispute's job
  const { data: courtroomMessages } = useQuery({
    queryKey: ['messages', selectedDispute?.job_id],
    queryFn: async () => {
      if (!selectedDispute?.job_id) return []
      const { data } = await api.get(`/messages/job/${selectedDispute.job_id}`)
      return data
    },
    enabled: !!selectedDispute?.job_id && courtroomOpen,
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
  // Inside the component, before the return:
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
          <TabsTrigger value="disputes">Disputes</TabsTrigger>
          {isSuperadmin && <TabsTrigger value="admins">Admins</TabsTrigger>}
        </TabsList>

        <TabsContent value="disputes" className="mt-6">
          {isLoading ? <Skeleton className="h-24 w-full" /> : 
          disputes?.map((d: any) => (
            <Card key={d.id} className="bg-white border border-gray-100 mb-2">
              <CardHeader className="pb-2">
                {/* <CardTitle className="text-base flex justify-between">
                  <span>{d.job_id?.slice(0, 8)}... — {d.status}</span>
                  <Badge>{d.status}</Badge>
                </CardTitle> */}
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
                    <span className="text-xs opacity-70">{new Date(msg.created_at).toLocaleTimeString()}</span>
                  </div>
                </div>
              ))}
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}