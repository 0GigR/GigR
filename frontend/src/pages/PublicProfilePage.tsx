import { fmtPrice } from '@/store/currencyStore'
import { vouchProof, VOUCH_TONE_CLASS } from '@/lib/vouch'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import api from '@/lib/api'
import { haversineKm } from '@/lib/geo'
import { useGeolocation } from '@/hooks/useGeolocation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Star, Briefcase, Calendar, ArrowLeft, MapPin, Navigation, BadgeCheck, Check } from 'lucide-react'
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
  avg_rating?: number | null
  rating_count?: number | null
  vouches_received_count?: number | null
}

interface RatingOut {
  id: string
  rater_id: string
  rater_name?: string | null
  rater_image?: string | null
  job_title?: string | null
  score: number
  comment?: string | null
  created_at: string
}

// Distance maths lives in @/lib/geo so it exists once, not three times.

/** Filled/empty star row, drawn with icons rather than literal glyphs. */
function Stars({ value, className = 'w-3.5 h-3.5' }: { value: number; className?: string }) {
  const rounded = Math.round(value)
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star
          key={n}
          className={`${className} ${n <= rounded ? 'text-amber-400' : 'text-gray-300'}`}
          fill={n <= rounded ? 'currentColor' : 'none'}
        />
      ))}
    </span>
  )
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

  // Shared device location — this page used to run its own getCurrentPosition,
  // one of five independent copies across the app.
  const { latitude: viewerLat, longitude: viewerLng } = useGeolocation()

  const { data: profile, isLoading } = useQuery<PublicUser>({
    queryKey: ['publicUser', userId],
    queryFn: async () => { const { data } = await api.get(`/users/${userId}`); return data },
    enabled: !!userId,
  })

  const { data: ratings } = useQuery<RatingOut[]>({
    queryKey: ['ratings', userId],
    queryFn: async () => { const { data } = await api.get(`/ratings/user/${userId}`); return data },
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

  // `== null` not truthiness: a coordinate of 0 is a real place, and the old
  // falsy checks silently hid anyone on the equator or prime meridian.
  const distanceKm = haversineKm(
    viewerLat, viewerLng, profile.location_lat, profile.location_lng,
  )

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
                {!!profile.vouches_received_count && profile.vouches_received_count > 0 && (
                  <Badge className="bg-green-50 text-green-700 border-green-200 text-xs">
                    <BadgeCheck className="w-3 h-3 mr-1" />
                    {profile.vouches_received_count} vouch{profile.vouches_received_count !== 1 ? 'es' : ''}
                  </Badge>
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
              {profile.location_lat != null && distanceKm == null && (
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
          <div className="grid grid-cols-4 gap-3 mt-6 text-center border-t pt-4">
            <div>
              <p className="text-xl font-bold">{vouches?.length || 0}</p>
              <p className="text-xs text-gray-500 mt-0.5">Vouches</p>
            </div>
            <div>
              <p className="text-xl font-bold">{services?.filter(s => s.is_active).length || 0}</p>
              <p className="text-xs text-gray-500 mt-0.5">Services</p>
            </div>
            <div>
              {profile.avg_rating ? (
                <>
                  <p className="text-xl font-bold text-amber-500 flex items-center gap-1 justify-center">
                    {profile.avg_rating.toFixed(1)}
                    <Star className="w-4 h-4" fill="currentColor" />
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">{profile.rating_count} rating{profile.rating_count !== 1 ? 's' : ''}</p>
                </>
              ) : (
                <>
                  <p className="text-xl font-bold text-gray-300">—</p>
                  <p className="text-xs text-gray-500 mt-0.5">No ratings</p>
                </>
              )}
            </div>
            <div>
              <p className="text-xl font-bold flex justify-center">{profile.is_verified ? <Check className="w-5 h-5 text-green-600" /> : <span className="text-gray-300">—</span>}</p>
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
                  <p className="text-sm font-semibold text-black mt-1.5">{fmtPrice(parseFloat(s.price as string))}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Ratings */}
      {ratings && ratings.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Star className="w-4 h-4 text-amber-500" fill="currentColor" /> Ratings & Reviews
            </CardTitle>
          </CardHeader>
          <CardContent>
            {/* Average header + star distribution */}
            {(() => {
              const avg = ratings.reduce((s, r) => s + r.score, 0) / ratings.length
              const dist = [5, 4, 3, 2, 1].map(star => ({
                star,
                n: ratings.filter(r => r.score === star).length,
              }))
              return (
                <div className="flex gap-6 items-center mb-4 pb-4 border-b">
                  <div className="text-center shrink-0">
                    <p className="text-4xl font-bold text-amber-500">{avg.toFixed(1)}</p>
                    <Stars value={avg} className="w-4 h-4" />
                    <p className="text-xs text-gray-500 mt-1">{ratings.length} review{ratings.length !== 1 ? 's' : ''}</p>
                  </div>
                  <div className="flex-1 space-y-1">
                    {dist.map(({ star, n }) => (
                      <div key={star} className="flex items-center gap-2 text-xs">
                        <span className="w-3 text-gray-500">{star}</span>
                        <Star className="w-3 h-3 text-amber-400" fill="currentColor" />
                        <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
                          <div className="h-full bg-amber-400 rounded-full" style={{ width: `${(n / ratings.length) * 100}%` }} />
                        </div>
                        <span className="w-4 text-right text-gray-400">{n}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}

            {/* Individual reviews, each tied to its job */}
            <div className="space-y-3">
              {ratings.map(r => (
                <div key={r.id} className="bg-gray-50 rounded-xl p-3 border border-gray-100">
                  <div className="flex items-start justify-between gap-2">
                    <Link to={`/dashboard/user/${r.rater_id}`} className="flex items-center gap-2 min-w-0 group cursor-pointer hover:opacity-80 transition-opacity">
                      {r.rater_image ? (
                        <img src={r.rater_image} alt={r.rater_name || ''} className="w-7 h-7 rounded-full object-cover shrink-0" />
                      ) : (
                        <span className="w-7 h-7 rounded-full bg-gray-200 flex items-center justify-center text-[10px] font-medium text-gray-600 shrink-0">
                          {(r.rater_name || '?').slice(0, 2).toUpperCase()}
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate group-hover:underline">{r.rater_name || 'Someone'}</p>
                        <Stars value={r.score} className="w-3 h-3" />
                      </div>
                    </Link>
                    <span className="text-xs text-gray-400 shrink-0">{new Date(r.created_at).toLocaleDateString()}</span>
                  </div>
                  {r.job_title && (
                    <p className="text-xs text-gray-500 mt-2">
                      for <span className="font-medium text-gray-700">{r.job_title}</span>
                    </p>
                  )}
                  {r.comment && <p className="text-sm text-gray-600 mt-1">{r.comment}</p>}
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
                  <div className="text-sm min-w-0">
                    <Link to={`/dashboard/user/${v.voucher_id}`} className="hover:underline hover:opacity-80 transition-opacity">
                      <VoucherName voucherId={v.voucher_id} />
                    </Link>
                    <span className="text-gray-500"> vouched for </span>
                    {(v as any).job_title ? (
                      <span className="font-medium text-gray-800 dark:text-gray-200">{(v as any).job_title}</span>
                    ) : (
                      <span className="text-gray-500">completed work</span>
                    )}
                    {v.cnf_nft_id && (
                      <span className={`ml-1.5 text-xs px-1.5 py-0.5 rounded-full border ${VOUCH_TONE_CLASS[vouchProof(v.cnf_nft_id).tone]}`}>
                        {vouchProof(v.cnf_nft_id).label}
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
