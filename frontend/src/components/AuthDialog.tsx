import { useState, useMemo } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import GoogleSignInButton from '@/components/GoogleSignInButton'
import { Logo } from '@/components/Logo'
import PasswordStrengthMeter from '@/components/PasswordStrengthMeter'
import { normalizePhoneNumber, formatPhoneDisplay, isValidPhoneNumber } from '@/lib/phone'
import { Mail, Lock, User, Phone, Eye, EyeOff, AlertCircle } from 'lucide-react'
import { extractError } from '@/lib/api'

interface AuthDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function AuthDialog({ open, onOpenChange }: AuthDialogProps) {
  // Login state
  const [loginIdentifier, setLoginIdentifier] = useState('')
  const [loginPassword, setLoginPassword] = useState('')
  const [showLoginPassword, setShowLoginPassword] = useState(false)

  // Register state
  const [registerEmail, setRegisterEmail] = useState('')
  const [registerPassword, setRegisterPassword] = useState('')
  const [registerConfirmPassword, setRegisterConfirmPassword] = useState('')
  const [registerDisplayName, setRegisterDisplayName] = useState('')
  const [registerPhone, setRegisterPhone] = useState('')
  const [showRegisterPassword, setShowRegisterPassword] = useState(false)
  const [showRegisterConfirmPassword, setShowRegisterConfirmPassword] = useState(false)

