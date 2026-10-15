/**
 * AgentResultMap.tsx — Inline interactive map visualization for agent search results.
 *
 * Displays geospatial pins for service providers or job listings identified
 * by the autonomous AI agent directly inside the activity log stream.
 */

import React, { useMemo } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapPin, ExternalLink } from 'lucide-react'
import { isFeatureEnabled } from '@/lib/featureFlags'

export interface AgentMapItem {
  id: string
  title: string
  price: number
  description?: string | null
  latitude?: number | null
  longitude?: number | null
  distance_km?: number | null
  kind?: 'service' | 'job'
}

interface AgentResultMapProps {
  items: AgentMapItem[]
  onSelectItem?: (itemId: string) => void
  onNavigateToMap?: () => void
}

const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'

/** Create custom SVG pin for service or job without CDN raster icons */
function createMarkerIcon(title: string, kind: 'service' | 'job' = 'service'): L.DivIcon {
  const accentColor = kind === 'job' ? '#2563eb' : '#7c3aed'
  const letter = (title || 'G').trim().charAt(0).toUpperCase()

  const html = `
    <div style="position:relative;width:32px;height:42px;display:flex;flex-direction:column;align-items:center;">
      <div style="width:30px;height:30px;border-radius:9999px;background:${accentColor};display:flex;align-items:center;justify-content:center;box-shadow:0 3px 8px rgba(0,0,0,0.35);border:2px solid #ffffff;">
        <span style="color:#ffffff;font-size:12px;font-weight:700;line-height:1;font-family:sans-serif;">${letter}</span>
      </div>
      <div style="width:0;height:0;border-left:5px solid transparent;border-right:5px solid transparent;border-top:9px solid ${accentColor};margin-top:-1px;"></div>
    </div>
  `

  return L.divIcon({
    html,
    className: 'agent-map-pin',
    iconSize: [32, 42],
    iconAnchor: [16, 42],
    popupAnchor: [0, -38],
  })
}

/** Recenter and fit map bounds to the markers */
function AutoFitBounds({ points }: { points: [number, number][] }): null {
  const leafletMap = useMap()

  React.useEffect(() => {
    if (points.length === 0) return
    if (points.length === 1) {
      leafletMap.setView(points[0], 14, { animate: true })
      return
    }

    const bounds = L.latLngBounds(points)
    leafletMap.fitBounds(bounds, { padding: [30, 30], maxZoom: 15, animate: true })
  }, [leafletMap, points])

  return null
}

export default function AgentResultMap({
  items,
  onSelectItem,
  onNavigateToMap,
}: AgentResultMapProps): React.ReactElement | null {
  const isMapFeatureActive = isFeatureEnabled('mapResults')

  // Filter items that possess valid numeric coordinates
  const geoItems = useMemo(() => {
    return items.filter(
      (item) =>
        typeof item.latitude === 'number' &&
        typeof item.longitude === 'number' &&
        !isNaN(item.latitude) &&
        !isNaN(item.longitude)
    )
  }, [items])

  if (!isMapFeatureActive || geoItems.length === 0) {
    return null
  }

  const coordinates: [number, number][] = geoItems.map((item) => [
    item.latitude as number,
    item.longitude as number,
  ])

  const initialCenter: [number, number] = coordinates[0] || [6.5244, 3.3792] // Lagos fallback coordinates

  return (
    <div className="relative w-full rounded-2xl overflow-hidden border border-gray-200 dark:border-gray-800 shadow-md my-2 bg-gray-100 dark:bg-gray-900">
      {/* Header Badge */}
      <div className="absolute top-2.5 left-2.5 z-[1000] flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-950/85 text-white backdrop-blur-md border border-white/10 text-xs shadow-sm">
        <MapPin className="w-3.5 h-3.5 text-violet-400" />
        <span className="font-medium text-[11px] tracking-wide">
          {geoItems.length} Map Result{geoItems.length > 1 ? 's' : ''}
        </span>
      </div>

      {onNavigateToMap && (
        <button
          type="button"
          onClick={onNavigateToMap}
          className="absolute top-2.5 right-2.5 z-[1000] flex items-center gap-1 px-2.5 py-1 rounded-lg bg-gray-950/85 hover:bg-gray-900 text-white backdrop-blur-md border border-white/10 text-[11px] font-medium transition-colors shadow-sm"
          title="Open full interactive map"
        >
          <span>Full Map</span>
          <ExternalLink className="w-3 h-3 text-gray-300" />
        </button>
      )}

      {/* Leaflet Map Canvas */}
      <div className="w-full h-48 md:h-56">
        <MapContainer
          center={initialCenter}
          zoom={13}
          scrollWheelZoom={false}
          attributionControl={false}
          className="w-full h-full"
        >
          <TileLayer url={OSM_TILE_URL} attribution={OSM_ATTRIBUTION} />
          <AutoFitBounds points={coordinates} />

          {geoItems.map((geoItem) => {
            const pointPosition: [number, number] = [
              geoItem.latitude as number,
              geoItem.longitude as number,
            ]
            const pinIcon = createMarkerIcon(geoItem.title, geoItem.kind || 'service')

            return (
              <Marker key={geoItem.id} position={pointPosition} icon={pinIcon}>
                <Popup className="agent-map-popup">
                  <div className="p-1 min-w-[160px] text-gray-900">
                    <p className="font-semibold text-xs leading-tight mb-0.5 truncate">
                      {geoItem.title}
                    </p>
                    <p className="text-xs font-bold text-violet-700 mb-1.5">
                      ₦{Number(geoItem.price).toLocaleString()}
                    </p>
                    {geoItem.distance_km != null && (
                      <p className="text-[10px] text-gray-500 mb-2">
                        {geoItem.distance_km.toFixed(1)} km away
                      </p>
                    )}
                    {onSelectItem && (
                      <button
                        type="button"
                        onClick={() => onSelectItem(geoItem.id)}
                        className="w-full px-2 py-1 text-[11px] font-medium bg-violet-600 hover:bg-violet-700 text-white rounded transition-colors text-center"
                      >
                        Select Option
                      </button>
                    )}
                  </div>
                </Popup>
              </Marker>
            )
          })}
        </MapContainer>
      </div>
    </div>
  )
}
