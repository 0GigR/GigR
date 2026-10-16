import { extractError } from '@/lib/api'
import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import GoogleSignInButton from '@/components/GoogleSignInButton'
import { normalizePhoneNumber } from '@/lib/phone'
import { Mail, Lock, Eye, EyeOff, AlertCircle } from 'lucide-react'

export default function LoginPage() {
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { login, googleAuth } = useAuthStore()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const trimmed = identifier.trim()
    if (!trimmed) {
      setError('Please enter your email or phone number.')
      return
    }
    if (!password) {
      setError('Please enter your password.')
      return
    }

    // Resolve whether identifier is phone or email
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
      await login(cleanIdentifier, password)
      navigate('/dashboard')
    } catch (err: any) {
      setError(extractError(err, 'Sign in failed. Please check your credentials.'))
    } finally {
      setLoading(false)
    }
  }

  const handleGoogleSuccess = async (accessToken: string) => {
    setError('')
    setLoading(true)
    try {
      await googleAuth({ access_token: accessToken })
      navigate('/dashboard')
    } catch (err: any) {
      setError(extractError(err, 'Google sign-in failed.'))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 dark:bg-gray-950 px-4 py-8">
      <Card className="w-full max-w-md bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-800 shadow-sm">
        <CardHeader>
          <CardTitle className="text-2xl font-bold tracking-tight">Sign in to Gigr</CardTitle>
          <CardDescription>Enter your email or phone number and password to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Email or Phone Input */}
            <div className="relative">
              <Mail className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <Input
                type="text"
                placeholder="Email or phone number"
                className="pl-10"
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                required
                autoComplete="username"
              />
            </div>

            {/* Password Input with Visibility Toggle */}
            <div className="relative">
              <Lock className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
              <Input
                type={showPassword ? 'text' : 'password'}
                placeholder="Password"
                className="pl-10 pr-10"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 focus:outline-none"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>

            <div className="flex justify-end">
              <Link to="/forgot-password" className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
                Forgot password?
              </Link>
            </div>

            {/* Error Message */}
            {error && (
              <div className="flex items-center gap-2 p-2.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-xs">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <Button
              type="submit"
              className="w-full bg-black text-white hover:bg-gray-800 font-semibold"
              disabled={loading || !identifier.trim() || !password}
            >
              {loading ? 'Signing in…' : 'Sign In'}
            </Button>
          </form>

          <div className="mt-4 border-t border-gray-100 dark:border-gray-800 pt-4">
            <GoogleSignInButton
              onToken={handleGoogleSuccess}
              onError={(msg) => setError(msg)}
            />
          </div>

          <p className="mt-4 text-center text-sm text-gray-600 dark:text-gray-400">
            Don't have an account?{' '}
            <Link to="/register" className="font-medium text-black dark:text-white hover:underline">
              Register
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}