import { useParams, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import api from '@/lib/api'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Star, Briefcase, Calendar, ArrowLeft, MapPin, Navigation } from 'lucide-react'
import OnlineIndicator from '@/components/OnlineIndicator'
import type { components } from '@/types/api'

type Vouch = components['schemas']['VouchOut']
type Service = components['schemas']['ServiceOut']

interface PublicUser {
  id: string
  display_name: string
  profile_image_url?: string | null
  is_verified: boolean
  role?: string | null
  created_at: string
  last_seen_at?: string | null
  location_lat?: number | null
  location_lng?: number | null
  bio?: string | null
  skills?: string[] | null
}

// Haversine distance in km
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLng = ((lng2 - lng1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function VoucherName({ voucherId }: { voucherId: string }) {
  const { data } = useQuery<PublicUser>({
    queryKey: ['user', voucherId],
    queryFn: async () => { const { data } = await api.get(`/users/${voucherId}`); return data },
    enabled: !!voucherId,
    staleTime: 5 * 60 * 1000,
  })
  return <span className="font-medium">{data?.display_name || 'Someone'}</span>
}

export default function PublicProfilePage() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const [viewerLat, setViewerLat] = useState<number | null>(null)
  const [viewerLng, setViewerLng] = useState<number | null>(null)

  // Get viewer's location for distance calc
  useEffect(() => {
    if (!navigator.geolocation) return
    navigator.geolocation.getCurrentPosition(
      (pos) => { setViewerLat(pos.coords.latitude); setViewerLng(pos.coords.longitude) },
      () => {}
    )
  }, [])

  const { data: profile, isLoading } = useQuery<PublicUser>({
    queryKey: ['publicUser', userId],
    queryFn: async () => { const { data } = await api.get(`/users/${userId}`); return data },
    enabled: !!userId,
  })

  const { data: vouches } = useQuery<Vouch[]>({
    queryKey: ['vouches', userId],
    queryFn: async () => { const { data } = await api.get(`/vouches/user/${userId}`); return data },
    enabled: !!userId,
  })

  const { data: services } = useQuery<Service[]>({
    queryKey: ['userServices', userId],
    queryFn: async () => { const { data } = await api.get(`/services/provider/${userId}`); return data },
    enabled: !!userId,
  })

  if (isLoading) return <div className="space-y-4"><Skeleton className="h-48 w-full rounded-2xl" /><Skeleton className="h-32 w-full rounded-2xl" /></div>
  if (!profile) return <div className="text-center py-12 text-gray-500">User not found.</div>

  const distanceKm =
    viewerLat && viewerLng && profile.location_lat && profile.location_lng
      ? haversineKm(viewerLat, viewerLng, profile.location_lat, profile.location_lng)
      : null

  const initials = profile.display_name?.[0]?.toUpperCase() || '?'

  return (
    <div className="space-y-6 animate-in fade-in duration-500 max-w-2xl">
      <Button variant="ghost" onClick={() => navigate(-1)} className="-ml-2">
        <ArrowLeft className="w-4 h-4 mr-2" /> Back
      </Button>

      {/* Hero card */}
      <Card className="overflow-hidden">
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row items-start gap-5">
            <Avatar className="h-24 w-24 shrink-0 ring-4 ring-white shadow-lg">
              <AvatarImage src={profile.profile_image_url || undefined} />
              <AvatarFallback className="text-3xl bg-black text-white">{initials}</AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-bold truncate">{profile.display_name}</h1>
                {profile.is_verified && (
                  <Badge className="bg-blue-50 text-blue-700 border-blue-200 text-xs">Verified</Badge>
                )}
                {profile.role === 'admin' || profile.role === 'superadmin' ? (
                  <Badge className="bg-purple-50 text-purple-700 border-purple-200 text-xs">Admin</Badge>
                ) : null}
              </div>

              {/* Online + last seen */}
              <div className="flex items-center gap-2 mt-1.5">
                <OnlineIndicator lastSeenAt={profile.last_seen_at} showLabel />
              </div>

              {/* Distance */}
              {distanceKm !== null && (
                <div className="flex items-center gap-1.5 mt-1.5 text-sm text-gray-600">
                  <Navigation className="w-3.5 h-3.5 text-blue-500" />
                  <span>~{distanceKm < 1 ? '<1' : distanceKm.toFixed(1)} km from you</span>
                </div>
              )}
              {profile.location_lat && !distanceKm && (
                <div className="flex items-center gap-1.5 mt-1.5 text-sm text-gray-500">
                  <MapPin className="w-3.5 h-3.5" />
                  <span>Location shared</span>
                </div>
              )}

              <div className="flex items-center gap-1.5 mt-2 text-xs text-gray-500">
                <Calendar className="w-3.5 h-3.5" />
                Joined {new Date(profile.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'long' })}
              </div>
              {profile.bio && (
                <p className="mt-3 text-sm text-gray-700 leading-relaxed">{profile.bio}</p>
              )}
              {profile.skills && profile.skills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {profile.skills.map(s => (
                    <span key={s} className="bg-gray-100 text-gray-700 text-xs px-2.5 py-1 rounded-full">{s}</span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-3 gap-4 mt-6 text-center border-t pt-4">
            <div>
              <p className="text-xl font-bold">{vouches?.length || 0}</p>
              <p className="text-xs text-gray-500 mt-0.5">Vouches</p>
            </div>
            <div>
              <p className="text-xl font-bold">{services?.filter(s => s.is_active).length || 0}</p>
              <p className="text-xs text-gray-500 mt-0.5">Active Services</p>
            </div>
            <div>
              <p className="text-xl font-bold">{profile.is_verified ? '✓' : '—'}</p>
              <p className="text-xs text-gray-500 mt-0.5">Verified</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Services */}
      {services && services.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Briefcase className="w-4 h-4" /> Services ({services.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {services.filter(s => s.is_active).map(s => (
                <div key={s.id} className="bg-gray-50 rounded-xl p-3 border border-gray-100">
                  <p className="font-medium text-sm">{s.title}</p>
                  {s.description && <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{s.description}</p>}
                  <p className="text-sm font-semibold text-black mt-1.5">₦{parseFloat(s.price as string).toLocaleString()}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Vouches */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Star className="w-4 h-4 text-yellow-500" /> Vouches ({vouches?.length || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {vouches?.length ? (
            <div className="space-y-2">
              {vouches.map(v => (
                <div key={v.id} className="flex items-center justify-between bg-gray-50 rounded-xl p-3 border border-gray-100">
                  <div className="text-sm">
                    <VoucherName voucherId={v.voucher_id} />
                    <span className="text-gray-500"> vouched for completed work</span>
                    {v.cnf_nft_id && (
                      <span className="ml-1.5 text-xs bg-purple-50 text-purple-600 px-1.5 py-0.5 rounded-full border border-purple-200">
                        cNFT on-chain
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-gray-400 shrink-0 ml-2">
                    {new Date(v.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500">No vouches yet.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
