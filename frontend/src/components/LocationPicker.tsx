import { useState, useRef, useMemo } from 'react'
import { MapContainer, TileLayer, Marker, useMapEvents } from 'react-leaflet'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import { useThemeStore } from '@/store/themeStore'

// Fix leaflet default icon issue
delete (L.Icon.Default.prototype as any)._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon-2x.png',
  iconUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-icon.png',
  shadowUrl: 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.7.1/images/marker-shadow.png',
})

interface Props {
  latitude: number
  longitude: number
  onChange: (lat: number, lng: number) => void
}

function LocationMarker({ position, setPosition }: { position: L.LatLng, setPosition: (p: L.LatLng) => void }) {
  const markerRef = useRef<L.Marker>(null)
  
  const eventHandlers = useMemo(
    () => ({
      dragend() {
        const marker = markerRef.current
        if (marker != null) {
          setPosition(marker.getLatLng())
        }
      },
    }),
    [setPosition],
  )

  useMapEvents({
    click(e) {
      setPosition(e.latlng)
    },
  })

  return (
    <Marker
      draggable={true}
      eventHandlers={eventHandlers}
      position={position}
      ref={markerRef}
    />
  )
}

export function LocationPicker({ latitude, longitude, onChange }: Props) {
  const [position, setPosition] = useState(new L.LatLng(latitude, longitude))
  const { theme } = useThemeStore()

  const tileUrl = theme === 'dark' 
    ? 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}'
    : 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}'
  
  const attribution = 'Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ'

  const handlePositionChange = (p: L.LatLng) => {
    setPosition(p)
    onChange(p.lat, p.lng)
  }

  return (
    <div className="w-full h-64 rounded-xl overflow-hidden border border-gray-200 shadow-sm relative z-0 isolate">
      <MapContainer center={position} zoom={13} scrollWheelZoom={false} className="h-full w-full">
        <TileLayer attribution={attribution} url={tileUrl} />
        <LocationMarker position={position} setPosition={handlePositionChange} />
      </MapContainer>
    </div>
  )
}
