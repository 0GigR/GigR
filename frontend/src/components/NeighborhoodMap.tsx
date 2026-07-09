import { useQuery } from '@tanstack/react-query'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import { Link } from 'react-router-dom'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import api from '@/lib/api'
import type { components } from '@/types/api'
import { Badge } from '@/components/ui/badge'

type Job = components['schemas']['JobOut']
type Service = components['schemas']['ServiceOut']

// Fix leaflet default icon issue (used for the "You are here" pin)
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
})

// ── Avatar marker: a rounded profile photo (or initials) with a coloured ring ──
function makeAvatarIcon(avatarUrl: string | null | undefined, name: string | null | undefined, ring: string): L.DivIcon {
  const initials = (name || '?').slice(0, 2).toUpperCase()
  const inner = avatarUrl
    ? `<img src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:9999px" />`
    : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#e5e7eb;color:#374151;font-size:13px;font-weight:600;border-radius:9999px">${initials}</div>`
  const html = `
    <div style="width:40px;height:40px;border-radius:9999px;border:3px solid ${ring};box-shadow:0 2px 6px rgba(0,0,0,.3);overflow:hidden;background:#fff">
      ${inner}
    </div>`
  return L.divIcon({
    html,
    className: 'gigr-avatar-marker',
    iconSize: [40, 40],
    iconAnchor: [20, 40],
    popupAnchor: [0, -38],
  })
}

// Small hook: fetch a public user (cached across the whole map)
function usePublicUser(userId: string | undefined) {
  return useQuery({
    queryKey: ['user', userId],
    queryFn: async () => { const { data } = await api.get(`/users/${userId}`); return data },
    enabled: !!userId,
    staleTime: 5 * 60 * 1000,
  })
}

// Center map on the user
function MapUpdater({ center }: { center: [number, number] }) {
  const map = useMap()
  map.setView(center, map.getZoom())
  return null
}

function JobMarker({ job }: { job: Job }) {
  const posterId = (job as any).client_id as string | undefined
  const { data: poster } = usePublicUser(posterId)
  if (!job.latitude || !job.longitude) return null
  const icon = makeAvatarIcon(poster?.profile_image_url, poster?.display_name, '#2563eb')
  return (
    <Marker position={[job.latitude, job.longitude]} icon={icon}>
      <Popup>
        <div className="text-sm min-w-[160px]">
          <Badge className="bg-blue-100 text-blue-800 mb-1">Open Job</Badge>
          <h3 className="font-bold">{job.title}</h3>
          <p className="line-clamp-2 text-gray-600">{job.description}</p>
          <p className="font-semibold mt-1">₦{parseFloat(job.price as string).toLocaleString()}</p>
          {posterId && (
            <Link to={`/dashboard/user/${posterId}`} className="inline-flex items-center gap-1 mt-2 text-blue-600 font-medium hover:underline">
              {poster?.profile_image_url && <img src={poster.profile_image_url} className="w-4 h-4 rounded-full object-cover" />}
              {poster?.display_name || 'View poster'} →
            </Link>
          )}
        </div>
      </Popup>
    </Marker>
  )
}

function ServiceMarker({ service }: { service: Service }) {
  const posterId = (service as any).provider_id as string | undefined
  const { data: provider } = usePublicUser(posterId)
  if (!service.latitude || !service.longitude) return null
  const icon = makeAvatarIcon(provider?.profile_image_url, provider?.display_name, '#16a34a')
  return (
    <Marker position={[service.latitude, service.longitude]} icon={icon}>
      <Popup>
        <div className="text-sm min-w-[160px]">
          <Badge className="bg-green-100 text-green-800 mb-1">Service Provider</Badge>
          <h3 className="font-bold">{service.title}</h3>
          <p className="line-clamp-2 text-gray-600">{service.description}</p>
          <p className="font-semibold mt-1">₦{parseFloat(service.price as string).toLocaleString()}</p>
          {posterId && (
            <Link to={`/dashboard/user/${posterId}`} className="inline-flex items-center gap-1 mt-2 text-green-600 font-medium hover:underline">
              {provider?.profile_image_url && <img src={provider.profile_image_url} className="w-4 h-4 rounded-full object-cover" />}
              {provider?.display_name || 'View provider'} →
            </Link>
          )}
        </div>
      </Popup>
    </Marker>
  )
}

export function NeighborhoodMap({ latitude, longitude, type = 'all' }: { latitude: number, longitude: number, type?: 'jobs' | 'services' | 'all' }) {
  const { data: nearbyJobs } = useQuery<Job[]>({
    queryKey: ['nearbyJobs', latitude, longitude],
    queryFn: async () => {
      const { data } = await api.get('/jobs/', { params: { lat: latitude, lon: longitude, radius: 10 } })
      return Array.isArray(data) ? data : []
    },
    enabled: !!latitude && !!longitude && (type === 'jobs' || type === 'all'),
  })

  const { data: nearbyServices } = useQuery<Service[]>({
    queryKey: ['nearbyServices', latitude, longitude],
    queryFn: async () => {
      const { data } = await api.get('/services/search/nearby', { params: { lat: latitude, lon: longitude, radius: 10 } })
      return Array.isArray(data) ? data : []
    },
    enabled: !!latitude && !!longitude && (type === 'services' || type === 'all'),
  })

  return (
    <div className="w-full h-[500px] rounded-xl overflow-hidden border border-gray-200 shadow-sm relative z-0 isolate">
      <MapContainer center={[latitude, longitude]} zoom={13} scrollWheelZoom={false} className="h-full w-full">
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapUpdater center={[latitude, longitude]} />

        {/* User location marker */}
        <Marker position={[latitude, longitude]}>
          <Popup>You are here</Popup>
        </Marker>

        {nearbyJobs?.map(job => <JobMarker key={`job-${job.id}`} job={job} />)}
        {nearbyServices?.map(service => <ServiceMarker key={`service-${service.id}`} service={service} />)}
      </MapContainer>
    </div>
  )
}
