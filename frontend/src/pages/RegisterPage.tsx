import { extractError } from '@/lib/api'
import { useState, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import GoogleSignInButton from '@/components/GoogleSignInButton'
import PasswordStrengthMeter from '@/components/PasswordStrengthMeter'
import { normalizePhoneNumber, formatPhoneDisplay, isValidPhoneNumber } from '@/lib/phone'
import { Mail, Lock, User, Phone, Eye, EyeOff, AlertCircle } from 'lucide-react'

export default function RegisterPage() {
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [phone, setPhone] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const navigate = useNavigate()
  const { register, googleAuth } = useAuthStore()

  // Real-time phone preview
  const normalizedPhone = useMemo(() => normalizePhoneNumber(phone), [phone])
  const formattedPhone = useMemo(() => (phone ? formatPhoneDisplay(phone) : ''), [phone])

  // Validation checks
  const isEmailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  const isNameValid = displayName.trim().length >= 2
  const isPasswordValid = password.length >= 6
  const isPasswordMatch = password.length > 0 && password === confirmPassword
  const isPhoneValid = !phone || isValidPhoneNumber(phone)

  const isFormValid = isNameValid && isEmailValid && isPasswordValid && isPasswordMatch && isPhoneValid

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    // Client-side validation before sending
    if (!isNameValid) {
      setError('Please enter your full name (at least 2 characters).')
      return
    }
    if (!isEmailValid) {
      setError('Please enter a valid email address.')
      return
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match.')
      return
    }
    if (phone && !isValidPhoneNumber(phone)) {
      setError('Please enter a valid phone number (e.g. 09019549999 or +2349019549999).')
      return
    }

    setLoading(true)
    try {
      const cleanEmail = email.trim().toLowerCase()
      const cleanPhone = normalizedPhone || undefined
      await register({
        email: cleanEmail,
        password,
        display_name: displayName.trim(),
        phone_number: cleanPhone,
      })
      navigate('/dashboard')
    } catch (err: any) {
      setError(extractError(err, 'Registration failed. Please check your details.'))
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
          <CardTitle className="text-2xl font-bold tracking-tight">Create your Gigr account</CardTitle>
          <CardDescription>Fill in your details to get started with trusted local services.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3.5">
            {/* Full Name */}
            <div>
              <div className="relative">
                <User className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  type="text"
                  placeholder="Full name"
                  className="pl-10"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  required
                />
              </div>
            </div>

            {/* Email */}
            <div>
              <div className="relative">
                <Mail className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  type="email"
                  placeholder="Email address"
                  className="pl-10"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <div className="relative">
                <Lock className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  type={showPassword ? 'text' : 'password'}
                  placeholder="Password (min 6 characters)"
                  className="pl-10 pr-10"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
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
            </div>

            {/* Confirm Password */}
            <div>
              <div className="relative">
                <Lock className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  type={showConfirmPassword ? 'text' : 'password'}
                  placeholder="Confirm password"
                  className="pl-10 pr-10"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 focus:outline-none"
                  aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                >
                  {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Password Strength Meter & Real-time Matching Indicator */}
            <PasswordStrengthMeter
              password={password}
              confirmPassword={confirmPassword}
              showConfirmMatch={true}
            />

            {/* Phone Number with Real-time Formatting Preview */}
            <div className="space-y-1">
              <div className="relative">
                <Phone className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  type="tel"
                  placeholder="Phone number (e.g. 09019549999 or +234...)"
                  className="pl-10"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                />
              </div>
              {phone && (
                <p className="text-[11px] text-gray-500 font-mono pl-1">
                  Format: <span className="text-gray-700 dark:text-gray-300 font-medium">{formattedPhone || 'Invalid format'}</span>
                </p>
              )}
            </div>

            {/* Error Message */}
            {error && (
              <div className="flex items-center gap-2 p-2.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-xs">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Submit Button */}
            <Button
              type="submit"
              className="w-full bg-black text-white hover:bg-gray-800 font-semibold"
              disabled={loading || !isFormValid}
            >
              {loading ? 'Creating account…' : 'Create Account'}
            </Button>
          </form>

          <div className="mt-4 border-t border-gray-100 dark:border-gray-800 pt-4">
            <GoogleSignInButton
              onToken={handleGoogleSuccess}
              onError={(msg) => setError(msg)}
            />
          </div>

          <p className="mt-4 text-center text-sm text-gray-600 dark:text-gray-400">
            Already have an account?{' '}
            <Link to="/login" className="font-medium text-black dark:text-white hover:underline">
              Sign in
            </Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
