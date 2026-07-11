import { useParams, Link, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Send, MapPin, Loader2, Star, Navigation } from 'lucide-react'
import { toast } from 'sonner'
import api from '@/lib/api'
import type { components } from '@/types/api'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import { useGeolocation } from '@/hooks/useGeolocation'

type Service = components['schemas']['ServiceOut']
type User = components['schemas']['UserOut']
type RatingOut = {
  id: string
  job_id: string
  rater_id: string
  ratee_id: string
  score: number
  comment?: string | null
  created_at: string
  rater_name?: string | null
  rater_image?: string | null
  job_title?: string | null
}

function calculateDistance(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371 // Radius of the earth in km
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLon = (lon2 - lon1) * Math.PI / 180
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))
  return R * c // Distance in km
}

// Re-use avatar marker logic or standard Leaflet icon
const defaultIcon = new L.Icon({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
})

export default function ServiceDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const attribution = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  const tileUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'

  const { data: service, isLoading: serviceLoading, error: serviceError } = useQuery<Service>({
    queryKey: ['service', id],
    queryFn: async () => {
      const { data } = await api.get(`/services/${id}`)
      return data
    },
    enabled: !!id,
  })

  const { data: provider, isLoading: providerLoading } = useQuery<User>({
    queryKey: ['user', service?.provider_id],
    queryFn: async () => {
      const { data } = await api.get(`/users/${service?.provider_id}`)
      return data
    },
    enabled: !!service?.provider_id,
  })

  const { latitude, longitude } = useGeolocation()

  const { data: ratings } = useQuery<RatingOut[]>({
    queryKey: ['ratings', service?.provider_id],
    queryFn: async () => {
      const { data } = await api.get(`/ratings/user/${service?.provider_id}`)
      return data
    },
    enabled: !!service?.provider_id,
  })

  const { data: ratingSummary } = useQuery<any>({
    queryKey: ['ratingSummary', service?.provider_id],
    queryFn: async () => {
      const { data } = await api.get(`/ratings/user/${service?.provider_id}/summary`)
      return data
    },
    enabled: !!service?.provider_id,
  })

  let distanceKm = null
  if (latitude && longitude && service?.latitude && service?.longitude) {
    distanceKm = calculateDistance(latitude, longitude, service.latitude, service.longitude)
  }

  // Services the user has already requested (for the "Requested" indicator)
  const { data: myClientJobs } = useQuery<any[]>({
    queryKey: ['myClientJobs'],
    queryFn: async () => { const { data } = await api.get('/jobs/', { params: { my: 'client' } }); return data },
  })

  const hasRequested = (myClientJobs || [])
    .filter(j => !['completed', 'cancelled'].includes(j.status))
    .some((j) => j.service_listing_id === id)

  const requestMutation = useMutation({
    mutationFn: async () => {
      await api.post(`/jobs/request-service/${id}`)
    },
    onMutate: async () => {
      await queryClient.cancelQueries({ queryKey: ['myClientJobs'] })
      const prev = queryClient.getQueryData<any[]>(['myClientJobs'])
      if (prev) {
        queryClient.setQueryData(['myClientJobs'], [...prev, { service_listing_id: id, status: 'requested' }])
      }
      return { prev }
    },
    onError: (err: any, _vars, context: any) => {
      if (context?.prev) {
        queryClient.setQueryData(['myClientJobs'], context.prev)
      }
      toast.error(err.response?.data?.detail || 'Failed to request service')
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['myClientJobs'] })
    },
    onSuccess: () => {
      toast.success(`Request sent! View it in My Jobs.`)
    }
  })

  if (serviceLoading || providerLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
      </div>
    )
  }

  if (serviceError || !service) {
    return (
      <div className="text-center py-12">
        <h2 className="text-xl font-bold text-gray-800">Service not found</h2>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/dashboard/services')}>Back to Services</Button>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-in fade-in duration-500 pb-12">
      <Button variant="ghost" onClick={() => navigate(-1)} className="pl-0 hover:bg-transparent text-gray-500 hover:text-black">
        <ArrowLeft className="w-4 h-4 mr-2" /> Back
      </Button>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {/* Left Column: Details */}
        <div className="md:col-span-2 space-y-6">
          <Card className="bg-card text-card-foreground border-border overflow-hidden">
            {service.image_url && (
              <div className="w-full h-64 md:h-96 relative">
                <img src={service.image_url} className="w-full h-full object-cover" alt={service.title} />
                <div className="absolute top-4 right-4 flex gap-2">
                  <Badge className={service.is_active ? 'bg-black text-white' : 'bg-gray-200 text-gray-600'}>
                    {service.is_active ? 'Active' : 'Paused'}
                  </Badge>
                </div>
              </div>
            )}
            
            <CardContent className={service.image_url ? "pt-6" : "pt-6"}>
              <div className="flex justify-between items-start mb-4">
                <h1 className="text-3xl font-bold">{service.title}</h1>
                <div className="text-right">
                  <p className="text-2xl font-bold text-black">₦{parseFloat(service.price as string).toLocaleString()}</p>
                  <p className="text-sm text-gray-500">Base Price</p>
                </div>
              </div>

              <div className="prose prose-sm md:prose-base dark:prose-invert max-w-none mb-8 whitespace-pre-wrap text-gray-700">
                {service.description || 'No description provided.'}
              </div>

              {/* Provider Info */}
              {provider && (
                <div className="border-t border-gray-100 pt-6 mt-6">
                  <h3 className="text-lg font-semibold mb-4">About the Provider</h3>
                  <div className="flex items-center gap-4">
                    <Link to={`/dashboard/user/${provider.id}`} className="flex-shrink-0">
                      {provider.profile_image_url ? (
                        <img src={provider.profile_image_url} className="w-16 h-16 rounded-full object-cover border-2 border-gray-100" />
                      ) : (
                        <div className="w-16 h-16 rounded-full bg-gray-200 flex items-center justify-center text-xl font-bold text-gray-500">
                          {provider.display_name?.slice(0, 2).toUpperCase()}
                        </div>
                      )}
                    </Link>
                    <div>
                      <Link to={`/dashboard/user/${provider.id}`} className="text-lg font-semibold hover:underline">
                        {provider.display_name}
                      </Link>
                      <p className="text-sm text-gray-500 flex items-center gap-1">
                        <MapPin className="w-3 h-3" /> 
                        {(provider as any).location_public ? 'Location public' : 'Location private'}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Reviews & Ratings */}
              {ratings && ratings.length > 0 && (
                <div className="border-t border-gray-100 pt-6 mt-6">
                  <div className="flex items-center gap-3 mb-6">
                    <h3 className="text-lg font-semibold">Provider Reviews</h3>
                    {ratingSummary?.average && (
                      <div className="flex items-center gap-1 bg-yellow-50 text-yellow-700 px-2 py-1 rounded-full text-sm font-semibold border border-yellow-200">
                        <Star className="w-4 h-4 fill-yellow-500 text-yellow-500" />
                        {ratingSummary.average} ({ratingSummary.count})
                      </div>
                    )}
                  </div>
                  <div className="space-y-6">
                    {ratings.map(rating => (
                      <div key={rating.id} className="bg-gray-50 p-4 rounded-xl border border-gray-100">
                        <div className="flex justify-between items-start mb-3">
                          <Link to={`/dashboard/user/${rating.rater_id}`} className="flex items-center gap-2 group">
                            {rating.rater_image ? (
                              <img src={rating.rater_image} className="w-8 h-8 rounded-full object-cover" />
                            ) : (
                              <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center text-xs font-bold text-gray-500">
                                {rating.rater_name?.slice(0, 2).toUpperCase()}
                              </div>
                            )}
                            <div>
                              <span className="font-semibold text-sm group-hover:underline">{rating.rater_name}</span>
                              <p className="text-xs text-gray-500">for {rating.job_title}</p>
                            </div>
                          </Link>
                          <div className="flex items-center">
                            {[...Array(5)].map((_, i) => (
                              <Star key={i} className={`w-3 h-3 ${i < rating.score ? 'fill-yellow-400 text-yellow-400' : 'fill-gray-200 text-gray-200'}`} />
                            ))}
                          </div>
                        </div>
                        {rating.comment && (
                          <p className="text-sm text-gray-700 italic">"{rating.comment}"</p>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right Column: Actions & Map */}
        <div className="space-y-6">
          <Card className="bg-card text-card-foreground border-border sticky top-6">
            <CardContent className="p-6">
              <Button 
                className="w-full h-12 text-lg font-semibold bg-black text-white hover:bg-gray-800 disabled:opacity-60"
                onClick={() => requestMutation.mutate()}
                disabled={hasRequested || requestMutation.isPending || !service.is_active}
              >
                {requestMutation.isPending ? <Loader2 className="w-5 h-5 mr-2 animate-spin" /> : <Send className="w-5 h-5 mr-2" />}
                {!service.is_active ? 'Service Paused' : hasRequested ? 'Already Requested' : 'Request Service'}
              </Button>
              <p className="text-xs text-center text-gray-500 mt-3">
                Payment is securely held in escrow until the job is completed.
              </p>
            </CardContent>
          </Card>

          {/* Map Location */}
          {service.latitude && service.longitude && (
            <Card className="bg-card text-card-foreground border-border overflow-hidden">
              <div className="p-4 border-b border-gray-100 flex items-center justify-between">
                <h3 className="font-semibold text-sm flex items-center gap-2">
                  <MapPin className="w-4 h-4 text-blue-500" />
                  Service Area
                </h3>
                <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded-full">
                  {service.radius_km}km radius
                </span>
              </div>
              {distanceKm !== null && (
                <div className="bg-blue-50 border-b border-blue-100 px-4 py-3 flex items-center gap-2">
                  <Navigation className="w-4 h-4 text-blue-500" />
                  <span className="text-sm text-blue-800 font-medium">{distanceKm.toFixed(1)} km away from you</span>
                </div>
              )}
              <div className="h-48 w-full relative z-0 isolate">
                <MapContainer center={[service.latitude, service.longitude]} zoom={13} scrollWheelZoom={false} className="h-full w-full">
                  <TileLayer attribution={attribution} url={tileUrl} />
                  <Marker position={[service.latitude, service.longitude]} icon={defaultIcon}>
                    <Popup>{service.title}</Popup>
                  </Marker>
                </MapContainer>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
