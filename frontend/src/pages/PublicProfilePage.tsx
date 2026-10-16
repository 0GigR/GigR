import { useState, useEffect } from 'react'
import { fmtPrice } from '@/store/currencyStore'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import api, { extractError } from '@/lib/api'
import { haversineKm } from '@/lib/geo'
import { useGeolocation } from '@/hooks/useGeolocation'
import { useAuthStore } from '@/store/authStore'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Avatar, AvatarImage, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import {
  Star,
  Briefcase,
  Calendar,
  ArrowLeft,
  MapPin,
  Navigation,
  BadgeCheck,
  Check,
  Share2,
  MessageSquare,
  ShieldCheck,
} from 'lucide-react'
import OnlineIndicator from '@/components/OnlineIndicator'
import AuthDialog from '@/components/AuthDialog'
import { cn } from '@/lib/utils'
import type { components } from '@/types/api'

type Vouch = components['schemas']['VouchOut']
type Service = components['schemas']['ServiceOut']

interface PublicUser {
  id: string
  display_name: string
  username?: string | null
  handle?: string | null
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
  const { data: voucherUser } = useQuery<PublicUser>({
    queryKey: ['user', voucherId],
    queryFn: async () => {
      const response = await api.get(`/users/${voucherId}`)
      return response.data
    },
    enabled: !!voucherId,
    staleTime: 5 * 60 * 1000,
  })
  return <span className="font-medium">{voucherUser?.display_name || 'Someone'}</span>
}

