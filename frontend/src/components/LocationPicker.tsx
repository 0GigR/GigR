import { useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from 'react-leaflet'
import { LocateFixed, Loader2, Search } from 'lucide-react'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import api from '@/lib/api'

const OSM_FALLBACK_TILE = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

// Draggable pin as a divIcon — never depends on CDN marker PNGs (which used to
// silently fail to load, leaving an invisible marker).
const pinIcon = L.divIcon({
  html: `<div class="gigr-pin" style="position:relative;width:26px;height:26px;">
      <div style="width:26px;height:26px;border-radius:9999px 9999px 9999px 0;transform:rotate(-45deg);background:#2563eb;border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.35)"></div>
    </div>`,
  className: 'gigr-location-pin',
  iconSize: [26, 26],
  iconAnchor: [13, 26],
})

interface Props {
  latitude: number
  longitude: number
  onChange: (lat: number, lng: number) => void
  height?: number
  /** Show the address search box above the map. */
  showSearch?: boolean
}

/** Click-to-place + draggable marker. */
function LocationMarker({
  position,
  setPosition,
}: {
  position: L.LatLng
  setPosition: (p: L.LatLng) => void
}) {
  const markerRef = useRef<L.Marker>(null)

  const eventHandlers = useMemo(
    () => ({
      dragend() {
        const marker = markerRef.current
        if (marker != null) setPosition(marker.getLatLng())
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
      draggable
      eventHandlers={eventHandlers}
      position={position}
      icon={pinIcon}
      ref={markerRef}
    />
  )
}

/** Glide to a coordinate chosen from search / "use my location" (not on drag). */
function MapFocus({ target, flyKey }: { target: L.LatLng; flyKey: number }) {
  const map = useMap()
  useEffect(() => {
    if (!flyKey) return
    map.flyTo(target, Math.max(map.getZoom(), 15), { duration: 0.6 })
    // Only re-fly when an explicit selection happens, never on drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flyKey])
  return null
}

export function LocationPicker({
  latitude,
  longitude,
  onChange,
  height = 256,
  showSearch = true,
}: Props) {
  const [position, setPosition] = useState(() => new L.LatLng(latitude, longitude))
  const [flyKey, setFlyKey] = useState(0)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [showResults, setShowResults] = useState(false)
  const [locating, setLocating] = useState(false)

  // Stay in sync with the parent. The initial state used to be captured once, so
  // re-opening the picker for a different listing showed a stale pin.
  useEffect(() => {
    setPosition((current) => {
      if (
        Math.abs(current.lat - latitude) < 1e-9 &&
        Math.abs(current.lng - longitude) < 1e-9
      ) {
        return current
      }
      return new L.LatLng(latitude, longitude)
    })
  }, [latitude, longitude])

  // Debounce the search box so we don't hit Nominatim on every keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 450)
    return () => clearTimeout(timer)
  }, [query])

  const { data: mapConfig } = useQuery<{ tile_light_url: string; attribution: string }>({
    queryKey: ['map-config'],
    queryFn: async () => (await api.get('/location/map-config')).data,
    staleTime: 24 * 60 * 60 * 1000,
  })

  const { data: results, isFetching: searching } = useQuery<
    Array<{
      latitude: number
      longitude: number
      label?: string | null
      display_name?: string | null
    }>
  >({
    queryKey: ['geocode', debounced, latitude, longitude],
    queryFn: async () => {
      const { data } = await api.get('/location/geocode', {
        params: { q: debounced, limit: 5, lat: latitude, lon: longitude },
      })
      return Array.isArray(data) ? data : []
    },
    enabled: debounced.length >= 3,
    staleTime: 10 * 60 * 1000,
  })

  const commitPosition = (lat: number, lng: number) => {
    setPosition(new L.LatLng(lat, lng))
    setFlyKey((k) => k + 1)
    onChange(lat, lng)
  }

  const useMyLocation = () => {
    if (!navigator.geolocation) return
    setLocating(true)
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        commitPosition(pos.coords.latitude, pos.coords.longitude)
        setLocating(false)
      },
      () => setLocating(false),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    )
  }

  return (
    <div className="space-y-2">
      {showSearch && (
        <div className="relative">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setShowResults(true)
                }}
                onFocus={() => setShowResults(true)}
                placeholder="Search an address or area…"
                className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 focus:ring-2 focus:ring-blue-500"
              />
              {searching && (
                <Loader2 className="w-4 h-4 text-gray-400 animate-spin absolute right-3 top-1/2 -translate-y-1/2" />
              )}
            </div>
            <button
              type="button"
              onClick={useMyLocation}
              title="Use my current location"
              className="shrink-0 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
            >
              {locating ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <LocateFixed className="w-4 h-4" />
              )}
            </button>
          </div>

          {showResults && debounced.length >= 3 && results && results.length > 0 && (
            <div className="absolute z-[1100] mt-1 w-full rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 shadow-xl overflow-hidden">
              {results.map((result, index) => (
                <button
                  key={`${result.latitude}-${result.longitude}-${index}`}
                  type="button"
                  onClick={() => {
                    commitPosition(result.latitude, result.longitude)
                    setQuery(result.label || result.display_name || '')
                    setShowResults(false)
                  }}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-800 border-b last:border-b-0 border-gray-100 dark:border-gray-800"
                >
                  <span className="font-medium text-gray-800 dark:text-gray-100">
                    {result.label || 'Location'}
                  </span>
                  <span className="block text-xs text-gray-500 truncate">
                    {result.display_name}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div
        className="w-full rounded-xl overflow-hidden border border-gray-200 dark:border-gray-800 shadow-sm relative isolate"
        style={{ height }}
      >
        <MapContainer center={position} zoom={15} scrollWheelZoom={false} className="h-full w-full">
          <TileLayer
            attribution={mapConfig?.attribution ?? OSM_ATTRIBUTION}
            url={mapConfig?.tile_light_url ?? OSM_FALLBACK_TILE}
          />
          <MapFocus target={position} flyKey={flyKey} />
          <LocationMarker position={position} setPosition={(p) => commitPosition(p.lat, p.lng)} />
        </MapContainer>
      </div>

      <p className="text-xs text-gray-500">
        Tap the map or drag the pin to fine-tune the exact spot.
      </p>
    </div>
  )
}
