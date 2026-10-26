import { useState } from 'react'
import { toast } from 'sonner'
import { CheckCircle2, Landmark, Loader2 } from 'lucide-react'
import api, { extractError } from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { useRail } from '@/lib/config'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Where a provider gets paid. Released escrow is sent with the PayPal Payouts
 * API to this account, and a client can't fund a job until it's set — Gigr never
 * captures money it has no way to pay out.
 */
export function PayoutAccountCard() {
  const user = useAuthStore((s) => s.user)
  const fetchUser = useAuthStore((s) => s.fetchUser)
  const { paypalEnv, feePercent } = useRail()
  const [email, setEmail] = useState(user?.paypal_email ?? '')
  const [saving, setSaving] = useState(false)

  const linked = !!user?.paypal_email
  const dirty = email.trim().toLowerCase() !== (user?.paypal_email ?? '').toLowerCase()
  const valid = EMAIL_RE.test(email.trim())

  const save = async () => {
    setSaving(true)
    try {
      await api.patch('/users/me', { paypal_email: email.trim() })
      await fetchUser()
      toast.success('PayPal account linked — you can now be paid through escrow.')
    } catch (err) {
      toast.error(extractError(err, 'Could not save your PayPal email'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-xl border border-blue-100 dark:border-blue-800 bg-blue-50/60 dark:bg-blue-950/40 p-3">
        <Landmark className="mt-0.5 h-5 w-5 shrink-0 text-blue-600 dark:text-blue-400" />
        <div className="text-sm text-blue-900 dark:text-blue-400">
          <p className="font-medium">Get paid through PayPal</p>
          <p className="text-xs text-blue-800/80 dark:text-blue-400">
            Clients pay into escrow held in PayPal. When they release it (or the review window ends)
            it's sent straight to the PayPal account below
            {feePercent > 0 ? ` — less Gigr's ${feePercent}% fee` : ''}.
          </p>
        </div>
      </div>

      <label className="block text-xs font-medium text-gray-600 dark:text-muted-foreground" htmlFor="paypal-email">
        PayPal account email
      </label>
      <div className="flex gap-2">
        <Input
          id="paypal-email"
          type="email"
          inputMode="email"
          autoComplete="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Button onClick={save} disabled={saving || !dirty || !valid}>
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Save'}
        </Button>
      </div>

      {linked && !dirty ? (
        <p className="flex items-center gap-1.5 text-xs text-green-700 dark:text-green-400">
          <CheckCircle2 className="h-3.5 w-3.5" /> Payouts go to {user?.paypal_email}
        </p>
      ) : (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Add the PayPal email you want payouts sent to — clients can't fund your jobs until you do.
        </p>
      )}
      {paypalEnv === 'sandbox' && (
        <p className="text-[11px] text-gray-400">
          Sandbox mode: use a PayPal <em>sandbox</em> personal account email — no real money moves.
        </p>
      )}
    </div>
  )
}
