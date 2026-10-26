import { extractError } from '@/lib/api'
import { useState } from 'react'
import { Link } from 'react-router-dom'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { normalizePhoneNumber } from '@/lib/phone'
import { Mail, MailCheck, AlertCircle, ArrowLeft } from 'lucide-react'

export default function ForgotPasswordPage() {
  const [identifier, setIdentifier] = useState('')
  const [error, setError] = useState('')
  const [sent, setSent] = useState(false)
  const [loading, setLoading] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const trimmed = identifier.trim()
    if (!trimmed) {
      setError('Please enter your registered email address or phone number.')
      return
    }

    let cleanIdentifier = trimmed
    if (trimmed.includes('@')) {
      cleanIdentifier = trimmed.toLowerCase()
    } else {
      const normalized = normalizePhoneNumber(trimmed)
      if (normalized) {
        cleanIdentifier = normalized
      }
    }

    setLoading(true)
    try {
      await api.post('/auth/forgot-password', { email: cleanIdentifier })
      setSent(true)
    } catch (err: any) {
      setError(extractError(err, 'Could not send reset link. Please try again.'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-background px-4 py-8">
      <Card className="w-full max-w-md bg-white dark:bg-card border-gray-200 dark:border-border shadow-sm">
        <CardHeader>
          <CardTitle className="text-2xl font-bold tracking-tight">Reset your password</CardTitle>
          <CardDescription>
            Enter your email or phone number and we will send a one-time reset link to your email.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {sent ? (
            <div className="text-center py-6 space-y-4">
              <div className="w-12 h-12 rounded-full bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200 dark:border-emerald-800 flex items-center justify-center mx-auto text-emerald-600 dark:text-emerald-400">
                <MailCheck className="w-6 h-6" />
              </div>
              <div>
                <h3 className="font-semibold text-base text-gray-900 dark:text-foreground">Check your inbox</h3>
                <p className="text-xs text-gray-500 dark:text-muted-foreground mt-1 max-w-sm mx-auto leading-relaxed">
                  If that account exists, a reset link has been dispatched to your email address. The link expires in 1 hour.
                </p>
              </div>
              <div className="pt-2">
                <Link
                  to="/login"
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline"
                >
                  <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
                </Link>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="relative">
                <Mail className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  type="text"
                  placeholder="Email or phone number"
                  className="pl-10"
                  value={identifier}
                  onChange={(e) => setIdentifier(e.target.value)}
                  required
                />
              </div>

              {error && (
                <div className="flex items-center gap-2 p-2.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button
                type="submit"
                className="w-full bg-black text-white hover:bg-gray-800 dark:hover:bg-muted font-semibold"
                disabled={loading || !identifier.trim()}
              >
                {loading ? 'Sending link…' : 'Send Reset Link'}
              </Button>

              <div className="text-center pt-2">
                <Link
                  to="/login"
                  className="inline-flex items-center gap-1 text-xs text-gray-500 dark:text-muted-foreground hover:text-gray-800 dark:hover:text-foreground"
                >
                  <ArrowLeft className="w-3.5 h-3.5" /> Back to sign in
                </Link>
              </div>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
