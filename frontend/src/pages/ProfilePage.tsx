import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import api from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
// import { Separator } from '@/components/ui/separator'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuthStore } from '@/store/authStore'
import { Clock, Coins, RefreshCw } from 'lucide-react'
import { FundWalletButton } from '@/components/FundWalletButton'

import {
  Mail, Phone, Key, Copy, Star, Briefcase, Calendar, MapPin, Shield, Camera, Edit3, CheckCircle, XCircle
} from 'lucide-react'
import type { components } from '@/types/api'

type Vouch = components['schemas']['VouchOut']
type Job = components['schemas']['JobOut']
type Service = components['schemas']['ServiceOut']

// Cloudinary upload helper
async function uploadFile(file: File): Promise<string> {
  const cloudName = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME
  const preset = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET
  const formData = new FormData()
  formData.append('file', file)
  formData.append('upload_preset', preset)
  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: formData,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error?.message || 'Upload failed')
  return data.secure_url
}

export default function ProfilePage() {
  const { user } = useAuthStore()
  const queryClient = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [displayName, setDisplayName] = useState(user?.display_name || '')
  const [phoneNumber, setPhoneNumber] = useState(user?.phone_number || '')
  const [profileImageFile, setProfileImageFile] = useState<File | null>(null)
  const [profileImagePreview, setProfileImagePreview] = useState<string | null>(null)

  // Fetch all relevant data
  const { data: vouchesReceived, isLoading: vouchesLoading } = useQuery<Vouch[]>({
    queryKey: ['vouches', user?.id],
    queryFn: async () => {
      if (!user?.id) return []
      const { data } = await api.get(`/vouches/user/${user.id}`)
      return data
    },
    enabled: !!user?.id,
  })

  const { data: myJobs, isLoading: jobsLoading } = useQuery<Job[]>({
    queryKey: ['myJobsForProfile'],
    queryFn: async () => {
      const [c, p] = await Promise.all([
        api.get('/jobs/', { params: { my: 'client' } }),
        api.get('/jobs/', { params: { my: 'provider' } }),
      ])
      return [...c.data, ...p.data]
    },
  })

  const { data: myServices} = useQuery<Service[]>({
    queryKey: ['myServices'],
    queryFn: async () => {
      const { data } = await api.get('/services/')
      return data
    },
  })

  const { data: walletInfo } = useQuery<{ wallet_public_key: string }>({
    queryKey: ['wallet'],
    queryFn: async () => {
      const { data } = await api.get('/users/me/wallet')
      return data
    },
  })

  // Live USDC balance — polled every 10 seconds
  const { data: walletBalance, isLoading: balanceLoading } = useQuery<{ sol: number; usdc: string }>({
    queryKey: ['wallet-balance'],
    queryFn: async () => {
      const { data } = await api.get('/users/me/balance')
      return data
    },
    refetchInterval: 10000,
    staleTime: 8000,
  })

  // NGN/USD exchange rate for balance display
  const { data: rateData } = useQuery<{ ngn_per_usd: number }>({
    queryKey: ['exchange-rate'],
    queryFn: async () => {
      const { data } = await api.get('/jobs/exchange-rate')
      return data
    },
    staleTime: 60000,
  })

  const [showUSDC, setShowUSDC] = useState(false)

  const usdcFloat = parseFloat(walletBalance?.usdc ?? '0')
  const ngnRate = rateData?.ngn_per_usd ?? null
  const ngnBalance = ngnRate ? usdcFloat * ngnRate : null

  const completedJobs = myJobs?.filter(j => j.status === 'completed') || []
  const pendingJobs = myJobs?.filter(j => !['completed', 'cancelled'].includes(j.status)) || []

  // Update profile mutation
  const updateMutation = useMutation({
    mutationFn: async (data: { display_name?: string; phone_number?: string; profile_image_url?: string }) => {
      await api.patch('/users/me', data)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['auth'] })
      toast.success('Profile updated')
      setEditing(false)
    },
    onError: (err: any) => toast.error(err.response?.data?.detail || 'Update failed'),
  })

  const handleUpdateProfile = async () => {
    let imageUrl: string | undefined
    if (profileImageFile) {
      try {
        imageUrl = await uploadFile(profileImageFile)
      } catch {
        toast.error('Image upload failed')
        return
      }
    }
    updateMutation.mutate({
      display_name: displayName,
      phone_number: phoneNumber,
      profile_image_url: imageUrl,
    })
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    toast.success('Copied!')
  }

  // Load Google Identity if available
  const handleVerifyIdentity = async () => {
    // Placeholder for Civic Pass integration – can be added later
    toast.info('Identity verification via Civic Pass. Coming soon.')
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500 max-w-4xl">
      <div>
        <h1 className="text-3xl font-bold">Profile</h1>
        <p className="text-gray-500">Your public identity and on‑chain reputation</p>
      </div>

      {/* Basic Info Card with Edit */}
      <Card>
        <CardHeader>
          <CardTitle className="text-xl flex items-center gap-2">
            <Edit3 className="w-5 h-5" /> Personal Info
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex flex-col md:flex-row gap-6 items-start">
            {/* Avatar section */}
            <div className="relative">
              <Avatar className="h-24 w-24">
                <AvatarImage src={profileImagePreview || user?.profile_image_url || undefined} />
                <AvatarFallback className="text-2xl bg-black text-white">
                  {displayName?.[0]?.toUpperCase() || '?'}
                </AvatarFallback>
              </Avatar>
              {editing && (
                <label className="absolute bottom-0 right-0 bg-black text-white p-1 rounded-full cursor-pointer">
                  <Camera className="w-4 h-4" />
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) {
                        setProfileImageFile(file)
                        setProfileImagePreview(URL.createObjectURL(file))
                      }
                    }}
                  />
                </label>
              )}
            </div>

            {/* Fields */}
            <div className="flex-1 space-y-3 w-full">
              {editing ? (
                <>
                  <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Display name" />
                  <Input value={phoneNumber} onChange={(e) => setPhoneNumber(e.target.value)} placeholder="Phone" />
                  <div className="flex gap-2">
                    <Button size="sm" onClick={handleUpdateProfile} disabled={updateMutation.isPending} className="bg-black text-white">
                      {updateMutation.isPending ? 'Saving...' : 'Save'}
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                      Cancel
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2 text-lg font-semibold">
                    {user?.display_name}
                    {user?.is_verified && <Badge className="bg-green-100 text-green-700">Verified</Badge>}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm text-gray-600">
                    <div className="flex items-center gap-2"><Mail className="w-4 h-4" /> {user?.email}</div>
                    {user?.phone_number && (
                      <div className="flex items-center gap-2"><Phone className="w-4 h-4" /> {user.phone_number}</div>
                    )}
                    <div className="flex items-center gap-2"><Calendar className="w-4 h-4" /> Joined {user?.created_at ? new Date(user.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }) : 'Unknown'}</div>
                  </div>
                  <Button variant="outline" onClick={() => setEditing(true)}>
                    Edit Profile
                  </Button>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Wallet Card */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Key className="w-5 h-5" /> Solana Wallet
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-gray-500">Your invisible on‑chain identity — powered by Solana</p>
          {walletInfo?.wallet_public_key ? (
            <div className="bg-gray-50 rounded-lg p-3 flex items-center justify-between">
              <code className="text-xs break-all">{walletInfo.wallet_public_key}</code>
              <Button size="sm" variant="ghost" onClick={() => copyToClipboard(walletInfo.wallet_public_key)}>
                <Copy className="w-3 h-3" />
              </Button>
              <FundWalletButton walletAddress={walletInfo.wallet_public_key} />
            </div>
          ) : (
            <Skeleton className="h-10 w-full" />
          )}

          {/* Live balance */}
          <div className="bg-gradient-to-br from-green-50 to-emerald-50 border border-green-100 rounded-xl p-4">
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2">
                <Coins className="w-4 h-4 text-green-600" />
                <span className="text-xs font-medium text-green-700">Wallet Balance</span>
              </div>
              <button
                onClick={() => setShowUSDC((v) => !v)}
                className="flex items-center gap-1 text-xs text-green-600 hover:text-green-800"
              >
                <RefreshCw className="w-3 h-3" />
                {showUSDC ? 'Show NGN' : 'Show USDC'}
              </button>
            </div>
            {balanceLoading ? (
              <Skeleton className="h-8 w-32" />
            ) : showUSDC ? (
              <p className="text-2xl font-bold text-green-900">
                {usdcFloat.toFixed(2)}
                <span className="text-sm font-normal text-green-600 ml-1">USDC</span>
              </p>
            ) : (
              <p className="text-2xl font-bold text-green-900">
                {ngnBalance != null
                  ? `₦${ngnBalance.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                  : `₦—`}
                {ngnRate && (
                  <span className="text-xs font-normal text-green-600 ml-2">
                    ≈ {usdcFloat.toFixed(2)} USDC
                  </span>
                )}
              </p>
            )}
          </div>
          <p className="text-xs text-gray-400">Balance refreshes every 10 seconds • Devnet</p>
        </CardContent>
      </Card>

      {/* Stats Grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-6 text-center">
            <Star className="w-8 h-8 mx-auto mb-2 text-gray-700" />
            <p className="text-2xl font-bold">{vouchesReceived?.length || 0}</p>
            <p className="text-xs text-gray-500">Vouches Received</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <Briefcase className="w-8 h-8 mx-auto mb-2 text-gray-700" />
            <p className="text-2xl font-bold">{completedJobs.length}</p>
            <p className="text-xs text-gray-500">Jobs Completed</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <MapPin className="w-8 h-8 mx-auto mb-2 text-gray-700" />
            <p className="text-2xl font-bold">{myServices?.length || 0}</p>
            <p className="text-xs text-gray-500">Services Listed</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-6 text-center">
            <Clock className="w-8 h-8 mx-auto mb-2 text-gray-700" />
            <p className="text-2xl font-bold">{pendingJobs.length}</p>
            <p className="text-xs text-gray-500">Active Jobs</p>
          </CardContent>
        </Card>
      </div>

      {/* Identity Verification */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Shield className="w-5 h-5" /> Identity Verification
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-gray-600">
          {user?.is_verified ? (
            <div className="flex items-center gap-2 text-green-600">
              <CheckCircle className="w-5 h-5" /> Your identity has been verified via zero‑knowledge proof (Civic Pass).
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-2 text-yellow-600">
                <XCircle className="w-5 h-5" /> Not yet verified.
              </div>
              <Button variant="outline" onClick={handleVerifyIdentity}>
                <Shield className="w-4 h-4 mr-2" /> Verify with Civic Pass
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Vouches History */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Star className="w-5 h-5" /> Vouch History ({vouchesReceived?.length || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {vouchesLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : vouchesReceived?.length ? (
            <div className="space-y-2">
              {vouchesReceived.map(v => (
                <div key={v.id} className="flex items-center justify-between bg-gray-50 rounded-lg p-3">
                  <div>
                    <p className="text-sm font-medium">Job: {v.job_id?.slice(0, 8)}...</p>
                    <p className="text-xs text-gray-500">On‑chain cNFT: {v.cnf_nft_id?.slice(0, 12)}...</p>
                  </div>
                  <span className="text-xs text-gray-400">{new Date(v.created_at).toLocaleDateString()}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500">No vouches yet. Complete jobs to build your on‑chain reputation.</p>
          )}
        </CardContent>
      </Card>

      {/* Recent Jobs Summary */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Briefcase className="w-5 h-5" /> Recent Jobs
          </CardTitle>
        </CardHeader>
        <CardContent>
          {jobsLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : myJobs?.length ? (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {myJobs.slice(0, 10).map(job => (
                <div key={job.id} className="flex justify-between items-center text-sm">
                  <span>{job.title}</span>
                  <Badge variant="outline">{job.status}</Badge>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500">No jobs yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}