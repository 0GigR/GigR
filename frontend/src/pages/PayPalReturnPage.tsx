import { useEffect, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Loader2, AlertTriangle } from 'lucide-react'
import api, { extractError } from '@/lib/api'
import { Button } from '@/components/ui/button'

/**
 * PayPal sends the payer back here after they approve (or the agent's link is
 * opened by the human). We capture the order into escrow, which flips the job to
 * "funded". Capture is idempotent server-side, so a refresh is harmless.
 */
export default function PayPalReturnPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const jobId = params.get('job')
  const orderId = params.get('token') // PayPal puts the order id in `token`
  const missing = !jobId || !orderId

  const [state, setState] = useState<'working' | 'done' | 'error'>(missing ? 'error' : 'working')
  const [message, setMessage] = useState(missing ? 'This PayPal return link is missing its job or order.' : '')
  const started = useRef(false)

  useEffect(() => {
    if (started.current || !jobId || !orderId) return
    started.current = true

    api
      .post(`/jobs/${jobId}/paypal/capture`, { order_id: orderId })
      .then(() => {
        setState('done')
        queryClient.invalidateQueries({ queryKey: ['myActivity'] })
        queryClient.invalidateQueries({ queryKey: ['jobs'] })
        queryClient.invalidateQueries({ queryKey: ['job-payment', jobId] })
        queryClient.invalidateQueries({ queryKey: ['jobMilestones'] })
        setTimeout(() => navigate('/dashboard/activity', { replace: true }), 1800)
      })
      .catch((err) => {
        setState('error')
        setMessage(extractError(err, 'We could not confirm your PayPal payment.'))
      })
  }, [jobId, orderId, navigate, queryClient])

  return (
    <div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      {state === 'working' && (
        <>
          <Loader2 className="h-10 w-10 animate-spin text-blue-600 dark:text-blue-400" />
          <h1 className="text-xl font-semibold">Securing your payment in escrow…</h1>
          <p className="text-sm text-gray-500 dark:text-muted-foreground">Confirming with PayPal. This takes a few seconds.</p>
        </>
      )}
      {state === 'done' && (
        <>
          <CheckCircle2 className="h-10 w-10 text-green-600 dark:text-green-400" />
          <h1 className="text-xl font-semibold">Escrow funded</h1>
          <p className="text-sm text-gray-500 dark:text-muted-foreground">
            Your payment is held safely. The provider can start work — you release it (the whole job, or each milestone) when you're happy.
          </p>
        </>
      )}
      {state === 'error' && (
        <>
          <AlertTriangle className="h-10 w-10 text-amber-500" />
          <h1 className="text-xl font-semibold">Payment not confirmed</h1>
          <p className="text-sm text-gray-600 dark:text-muted-foreground">{message}</p>
          <Button onClick={() => navigate('/dashboard/activity', { replace: true })}>Back to my jobs</Button>
        </>
      )}
    </div>
  )
}
