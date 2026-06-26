import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import api from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useAuthStore } from '@/store/authStore'
import { Gavel, MessageCircle, Send, AlertTriangle } from 'lucide-react'

type JuryDispute = {
  id: string
  job_id: string
  job_title: string | null
  reason: string
  status: string
  resolution: string | null
  has_voted: boolean
  created_at: string | null
}

type Message = {
  id: string
  sender_id: string
  content: string
  created_at: string
}

const statusBadge = (status: string) => {
  switch (status) {
    case 'open':
      return <Badge className="bg-yellow-100 text-yellow-800">Open for voting</Badge>
    case 'resolved':
      return <Badge className="bg-black text-white">Resolved</Badge>
    default:
      return <Badge>{status}</Badge>
  }
}

export default function DisputesPage() {
  const { user } = useAuthStore()
  const queryClient = useQueryClient()
  const [activeTab, setActiveTab] = useState<'jury' | 'mine'>('jury')
  const [selectedDispute, setSelectedDispute] = useState<JuryDispute | null>(null)
  const [courtroomOpen, setCourtroomOpen] = useState(false)
  const [messageText, setMessageText] = useState('')

  // Fetch jury duties
  const { data: juryDisputes, isLoading: juryLoading } = useQuery<JuryDispute[]>({
    queryKey: ['my-jury'],
    queryFn: async () => {
      const { data } = await api.get('/disputes/my-jury')
      return data
    },
  })

  // Fetch disputes where user is a party
  const { data: myDisputes, isLoading: myLoading } = useQuery({
    queryKey: ['my-disputes'],
    queryFn: async () => {
      const [asClient, asProvider] = await Promise.all([
        api.get('/jobs/', { params: { my: 'client', status: 'disputed' } }),
        api.get('/jobs/', { params: { my: 'provider', status: 'disputed' } }),
      ])
      return [...asClient.data, ...asProvider.data]
    },
  })

  // Fetch courtroom messages
  const { data: courtroomMessages, refetch: refetchMessages } = useQuery<Message[]>({
    queryKey: ['messages', selectedDispute?.job_id],
    queryFn: async () => {
      if (!selectedDispute?.job_id) return []
      const { data } = await api.get(`/messages/job/${selectedDispute.job_id}`)
      return data
    },
    enabled: !!selectedDispute?.job_id && courtroomOpen,
    refetchInterval: 5000,
  })

  // Vote mutation
  const voteMutation = useMutation({
    mutationFn: async ({ disputeId, vote }: { disputeId: string; vote: 'for_client' | 'for_provider' }) => {
      await api.post(`/disputes/${disputeId}/vote`, { dispute_id: disputeId, vote })
    },
    onSuccess: () => {
      toast.success('Vote cast — thank you for serving on the jury.')
      queryClient.invalidateQueries({ queryKey: ['my-jury'] })
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Failed to cast vote'),
  })

  // Withdraw dispute mutation
  const withdrawMutation = useMutation({
    mutationFn: async (disputeId: string) => {
      await api.post(`/disputes/${disputeId}/withdraw`)
    },
    onSuccess: () => {
      toast.success('Dispute withdrawn. Job is now active.')
      queryClient.invalidateQueries({ queryKey: ['my-disputes'] })
      queryClient.invalidateQueries({ queryKey: ['my-jury'] })
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Failed to withdraw'),
  })

  // Send message in courtroom
  const sendMessageMutation = useMutation({
    mutationFn: async ({ jobId, content }: { jobId: string; content: string }) => {
      await api.post('/messages/', { job_id: jobId, content })
    },
    onSuccess: () => {
      refetchMessages()
      setMessageText('')
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Message failed'),
  })

  const openCourtroom = (dispute: JuryDispute) => {
    setSelectedDispute(dispute)
    setCourtroomOpen(true)
  }

  const handleSendMessage = () => {
    if (!messageText.trim() || !selectedDispute?.job_id) return
    sendMessageMutation.mutate({ jobId: selectedDispute.job_id, content: messageText })
  }

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Gavel className="w-7 h-7" /> Disputes & Courtroom
        </h1>
        <p className="text-gray-500">Review cases, vote as a juror, or manage your disputes.</p>
      </div>

      <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'jury' | 'mine')}>
        <TabsList>
          <TabsTrigger value="jury">Jury Duty ({juryDisputes?.length || 0})</TabsTrigger>
          <TabsTrigger value="mine">My Disputes ({myDisputes?.length || 0})</TabsTrigger>
        </TabsList>

        <TabsContent value="jury" className="mt-6">
          {juryLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !juryDisputes || juryDisputes.length === 0 ? (
            <div className="text-center py-12 text-gray-500">You have no jury duties right now.</div>
          ) : (
            <div className="space-y-3">
              {juryDisputes.map((d) => {
                const closed = d.status === 'resolved' || d.has_voted
                return (
                  <Card key={d.id} className="bg-white border border-gray-100">
                    <CardHeader className="pb-2">
                      <div className="flex justify-between items-start">
                        <CardTitle className="text-base">{d.job_title || 'Untitled job'}</CardTitle>
                        {statusBadge(d.status)}
                      </div>
                    </CardHeader>
                    <CardContent className="text-sm space-y-3">
                      <p className="text-gray-600"><strong>Reason:</strong> {d.reason}</p>

                      {d.status === 'resolved' ? (
                        <p className="text-xs text-gray-500">Resolved{d.resolution ? ` — ${d.resolution}` : ''}.</p>
                      ) : d.has_voted ? (
                        <p className="text-xs text-green-600">You have voted. Awaiting the rest of the panel.</p>
                      ) : (
                        <div className="flex gap-2 flex-wrap">
                          <Button size="sm" onClick={() => openCourtroom(d)} variant="outline">
                            <MessageCircle className="w-3 h-3 mr-1" /> View Courtroom
                          </Button>
                          <Button
                            size="sm"
                            className="bg-amber-600 text-white"
                            disabled={closed || voteMutation.isPending}
                            onClick={() => voteMutation.mutate({ disputeId: d.id, vote: 'for_client' })}
                          >
                            Vote: Refund
                          </Button>
                          <Button
                            size="sm"
                            className="bg-blue-600 text-white"
                            disabled={closed || voteMutation.isPending}
                            onClick={() => voteMutation.mutate({ disputeId: d.id, vote: 'for_provider' })}
                          >
                            Vote: Release
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                )
              })}
            </div>
          )}
        </TabsContent>

        <TabsContent value="mine" className="mt-6">
          {myLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : !myDisputes || myDisputes.length === 0 ? (
            <div className="text-center py-12 text-gray-500">You have no active disputes.</div>
          ) : (
            <div className="space-y-3">
              {(myDisputes as any[]).map((job: any) => (
                <Card key={job.id} className="bg-white border border-gray-100">
                  <CardHeader className="pb-2">
                    <div className="flex justify-between items-start">
                      <CardTitle className="text-base">{job.title}</CardTitle>
                      <Badge className="bg-red-100 text-red-800">Disputed</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="text-sm space-y-2">
                    <p className="text-gray-600">Price: ₦{parseFloat(job.price as string).toLocaleString()}</p>
                    {job.escrow_address && (
                      <p className="text-xs text-green-600">Escrow: {job.escrow_address.slice(0, 8)}...</p>
                    )}
                    <div className="flex gap-2">
                      <Button size="sm" variant="outline" onClick={() => {
                        // Find the dispute for this job and open courtroom
                        const d = juryDisputes?.find(dd => dd.job_id === job.id)
                        if (d) openCourtroom(d)
                      }}>
                        <MessageCircle className="w-3 h-3 mr-1" /> Courtroom
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => {
                        // Withdraw dispute — need dispute ID
                        const d = juryDisputes?.find(dd => dd.job_id === job.id)
                        if (d) withdrawMutation.mutate(d.id)
                      }}>
                        <AlertTriangle className="w-3 h-3 mr-1" /> Withdraw
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Courtroom Dialog */}
      {selectedDispute && (
        <Dialog open={courtroomOpen} onOpenChange={setCourtroomOpen}>
          <DialogContent className="sm:max-w-2xl bg-white text-black max-h-[85vh] flex flex-col">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Gavel className="w-5 h-5" /> Courtroom — {selectedDispute.job_title}
              </DialogTitle>
            </DialogHeader>

            {/* Case details */}
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-4 text-sm space-y-2">
              <p><strong>Dispute Reason:</strong> {selectedDispute.reason}</p>
              <p><strong>Status:</strong> {statusBadge(selectedDispute.status)}</p>
              <p className="text-xs text-gray-500">Both parties and selected jurors can present arguments and evidence here.</p>
            </div>

            {/* Messages / Evidence */}
            <div className="flex-1 overflow-y-auto space-y-2 py-2">
              {courtroomMessages?.map((msg: Message) => (
                <div key={msg.id} className={`flex ${msg.sender_id === user?.id ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[75%] rounded-lg p-3 ${msg.sender_id === user?.id ? 'bg-black text-white' : 'bg-gray-100 text-black'}`}>
                    <p className="text-sm">{msg.content}</p>
                    <span className="text-xs opacity-70">{new Date(msg.created_at).toLocaleTimeString()}</span>
                  </div>
                </div>
              ))}
            </div>

            {/* Message input */}
            <div className="border-t pt-2 flex gap-2">
              <Input
                placeholder="Present your argument..."
                value={messageText}
                onChange={(e) => setMessageText(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
              />
              <Button size="sm" onClick={handleSendMessage} disabled={!messageText.trim()} className="bg-black text-white">
                <Send className="w-4 h-4" />
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}