import { useQuery } from '@tanstack/react-query'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import api from '@/lib/api'
import type { components } from '@/types/api'
import { Badge } from '@/components/ui/badge'

type Job = components['schemas']['JobOut']
type Service = components['schemas']['ServiceOut']

// Fix leaflet default icon issue
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
})

// Custom icons
const jobIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-blue.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
})

const serviceIcon = new L.Icon({
  iconUrl: 'https://raw.githubusercontent.com/pointhi/leaflet-color-markers/master/img/marker-icon-2x-green.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41]
})

// Helper to center map on user
function MapUpdater({ center }: { center: [number, number] }) {
  const map = useMap()
  map.setView(center, map.getZoom())
  return null
}

export function NeighborhoodMap({ latitude, longitude, type = 'all' }: { latitude: number, longitude: number, type?: 'jobs' | 'services' | 'all' }) {
  const { data: nearbyJobs } = useQuery<Job[]>({
    queryKey: ['nearbyJobs', latitude, longitude],
    queryFn: async () => {
      const { data } = await api.get('/jobs/', { params: { lat: latitude, lon: longitude, radius: 10 } })
      return data
    },
    enabled: !!latitude && !!longitude && (type === 'jobs' || type === 'all'),
  })

  const { data: nearbyServices } = useQuery<Service[]>({
    queryKey: ['nearbyServices', latitude, longitude],
    queryFn: async () => {
      const { data } = await api.get('/services/search/nearby', { params: { lat: latitude, lon: longitude, radius: 10 } })
      return data
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

        {/* Nearby Jobs */}
        {nearbyJobs?.map(job => (
          job.latitude && job.longitude && (
            <Marker key={`job-${job.id}`} position={[job.latitude, job.longitude]} icon={jobIcon}>
              <Popup>
                <div className="text-sm">
                  <Badge className="bg-blue-100 text-blue-800 mb-1">Open Job</Badge>
                  <h3 className="font-bold">{job.title}</h3>
                  <p className="line-clamp-2">{job.description}</p>
                  <p className="font-semibold mt-1">₦{parseFloat(job.price as string).toLocaleString()}</p>
                </div>
              </Popup>
            </Marker>
          )
        ))}

        {/* Nearby Services */}
        {nearbyServices?.map(service => (
          service.latitude && service.longitude && (
            <Marker key={`service-${service.id}`} position={[service.latitude, service.longitude]} icon={serviceIcon}>
              <Popup>
                <div className="text-sm">
                  <Badge className="bg-green-100 text-green-800 mb-1">Service Provider</Badge>
                  <h3 className="font-bold">{service.title}</h3>
                  <p className="line-clamp-2">{service.description}</p>
                  <p className="font-semibold mt-1">₦{parseFloat(service.price as string).toLocaleString()}</p>
                  <p className="text-xs text-gray-500">{service.radius_km} km radius</p>
                </div>
              </Popup>
            </Marker>
          )
        ))}
      </MapContainer>
    </div>
  )
}
