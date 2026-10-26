/**
 * AgentResultMap.tsx — Inline interactive map visualization for agent search results.
 *
 * Displays geospatial pins for service providers or job listings identified
 * by the autonomous AI agent directly inside the activity log stream.
 */

import React, { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { MapPin, ExternalLink } from 'lucide-react'
import { isFeatureEnabled } from '@/lib/featureFlags'
import { makeServicePin, makeJobPin } from '@/lib/mapPins'

export interface AgentMapItem {
  id: string
  title: string
  price: number
  price_display?: string | null
  description?: string | null
  latitude?: number | null
  longitude?: number | null
  distance_km?: number | null
  outside_radius?: boolean | null
  kind?: 'service' | 'job'
  provider_id?: string | null
  provider_name?: string | null
  provider_avatar?: string | null
  client_id?: string | null
  client_name?: string | null
  client_avatar?: string | null
}

interface AgentResultMapProps {
  items: AgentMapItem[]
  onSelectItem?: (itemId: string) => void
  onNavigateToMap?: () => void
}

const OSM_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'



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

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

  if (!isMapFeatureActive || geoItems.length === 0) {
    return null
  }

  const coordinates: [number, number][] = geoItems.map((item) => [
    item.latitude as number,
    item.longitude as number,
  ])

  const initialCenter: [number, number] = coordinates[0] || [6.5244, 3.3792] // Lagos fallback coordinates

  return (
    <div className="relative w-full rounded-2xl overflow-hidden border border-gray-200 dark:border-border shadow-md my-2 bg-gray-100 dark:bg-card">
      {/* Header Badge */}
      <div className="absolute top-2.5 left-2.5 z-[1000] flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-gray-950/85 dark:bg-background/85 text-white backdrop-blur-md border border-white/10 text-xs shadow-sm">
        <MapPin className="w-3.5 h-3.5 text-violet-400" />
        <span className="font-medium text-[11px] tracking-wide">
          {geoItems.length} Map Result{geoItems.length > 1 ? 's' : ''}
        </span>
      </div>

      {onNavigateToMap && (
        <button
          type="button"
          onClick={onNavigateToMap}
          className="absolute top-2.5 right-2.5 z-[1000] flex items-center gap-1 px-2.5 py-1 rounded-lg bg-gray-950/85 dark:bg-background/85 hover:bg-gray-900 dark:hover:bg-card text-white backdrop-blur-md border border-white/10 text-[11px] font-medium transition-colors shadow-sm"
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
            const pinIcon =
              geoItem.kind === 'job'
                ? makeJobPin(geoItem.title, geoItem.price)
                : makeServicePin(geoItem.title, geoItem.price)

            const entityName = geoItem.provider_name || geoItem.client_name
            const entityAvatar = geoItem.provider_avatar || geoItem.client_avatar
            const entityUserId = geoItem.provider_id || geoItem.client_id
            const isSelected = selectedIds.has(geoItem.id)

            return (
              <Marker key={geoItem.id} position={pointPosition} icon={pinIcon}>
                <Popup className="agent-map-popup">
                  <div className="p-1 min-w-[170px] text-gray-900 dark:text-foreground">
                    {entityName && entityUserId && (
                      <div className="flex items-center gap-1.5 mb-1.5 pb-1 border-b border-gray-100 dark:border-border">
                        {entityAvatar ? (
                          <img
                            src={entityAvatar}
                            alt={entityName}
                            className="w-5 h-5 rounded-full object-cover shrink-0"
                          />
                        ) : (
                          <span className="w-5 h-5 rounded-full bg-violet-100 dark:bg-violet-950/50 text-violet-700 dark:text-violet-400 flex items-center justify-center text-[10px] font-bold shrink-0">
                            {entityName.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <Link
                          to={`/dashboard/user/${entityUserId}`}
                          className="text-[11px] font-medium text-gray-800 dark:text-foreground hover:text-violet-600 dark:hover:text-violet-400 truncate underline-offset-2 hover:underline"
                        >
                          {entityName}
                        </Link>
                      </div>
                    )}
                    <p className="font-semibold text-xs leading-tight mb-0.5 truncate">
                      {geoItem.title}
                    </p>
                    <p className="text-xs font-bold text-violet-700 dark:text-violet-400 mb-1.5">
                      {geoItem.price_display || (geoItem.price ? `₦${Number(geoItem.price).toLocaleString()}` : 'Negotiable')}
                    </p>
                    {geoItem.distance_km != null && (
                      <p className="text-[10px] text-gray-500 dark:text-muted-foreground mb-2">
                        {geoItem.distance_km.toFixed(1)} km away
                        {geoItem.outside_radius && (
                          <span className="ml-1 text-amber-600 dark:text-amber-400 font-semibold">[Outside radius]</span>
                        )}
                      </p>
                    )}
                    {onSelectItem && (
                      <button
                        type="button"
                        disabled={isSelected}
                        onClick={() => {
                          setSelectedIds((prev) => new Set(prev).add(geoItem.id))
                          onSelectItem(geoItem.id)
                        }}
                        className={`w-full px-2 py-1 text-[11px] font-medium rounded transition-colors text-center ${
                          isSelected
                            ? 'bg-gray-300 dark:bg-secondary text-gray-500 dark:text-muted-foreground cursor-not-allowed'
                            : 'bg-violet-600 hover:bg-violet-700 text-white'
                        }`}
                      >
                        {isSelected ? 'Requested' : 'Select Option'}
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
