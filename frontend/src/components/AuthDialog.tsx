import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { GoogleLogin } from '@react-oauth/google'
import { Logo } from '@/components/Logo'
import { Mail, Lock, User, Phone } from 'lucide-react'

interface AuthDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export default function AuthDialog({ open, onOpenChange }: AuthDialogProps) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [phone, setPhone] = useState('')
  const [error, setError] = useState('')
  const [isGoogleLoading, setIsGoogleLoading] = useState(false)
  const navigate = useNavigate()
  const { login, register, googleAuth } = useAuthStore()

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await login(email, password)
      onOpenChange(false)
      navigate('/dashboard')
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Login failed')
    }
  }

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await register({ email, password, display_name: displayName, phone_number: phone })
      onOpenChange(false)
      navigate('/dashboard')
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Registration failed')
    }
  }

  const handleGoogleSuccess = async (credentialResponse: any) => {
    setIsGoogleLoading(true)
    setError('')
    try {
      await googleAuth(credentialResponse.credential)
      onOpenChange(false)
      navigate('/dashboard')
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Google sign-in failed')
    } finally {
      setIsGoogleLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!isGoogleLoading) onOpenChange(val) }}>
      <DialogContent className={`sm:max-w-md bg-white text-black transition-opacity duration-300 ${isGoogleLoading ? 'opacity-50 pointer-events-none' : ''}`}>
        <DialogHeader>
          <div className="flex items-center gap-2 mb-2">
            <Logo className="w-6 h-6" />
            <DialogTitle className="text-xl font-bold">Gigr</DialogTitle>
          </div>
          <DialogDescription className="text-gray-500">
            Sign in or create an account to continue.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="login" className="w-full mt-4">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="login">Login</TabsTrigger>
            <TabsTrigger value="register">Register</TabsTrigger>
          </TabsList>
          <TabsContent value="login">
            <form onSubmit={handleLogin} className="space-y-4 mt-4">
              <div className="relative">
                <Mail className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input type="email" placeholder="Email" className="pl-10" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input type="password" placeholder="Password" className="pl-10" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <Button type="submit" disabled={isGoogleLoading} className="w-full bg-black text-white hover:bg-gray-800 font-semibold">
                {isGoogleLoading ? 'Signing in...' : 'Sign In'}
              </Button>
            </form>
          </TabsContent>
          <TabsContent value="register">
            <form onSubmit={handleRegister} className="space-y-4 mt-4">
              <div className="relative">
                <Mail className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input type="email" placeholder="Email" className="pl-10" value={email} onChange={(e) => setEmail(e.target.value)} required />
              </div>
              <div className="relative">
                <Lock className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input type="password" placeholder="Password" className="pl-10" value={password} onChange={(e) => setPassword(e.target.value)} required />
              </div>
              <div className="relative">
                <User className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input type="text" placeholder="Full Name" className="pl-10" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required />
              </div>
              <div className="relative">
                <Phone className="absolute left-3 top-2.5 h-4 w-4 text-gray-400" />
                <Input type="tel" placeholder="Phone number" className="pl-10" value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
              <Button type="submit" disabled={isGoogleLoading} className="w-full bg-black text-white hover:bg-gray-800 font-semibold">
                {isGoogleLoading ? 'Creating Account...' : 'Create Account'}
              </Button>
            </form>
          </TabsContent>
        </Tabs>
        {error && <p className="mt-2 text-sm text-red-500">{error}</p>}
        <div className="mt-4 border-t pt-4 flex justify-center">
          <GoogleLogin onSuccess={handleGoogleSuccess} onError={() => setError('Google sign-in failed')} />
        </div>
      </DialogContent>
    </Dialog>
  )
}