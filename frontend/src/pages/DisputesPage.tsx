import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import api from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Button } from '@/components/ui/button'
import { Gavel } from 'lucide-react'

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
  const queryClient = useQueryClient()

  const { data: disputes, isLoading } = useQuery<JuryDispute[]>({
    queryKey: ['my-jury'],
    queryFn: async () => {
      const { data } = await api.get('/disputes/my-jury')
      return data
    },
  })

  const voteMutation = useMutation({
    mutationFn: async ({
      disputeId,
      vote,
    }: {
      disputeId: string
      vote: 'for_client' | 'for_provider'
    }) => {
      await api.post(`/disputes/${disputeId}/vote`, {
        dispute_id: disputeId,
        vote,
      })
    },
    onSuccess: () => {
      toast.success('Vote cast — thank you for serving on the jury.')
      queryClient.invalidateQueries({ queryKey: ['my-jury'] })
    },
    onError: (err: any) =>
      toast.error(err.response?.data?.detail || 'Failed to cast vote'),
  })

  return (
    <div className="space-y-6 animate-in fade-in duration-500">
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <Gavel className="w-7 h-7" /> Jury Duty
        </h1>
        <p className="text-gray-500">
          Review disputes in your neighbourhood and vote on a fair outcome.
        </p>
      </div>

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : !disputes || disputes.length === 0 ? (
        <div className="text-center py-12 text-gray-500">
          You have no disputes to vote on right now.
        </div>
      ) : (
        <div className="space-y-3">
          {disputes.map((d) => {
            const closed = d.status === 'resolved' || d.has_voted
            return (
              <Card key={d.id} className="bg-white border border-gray-100">
                <CardHeader className="pb-2">
                  <div className="flex justify-between items-start">
                    <CardTitle className="text-base">
                      {d.job_title || 'Untitled job'}
                    </CardTitle>
                    {statusBadge(d.status)}
                  </div>
                </CardHeader>
                <CardContent className="text-sm space-y-3">
                  <p className="text-gray-600">
                    <strong>Dispute reason:</strong> {d.reason}
                  </p>

                  {d.status === 'resolved' ? (
                    <p className="text-xs text-gray-500">
                      Resolved{d.resolution ? ` — ${d.resolution}` : ''}.
                    </p>
                  ) : d.has_voted ? (
                    <p className="text-xs text-green-600">
                      ✓ You have voted. Awaiting the rest of the panel.
                    </p>
                  ) : (
                    <div className="flex gap-2 flex-wrap">
                      <Button
                        size="sm"
                        className="bg-amber-600 text-white"
                        disabled={closed || voteMutation.isPending}
                        onClick={() =>
                          voteMutation.mutate({
                            disputeId: d.id,
                            vote: 'for_client',
                          })
                        }
                      >
                        Vote for client (refund)
                      </Button>
                      <Button
                        size="sm"
                        className="bg-blue-600 text-white"
                        disabled={closed || voteMutation.isPending}
                        onClick={() =>
                          voteMutation.mutate({
                            disputeId: d.id,
                            vote: 'for_provider',
                          })
                        }
                      >
                        Vote for provider (release)
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
