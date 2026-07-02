import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { GoogleLogin } from '@react-oauth/google'

export default function LoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const navigate = useNavigate()
  const login = useAuthStore((s) => s.login)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await login(email, password)
      navigate('/')
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Login failed')
    }
  }

  const handleGoogleSuccess = async (credentialResponse: any) => {
    try {
      const res = await fetch('/api/v1/auth/google', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: credentialResponse.credential }),
        credentials: 'include',
      })
      if (res.ok) {
        // fetch user
        await useAuthStore.getState().fetchUser()
        navigate('/')
      } else {
        const data = await res.json()
        setError(data.detail || 'Google sign-in failed')
      }
    } catch {
      setError('Network error')
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="text-2xl font-bold">Sign in to Gigr</CardTitle>
          <CardDescription>Enter your email and password to continue</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <Input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <Button type="submit" className="w-full">Sign In</Button>
            {error && <p className="text-sm text-red-500">{error}</p>}
          </form>
          <div className="mt-4">
            <GoogleLogin
              onSuccess={handleGoogleSuccess}
              onError={() => setError('Google sign-in failed')}
            />
          </div>
          <p className="mt-4 text-center text-sm">
            Don't have an account? <Link to="/register" className="text-blue-600">Register</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}