export default function PublicProfilePage() {
  const { userId } = useParams<{ userId: string }>()
  const navigate = useNavigate()
  const { user: currentUser } = useAuthStore()

  const [authOpen, setAuthOpen] = useState(false)
  const [requestingServiceId, setRequestingServiceId] = useState<string | null>(null)

  // Shared device location for proximity calculation
  const { latitude: viewerLat, longitude: viewerLng } = useGeolocation()

  const { data: profile, isLoading } = useQuery<PublicUser>({
    queryKey: ['publicUser', userId],
    queryFn: async () => {
      const response = await api.get(`/users/${userId}`)
      return response.data
    },
    enabled: !!userId,
  })

  // Dependent queries use the verified UUID from the resolved profile
  const targetUserId = profile?.id

  const { data: ratings } = useQuery<RatingOut[]>({
    queryKey: ['ratings', targetUserId],
    queryFn: async () => {
      const response = await api.get(`/ratings/user/${targetUserId}`)
      return response.data
    },
    enabled: !!targetUserId,
  })

  const { data: vouches } = useQuery<Vouch[]>({
    queryKey: ['vouches', targetUserId],
    queryFn: async () => {
      const response = await api.get(`/vouches/user/${targetUserId}`)
      return response.data
    },
    enabled: !!targetUserId,
  })

  const { data: services } = useQuery<Service[]>({
    queryKey: ['userServices', targetUserId],
    queryFn: async () => {
      const response = await api.get(`/services/provider/${targetUserId}`)
      return response.data
    },
    enabled: !!targetUserId,
  })

  // Dynamic SEO meta tags and Schema.org JSON-LD for search engine bots and social scrapers
  useEffect(() => {
    if (!profile) return

    const pageTitle = `${profile.display_name} — Services & Portfolio | Gigr`
    document.title = pageTitle

    const metaDescription =
      profile.bio ||
      `${profile.display_name}'s verified neighborhood services, client reviews, and reputation on Gigr.`
    const profileSlug = profile.username || profile.handle || profile.id
    const shareUrl = `${window.location.origin}/profile/${encodeURIComponent(profileSlug)}`
    const imageUrl = profile.profile_image_url || `${window.location.origin}/icon.png`

    const updateOrCreateMeta = (attrName: string, attrVal: string, contentVal: string) => {
      let tag = document.querySelector(`meta[${attrName}="${attrVal}"]`)
      if (!tag) {
        tag = document.createElement('meta')
        tag.setAttribute(attrName, attrVal)
        document.head.appendChild(tag)
      }
      tag.setAttribute('content', contentVal)
    }

    updateOrCreateMeta('name', 'description', metaDescription)
    updateOrCreateMeta('name', 'robots', 'index, follow')
    updateOrCreateMeta('property', 'og:title', pageTitle)
    updateOrCreateMeta('property', 'og:description', metaDescription)
    updateOrCreateMeta('property', 'og:image', imageUrl)
    updateOrCreateMeta('property', 'og:url', shareUrl)
    updateOrCreateMeta('property', 'og:type', 'profile')
    updateOrCreateMeta('name', 'twitter:card', 'summary')
    updateOrCreateMeta('name', 'twitter:title', pageTitle)
    updateOrCreateMeta('name', 'twitter:description', metaDescription)
    updateOrCreateMeta('name', 'twitter:image', imageUrl)

    let canonical = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null
    if (!canonical) {
      canonical = document.createElement('link')
      canonical.rel = 'canonical'
      document.head.appendChild(canonical)
    }
    canonical.href = shareUrl

    // Schema.org JSON-LD structured data for bots and web crawlers
    const jsonLdId = 'gigr-profile-jsonld'
    let scriptTag = document.getElementById(jsonLdId) as HTMLScriptElement | null
    if (!scriptTag) {
      scriptTag = document.createElement('script')
      scriptTag.id = jsonLdId
      scriptTag.type = 'application/ld+json'
      document.head.appendChild(scriptTag)
    }

    const structuredProfile: Record<string, unknown> = {
      '@context': 'https://schema.org',
      '@type': 'Person',
      name: profile.display_name,
      description: metaDescription,
      image: imageUrl,
      url: shareUrl,
    }

    if (profile.skills && profile.skills.length > 0) {
      structuredProfile.knowsAbout = profile.skills
    }

    if (profile.avg_rating && profile.rating_count) {
      structuredProfile.aggregateRating = {
        '@type': 'AggregateRating',
        ratingValue: profile.avg_rating,
        reviewCount: profile.rating_count,
        bestRating: 5,
        worstRating: 1,
      }
    }

    scriptTag.text = JSON.stringify(structuredProfile)

    return () => {
      const existing = document.getElementById(jsonLdId)
      if (existing) existing.remove()
      document.title = 'Gigr — Trusted Local Services Marketplace | Hire Nearby Pros'
    }
  }, [profile])

  const handleShare = async () => {
    if (!profile) return
    const profileSlug = profile.username || profile.handle || profile.id
    const shareUrl = `${window.location.origin}/profile/${encodeURIComponent(profileSlug)}`
    const shareTitle = `${profile.display_name} — Gigr Portfolio`
    const shareText = `Check out ${profile.display_name}'s verified services, reviews, and vouches on Gigr:`

    if (navigator.share) {
      try {
        await navigator.share({
          title: shareTitle,
          text: shareText,
          url: shareUrl,
        })
        return
      } catch (shareErr: any) {
        if (shareErr.name === 'AbortError') return
      }
    }

    if (navigator.clipboard) {
      await navigator.clipboard.writeText(shareUrl)
      toast.success('Public portfolio link copied to clipboard!')
    }
  }

  const handleContact = () => {
    if (!currentUser) {
      setAuthOpen(true)
      return
    }
    if (currentUser.id === profile?.id) return
    navigate('/dashboard/messages')
  }

  const handleRequestService = async (service: Service) => {
    if (!currentUser) {
      setAuthOpen(true)
      return
    }
    if (currentUser.id === profile?.id) {
      toast.info('This is your own service listing')
      return
    }
    if (requestingServiceId) return
    setRequestingServiceId(service.id)
    try {
      await api.post(`/jobs/request-service/${service.id}`)
      toast.success(`Request sent for "${service.title}"! View it under Jobs.`)
    } catch (err: any) {
      toast.error(extractError(err, 'Failed to request service'))
    } finally {
      setRequestingServiceId(null)
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-4 max-w-3xl mx-auto py-8 px-4">
        <Skeleton className="h-48 w-full rounded-2xl" />
        <Skeleton className="h-32 w-full rounded-2xl" />
      </div>
    )
  }

  if (!profile) {
    return (
      <div className="text-center py-16 text-gray-500 max-w-3xl mx-auto px-4">
        <p className="text-lg font-medium">User not found.</p>
        <p className="text-xs text-gray-400 mt-1">The profile link may be invalid or no longer active.</p>
        <Button variant="outline" size="sm" onClick={() => navigate('/')} className="mt-4 text-xs">
          Return Home
        </Button>
      </div>
    )
  }

  const distanceKm = haversineKm(
    viewerLat,
    viewerLng,
    profile.location_lat,
    profile.location_lng,
  )

  const initials = profile.display_name?.[0]?.toUpperCase() || '?'
  const isOwnProfile = currentUser?.id === profile.id

  return (
    <div
      className={cn(
        'space-y-6 animate-in fade-in duration-500 max-w-3xl',
        !currentUser && 'mx-auto px-4 py-8',
      )}
    >
      {/* Public Header Bar for Guests */}
      {!currentUser ? (
        <div className="flex items-center justify-between py-3 px-4 rounded-2xl bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-800 shadow-sm">
          <Link to="/" className="flex items-center gap-2 group">
            <span className="font-bold text-lg tracking-tight group-hover:opacity-80 transition-opacity">
              Gigr
            </span>
            <span className="text-xs text-gray-400 border-l border-gray-200 dark:border-gray-700 pl-2">
              Portfolio
            </span>
          </Link>
          <Button
            size="sm"
            onClick={() => setAuthOpen(true)}
            className="h-8 text-xs bg-black text-white dark:bg-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 rounded-lg px-3"
          >
            Sign In / Join
          </Button>
        </div>
      ) : (
        <Button variant="ghost" onClick={() => navigate(-1)} className="-ml-2 text-xs h-8">
          <ArrowLeft className="w-4 h-4 mr-2" /> Back
        </Button>
      )}

      {/* Hero card */}
      <Card className="overflow-hidden border-gray-200 dark:border-gray-800">
        <CardContent className="pt-6">
          <div className="flex flex-col sm:flex-row items-start gap-5">
            <Avatar className="h-24 w-24 shrink-0 ring-4 ring-white dark:ring-gray-800 shadow-lg">
              <AvatarImage src={profile.profile_image_url || undefined} />
              <AvatarFallback className="text-3xl bg-black text-white dark:bg-white dark:text-black font-semibold">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h1 className="text-2xl font-bold truncate">{profile.display_name}</h1>
                {(profile.username || profile.handle) && (
                  <span className="text-xs font-mono text-gray-500 dark:text-gray-400">
                    @{profile.username || profile.handle}
                  </span>
                )}
                {profile.is_verified && (
                  <Badge className="bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-200 dark:border-gray-700 text-xs font-medium">
                    <ShieldCheck className="w-3 h-3 mr-1" />
                    Verified
                  </Badge>
                )}
                {!!profile.vouches_received_count && profile.vouches_received_count > 0 && (
                  <Badge className="bg-gray-100 dark:bg-gray-800 text-gray-900 dark:text-gray-100 border-gray-200 dark:border-gray-700 text-xs font-medium">
                    <BadgeCheck className="w-3 h-3 mr-1" />
                    {profile.vouches_received_count} vouch{profile.vouches_received_count !== 1 ? 'es' : ''}
                  </Badge>
                )}
                {profile.role === 'admin' || profile.role === 'superadmin' ? (
                  <Badge className="bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 border-gray-200 dark:border-gray-700 text-xs">
                    Admin
                  </Badge>
                ) : null}
              </div>

              {/* Online + last seen */}
              <div className="flex items-center gap-2 mt-1.5">
                <OnlineIndicator lastSeenAt={profile.last_seen_at} showLabel />
              </div>

              {/* Distance */}
              {distanceKm !== null && (
                <div className="flex items-center gap-1.5 mt-1.5 text-sm text-gray-600 dark:text-gray-400">
                  <Navigation className="w-3.5 h-3.5 text-gray-700 dark:text-gray-300" />
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
                Joined{' '}
                {new Date(profile.created_at).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'long',
                })}
              </div>

              {profile.bio && (
                <p className="mt-3 text-sm text-gray-700 dark:text-gray-300 leading-relaxed">
                  {profile.bio}
                </p>
              )}

              {profile.skills && profile.skills.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {profile.skills.map((skillName) => (
                    <span
                      key={skillName}
                      className="bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 text-xs px-2.5 py-1 rounded-full border border-gray-200 dark:border-gray-700"
                    >
                      {skillName}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Action buttons (Share Portfolio, Message) */}
          <div className="flex flex-wrap items-center gap-2 mt-5 pt-4 border-t border-gray-100 dark:border-gray-800 sm:justify-end">
            <Button
              variant="outline"
              size="sm"
              onClick={handleShare}
              className="h-8 text-xs border-gray-200 dark:border-gray-700"
            >
              <Share2 className="w-3.5 h-3.5 mr-1.5" />
              Share Portfolio
            </Button>
            {!isOwnProfile ? (
              <Button
                size="sm"
                onClick={handleContact}
                className="h-8 text-xs bg-black text-white dark:bg-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200"
              >
                <MessageSquare className="w-3.5 h-3.5 mr-1.5" />
                Message
              </Button>
            ) : (
              <Link
                to="/dashboard/profile"
                className="text-xs text-gray-500 hover:text-black dark:hover:text-white underline ml-2"
              >
                Edit your profile
              </Link>
            )}
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-4 gap-3 mt-5 text-center border-t border-gray-100 dark:border-gray-800 pt-4">
            <div>
              <p className="text-xl font-bold">{vouches?.length || 0}</p>
              <p className="text-xs text-gray-500 mt-0.5">Vouches</p>
            </div>
            <div>
              <p className="text-xl font-bold">
                {services?.filter((item) => item.is_active).length || 0}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">Services</p>
            </div>
            <div>
              {profile.avg_rating ? (
                <>
                  <p className="text-xl font-bold text-amber-500 flex items-center gap-1 justify-center">
                    {profile.avg_rating.toFixed(1)}
                    <Star className="w-4 h-4" fill="currentColor" />
                  </p>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {profile.rating_count} review{profile.rating_count !== 1 ? 's' : ''}
                  </p>
                </>
              ) : (
                <>
                  <p className="text-xl font-bold text-gray-300 dark:text-gray-600">—</p>
                  <p className="text-xs text-gray-500 mt-0.5">No reviews</p>
                </>
              )}
            </div>
            <div>
              <p className="text-xl font-bold flex justify-center">
                {profile.is_verified ? (
                  <Check className="w-5 h-5 text-green-600" />
                ) : (
                  <span className="text-gray-300 dark:text-gray-600">—</span>
                )}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">Verified</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Services Section */}
      {services && services.length > 0 && (
        <Card className="border-gray-200 dark:border-gray-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Briefcase className="w-4 h-4" /> Offered Services ({services.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-3 sm:grid-cols-2">
              {services
                .filter((item) => item.is_active)
                .map((serviceItem) => (
                  <div
                    key={serviceItem.id}
                    className="bg-gray-50 dark:bg-gray-800/60 rounded-xl p-3.5 border border-gray-100 dark:border-gray-700/60 flex flex-col justify-between space-y-3"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-medium text-sm text-gray-900 dark:text-gray-100">
                          {serviceItem.title}
                        </p>
                        <span className="text-xs font-mono font-semibold text-black dark:text-white shrink-0">
                          {fmtPrice(parseFloat(serviceItem.price as string))}
                        </span>
                      </div>
                      {serviceItem.description && (
                        <p className="text-xs text-gray-500 mt-1 line-clamp-2">
                          {serviceItem.description}
                        </p>
                      )}
                    </div>
                    {!isOwnProfile && (
                      <Button
                        size="sm"
                        disabled={requestingServiceId === serviceItem.id}
                        onClick={() => handleRequestService(serviceItem)}
                        className="w-full h-7 text-xs bg-black text-white dark:bg-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200"
                      >
                        {requestingServiceId === serviceItem.id ? 'Sending request...' : 'Request Service'}
                      </Button>
                    )}
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Ratings & Reviews */}
      {ratings && ratings.length > 0 && (
        <Card className="border-gray-200 dark:border-gray-800">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <Star className="w-4 h-4 text-amber-500" fill="currentColor" /> Ratings & Reviews
            </CardTitle>
          </CardHeader>
          <CardContent>
            {(() => {
              const reviewScoreAvg = ratings.reduce((sum, item) => sum + item.score, 0) / ratings.length
              const scoreDistribution = [5, 4, 3, 2, 1].map((starValue) => ({
                starValue,
                count: ratings.filter((item) => item.score === starValue).length,
              }))
              return (
                <div className="flex gap-6 items-center mb-4 pb-4 border-b border-gray-100 dark:border-gray-800">
                  <div className="text-center shrink-0">
                    <p className="text-4xl font-bold text-amber-500">{reviewScoreAvg.toFixed(1)}</p>
                    <Stars value={reviewScoreAvg} className="w-4 h-4" />
                    <p className="text-xs text-gray-500 mt-1">
                      {ratings.length} review{ratings.length !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <div className="flex-1 space-y-1">
                    {scoreDistribution.map(({ starValue, count }) => (
                      <div key={starValue} className="flex items-center gap-2 text-xs">
                        <span className="w-3 text-gray-500">{starValue}</span>
                        <Star className="w-3 h-3 text-amber-400" fill="currentColor" />
                        <div className="flex-1 h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-amber-400 rounded-full"
                            style={{ width: `${(count / ratings.length) * 100}%` }}
                          />
                        </div>
                        <span className="w-4 text-right text-gray-400">{count}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}

            {/* Individual reviews */}
            <div className="space-y-3">
              {ratings.map((reviewItem) => (
                <div
                  key={reviewItem.id}
                  className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3 border border-gray-100 dark:border-gray-700/60"
                >
                  <div className="flex items-start justify-between gap-2">
                    <Link
                      to={`/profile/${reviewItem.rater_id}`}
                      className="flex items-center gap-2 min-w-0 group cursor-pointer hover:opacity-80 transition-opacity"
                    >
                      {reviewItem.rater_image ? (
                        <img
                          src={reviewItem.rater_image}
                          alt={reviewItem.rater_name || ''}
                          className="w-7 h-7 rounded-full object-cover shrink-0"
                        />
                      ) : (
                        <span className="w-7 h-7 rounded-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center text-[10px] font-medium text-gray-600 dark:text-gray-300 shrink-0">
                          {(reviewItem.rater_name || '?').slice(0, 2).toUpperCase()}
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate group-hover:underline">
                          {reviewItem.rater_name || 'Someone'}
                        </p>
                        <Stars value={reviewItem.score} className="w-3 h-3" />
                      </div>
                    </Link>
                    <span className="text-xs text-gray-400 shrink-0">
                      {new Date(reviewItem.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  {reviewItem.job_title && (
                    <p className="text-xs text-gray-500 mt-2">
                      for <span className="font-medium text-gray-700 dark:text-gray-300">{reviewItem.job_title}</span>
                    </p>
                  )}
                  {reviewItem.comment && (
                    <p className="text-sm text-gray-600 dark:text-gray-300 mt-1">{reviewItem.comment}</p>
                  )}
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Vouches */}
      <Card className="border-gray-200 dark:border-gray-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Star className="w-4 h-4 text-yellow-500" /> Vouches ({vouches?.length || 0})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {vouches?.length ? (
            <div className="space-y-2">
              {vouches.map((vouchItem) => (
                <div
                  key={vouchItem.id}
                  className="flex items-center justify-between bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3 border border-gray-100 dark:border-gray-700/60"
                >
                  <div className="text-sm min-w-0">
                    <Link
                      to={`/profile/${vouchItem.voucher_id}`}
                      className="hover:underline hover:opacity-80 transition-opacity"
                    >
                      <VoucherName voucherId={vouchItem.voucher_id} />
                    </Link>
                    <span className="text-gray-500"> vouched for </span>
                    {(vouchItem as any).job_title ? (
                      <span className="font-medium text-gray-800 dark:text-gray-200">
                        {(vouchItem as any).job_title}
                      </span>
                    ) : (
                      <span className="text-gray-500">completed work</span>
                    )}
                    {vouchItem.cnf_nft_id && (
                      <span className="ml-1.5 text-xs bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-1.5 py-0.5 rounded-full border border-gray-200 dark:border-gray-700 font-mono">
                        cNFT on-chain
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-gray-400 shrink-0 ml-2">
                    {new Date(vouchItem.created_at).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-gray-500">No vouches yet.</p>
          )}
        </CardContent>
      </Card>

      {/* Guest Footer Call to Action */}
      {!currentUser && (
        <div className="p-6 rounded-2xl bg-gray-50 dark:bg-gray-900 border border-gray-100 dark:border-gray-800 text-center space-y-2 mt-8">
          <p className="font-semibold text-sm">Need local services or looking to get hired?</p>
          <p className="text-xs text-gray-500 max-w-md mx-auto">
            Gigr connects you with trusted neighbors. Smart-contract escrow protects every job until work is verified.
          </p>
          <div className="pt-2">
            <Button
              size="sm"
              onClick={() => setAuthOpen(true)}
              className="bg-black text-white dark:bg-white dark:text-black hover:bg-gray-800 dark:hover:bg-gray-200 text-xs px-4"
            >
              Sign In or Join Gigr
            </Button>
          </div>
        </div>
      )}

      {/* Auth Dialog for Gated Actions */}
      <AuthDialog open={authOpen} onOpenChange={setAuthOpen} />
    </div>
  )
}