  const [error, setError] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isGoogleLoading, setIsGoogleLoading] = useState(false)
  const navigate = useNavigate()
  const { login, register, googleAuth } = useAuthStore()

  const formattedRegisterPhone = useMemo(
    () => (registerPhone ? formatPhoneDisplay(registerPhone) : ''),
    [registerPhone],
  )

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const trimmed = loginIdentifier.trim()
    if (!trimmed) {
      setError('Please enter your email or phone number.')
      return
    }
    if (!loginPassword) {
      setError('Please enter your password.')
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

    setIsSubmitting(true)
    try {
      await login(cleanIdentifier, loginPassword)
      onOpenChange(false)
      navigate('/dashboard')
    } catch (err: any) {
      setError(extractError(err, 'Sign in failed. Please check your credentials.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    const cleanName = registerDisplayName.trim()
    const cleanEmail = registerEmail.trim().toLowerCase()

    if (cleanName.length < 2) {
      setError('Please enter your full name (at least 2 characters).')
      return
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      setError('Please enter a valid email address.')
      return
    }
    if (registerPassword.length < 6) {
      setError('Password must be at least 6 characters.')
      return
    }
    if (registerPassword !== registerConfirmPassword) {
      setError('Passwords do not match.')
      return
    }
    if (registerPhone && !isValidPhoneNumber(registerPhone)) {
      setError('Please enter a valid phone number (e.g. 09019549999).')
      return
    }

    setIsSubmitting(true)
    try {
      const cleanPhone = registerPhone ? normalizePhoneNumber(registerPhone) : undefined
      await register({
        email: cleanEmail,
        password: registerPassword,
        display_name: cleanName,
        phone_number: cleanPhone || undefined,
      })
      onOpenChange(false)
      navigate('/dashboard')
    } catch (err: any) {
      setError(extractError(err, 'Registration failed. Please check your details.'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleGoogleSuccess = async (accessToken: string) => {
    setIsGoogleLoading(true)
    setError('')
    try {
      await googleAuth({ access_token: accessToken })
      onOpenChange(false)
      navigate('/dashboard')
    } catch (err: any) {
      setError(extractError(err, 'Google sign-in failed.'))
    } finally {
      setIsGoogleLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!isGoogleLoading && !isSubmitting) onOpenChange(val) }}>
      <DialogContent className={`sm:max-w-md bg-white dark:bg-card text-foreground transition-opacity duration-300 max-h-[90vh] overflow-y-auto ${isGoogleLoading ? 'opacity-50 pointer-events-none' : ''}`}>
        <DialogHeader>
          <div className="flex items-center gap-2 mb-1">
            <Logo className="w-6 h-6" />
            <DialogTitle className="text-xl font-bold">Gigr</DialogTitle>
          </div>
          <DialogDescription className="text-gray-500 dark:text-muted-foreground text-xs">
            Sign in or create an account to post jobs, find services, or chat with providers.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="login" className="w-full mt-2" onValueChange={() => setError('')}>
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">Sign In</TabsTrigger>
            <TabsTrigger value="register">Register</TabsTrigger>
          </TabsList>

          {/* Login Tab */}
          <TabsContent value="login">
            <form onSubmit={handleLogin} className="space-y-3.5 mt-3">
              <div className="relative">
                <Mail className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  type="text"
                  placeholder="Email or phone number"
                  className="pl-10"
                  value={loginIdentifier}
                  onChange={(e) => setLoginIdentifier(e.target.value)}
                  required
                />
              </div>

              <div className="relative">
                <Lock className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  type={showLoginPassword ? 'text' : 'password'}
                  placeholder="Password"
                  className="pl-10 pr-10"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowLoginPassword(!showLoginPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground focus:outline-none"
                  aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
                >
                  {showLoginPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              <div className="flex justify-end">
                <Link
                  to="/forgot-password"
                  onClick={() => onOpenChange(false)}
                  className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
                >
                  Forgot password?
                </Link>
              </div>

              {error && (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button
                type="submit"
                disabled={isSubmitting || isGoogleLoading || !loginIdentifier.trim() || !loginPassword}
                className="w-full bg-black text-white hover:bg-gray-800 dark:hover:bg-muted font-semibold"
              >
                {isSubmitting ? 'Signing in…' : 'Sign In'}
              </Button>
            </form>
          </TabsContent>

          {/* Register Tab */}
          <TabsContent value="register">
            <form onSubmit={handleRegister} className="space-y-3 mt-3">
              <div className="relative">
                <User className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  type="text"
                  placeholder="Full name"
                  className="pl-10"
                  value={registerDisplayName}
                  onChange={(e) => setRegisterDisplayName(e.target.value)}
                  required
                />
              </div>

              <div className="relative">
                <Mail className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  type="email"
                  placeholder="Email address"
                  className="pl-10"
                  value={registerEmail}
                  onChange={(e) => setRegisterEmail(e.target.value)}
                  required
                />
              </div>

              <div className="relative">
                <Lock className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  type={showRegisterPassword ? 'text' : 'password'}
                  placeholder="Password (min 6 characters)"
                  className="pl-10 pr-10"
                  value={registerPassword}
                  onChange={(e) => setRegisterPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowRegisterPassword(!showRegisterPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground focus:outline-none"
                  aria-label={showRegisterPassword ? 'Hide password' : 'Show password'}
                >
                  {showRegisterPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              <div className="relative">
                <Lock className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input
                  type={showRegisterConfirmPassword ? 'text' : 'password'}
                  placeholder="Confirm password"
                  className="pl-10 pr-10"
                  value={registerConfirmPassword}
                  onChange={(e) => setRegisterConfirmPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  onClick={() => setShowRegisterConfirmPassword(!showRegisterConfirmPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-muted-foreground focus:outline-none"
                  aria-label={showRegisterConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                >
                  {showRegisterConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>

              {/* Password Strength Meter */}
              <PasswordStrengthMeter
                password={registerPassword}
                confirmPassword={registerConfirmPassword}
                showConfirmMatch={true}
              />

              <div className="space-y-0.5">
                <div className="relative">
                  <Phone className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                  <Input
                    type="tel"
                    placeholder="Phone number (optional)"
                    className="pl-10"
                    value={registerPhone}
                    onChange={(e) => setRegisterPhone(e.target.value)}
                  />
                </div>
                {registerPhone && (
                  <p className="text-[10px] text-gray-500 dark:text-muted-foreground font-mono pl-1">
                    Format: <span className="font-medium text-gray-700 dark:text-muted-foreground">{formattedRegisterPhone || 'Invalid'}</span>
                  </p>
                )}
              </div>

              {error && (
                <div className="flex items-center gap-2 p-2 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-xs">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button
                type="submit"
                disabled={isSubmitting || isGoogleLoading || registerPassword.length < 6 || registerPassword !== registerConfirmPassword}
                className="w-full bg-black text-white hover:bg-gray-800 dark:hover:bg-muted font-semibold"
              >
                {isSubmitting ? 'Creating Account…' : 'Create Account'}
              </Button>
            </form>
          </TabsContent>
        </Tabs>

        <div className="mt-3 border-t border-gray-100 dark:border-border pt-3 flex justify-center w-full px-2">
          <GoogleSignInButton onToken={handleGoogleSuccess} onError={(msg) => setError(msg)} />
        </div>
      </DialogContent>
    </Dialog>
  )
}