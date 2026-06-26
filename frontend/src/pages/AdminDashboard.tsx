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

export default function AdminDashboard() {
  const { user } = useAuthStore()
  const queryClient = useQueryClient()
  const [newAdminEmail, setNewAdminEmail] = useState('')
  const isSuperadmin = user?.role === 'superadmin'

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
          {isLoading ? <Skeleton className="h-24 w-full" /> : disputes?.map((d: any) => (
            <Card key={d.id} className="bg-white border border-gray-100 mb-2">
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{d.job_id || 'Untitled'} — {d.status}</CardTitle>
              </CardHeader>
              <CardContent className="text-sm space-y-2">
                <p>{d.reason}</p>
                <div className="flex gap-2">
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
    </div>
  )
}