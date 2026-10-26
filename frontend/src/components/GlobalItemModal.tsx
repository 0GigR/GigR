import { fmtPrice } from '@/store/currencyStore'
import { useEffect, useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '@/lib/api'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import type { components } from '@/types/api'

type Job = components['schemas']['JobOut']
type Service = components['schemas']['ServiceOut']

const statusBadge = (status: string) => {
  switch (status) {
    case 'open': return <Badge className="bg-blue-100 dark:bg-blue-950/50 text-blue-800 dark:text-blue-400">Open</Badge>
    case 'assigned': return <Badge className="bg-yellow-100 dark:bg-yellow-950/50 text-yellow-800 dark:text-yellow-400">Assigned</Badge>
    case 'funded': return <Badge className="bg-green-100 dark:bg-green-950/50 text-green-800 dark:text-green-400">Funded</Badge>
    case 'in_progress': return <Badge className="bg-purple-100 dark:bg-purple-950/50 text-purple-800 dark:text-purple-400">In Progress</Badge>
    case 'completed': return <Badge className="bg-black text-white">Completed</Badge>
    case 'cancelled': return <Badge className="bg-red-100 dark:bg-red-950/50 text-red-800 dark:text-red-400">Canceled</Badge>
    default: return <Badge>{status}</Badge>
  }
}

export default function GlobalItemModal() {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()
  
  const jobId = searchParams.get('jobId')
  const serviceId = searchParams.get('serviceId')
  
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    if (jobId || serviceId) setIsOpen(true)
    else setIsOpen(false)
  }, [jobId, serviceId])

  const handleClose = () => {
    setIsOpen(false)
    // Remove query params
    searchParams.delete('jobId')
    searchParams.delete('serviceId')
    navigate({ search: searchParams.toString() }, { replace: true })
  }

  const { data: job, isLoading: jobLoading } = useQuery<Job>({
    queryKey: ['job', jobId],
    queryFn: async () => {
      const { data } = await api.get(`/jobs/${jobId}`)
      return data
    },
    enabled: !!jobId,
  })

  const { data: service, isLoading: serviceLoading } = useQuery<Service>({
    queryKey: ['service', serviceId],
    queryFn: async () => {
      const { data } = await api.get(`/services/${serviceId}`)
      return data
    },
    enabled: !!serviceId,
  })

  const isLoading = jobLoading || serviceLoading

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
      <DialogContent className="sm:max-w-2xl bg-white dark:bg-card text-black dark:text-foreground">
        {isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-6 w-3/4" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : job ? (
          <>
            <DialogHeader><DialogTitle>{job.title}</DialogTitle></DialogHeader>
            <div className="space-y-4">
              {job.image_url && <img src={job.image_url} className="rounded-lg max-h-64 object-cover w-full" />}
              <p className="whitespace-pre-wrap">{job.description}</p>
              <div className="flex gap-4 text-sm font-medium">
                <span>Price: {fmtPrice(parseFloat(job.price as string))}</span>
                {job.min_price && job.max_price && <span>Range: {fmtPrice(job.min_price)} – {fmtPrice(job.max_price)}</span>}
                <span>Status: {statusBadge(job.status)}</span>
              </div>
            </div>
          </>
        ) : service ? (
          <>
            <DialogHeader><DialogTitle>{service.title}</DialogTitle></DialogHeader>
            <div className="space-y-4">
              {service.image_url && <img src={service.image_url} className="rounded-lg max-h-64 object-cover w-full" />}
              <p className="whitespace-pre-wrap">{service.description}</p>
              <div className="flex gap-4 text-sm font-medium items-center">
                <span>Price: {fmtPrice(parseFloat(service.price as string))}</span>
                <Badge variant={service.is_active ? 'default' : 'secondary'} className={service.is_active ? 'bg-black text-white' : 'bg-gray-200 dark:bg-secondary text-gray-600 dark:text-muted-foreground'}>
                  {service.is_active ? 'Active' : 'Paused'}
                </Badge>
              </div>
            </div>
          </>
        ) : (
          <div className="p-4 text-center text-gray-500 dark:text-muted-foreground">Item not found.</div>
        )}
      </DialogContent>
    </Dialog>
  )
}
