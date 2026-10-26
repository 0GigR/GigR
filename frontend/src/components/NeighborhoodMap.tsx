import { fmtPrice } from '@/store/currencyStore'
import { useQueries, useQuery } from '@tanstack/react-query'
import {
  MapContainer, TileLayer, Marker, Popup, Circle, useMap, useMapEvents,
} from 'react-leaflet'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Flame, Layers, Navigation } from 'lucide-react'
import 'leaflet/dist/leaflet.css'
import L from 'leaflet'
import api from '@/lib/api'
import type { components } from '@/types/api'
import { Badge } from '@/components/ui/badge'

type Job = components['schemas']['JobOut']
type Service = components['schemas']['ServiceOut']

const OSM_FALLBACK_TILE = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
const OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'

const RADIUS_CHOICES = [0.2, 0.5, 1, 5, 10, 25, 0]
const CLUSTER_CELL_PX = 70

const JOB_COLOR = '#2563eb'
const SERVICE_COLOR = '#16a34a'
const MIXED_COLOR = '#7c3aed'

/** A marker candidate, normalised from either a Job or a ServiceListing. */
/**
 * Only ever iterate something that is really an array.
 *
 * React Query keys are global: anything asking for the same key receives the
 * same cached value, whatever shape its own query function produced. That is
 * exactly how the map crashed — see the namespaced keys below.
 */
function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

export interface MapPoint {
  id: string
  kind: 'job' | 'service'
  lat: number
  lng: number
  title: string
  description?: string | null
  price: number
  ownerId?: string
  /** Server-computed distance in km (from /search/nearby). */
  distanceKm?: number | null
}

// ── Icons ─────────────────────────────────────────────────────────────────────

/** Classic location pin: round avatar head + triangular point on the coordinate. */
function makeAvatarIcon(
  avatarUrl: string | null | undefined,
  name: string | null | undefined,
  ring: string,
  highlighted = false,
  /** Jobs are square, services are round — shape reads faster than colour. */
  shape: 'square' | 'round' = 'round',
  bloomDelayMs = 0,
): L.DivIcon {
  const headRadius = shape === 'square' ? '10px' : '9999px'
  const innerRadius = shape === 'square' ? '7px' : '9999px'
  const pointRadius = shape === 'square' ? '2px' : '9999px'
  const initials = (name || '?').slice(0, 2).toUpperCase()
  const inner = avatarUrl
    ? `<img src="${avatarUrl}" style="width:100%;height:100%;object-fit:cover;border-radius:${innerRadius}" />`
    : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#e5e7eb;color:#374151;font-size:12px;font-weight:700;border-radius:${innerRadius}">${initials}</div>`

  const halo = highlighted
    ? `<div class="gigr-ring" style="position:absolute;top:0;left:0;width:40px;height:40px;border-radius:9999px;background:${ring};"></div>`
    : ''

  const html = `
    <div class="gigr-pin animate-pin-bloom" style="position:relative;width:40px;height:52px;animation-delay:${bloomDelayMs}ms;">
      ${halo}
      <div style="position:absolute;top:0;left:0;width:40px;height:40px;border-radius:${headRadius};background:${ring};box-shadow:0 3px 6px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;${highlighted ? `outline:3px solid #fff;outline-offset:1px;` : ''}">
        <div style="width:32px;height:32px;border-radius:${innerRadius};overflow:hidden;background:#fff;">${inner}</div>
      </div>
      <div style="position:absolute;top:35px;left:50%;transform:translateX(-50%);width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-top:15px solid ${ring};border-radius:${pointRadius};"></div>
    </div>`
  return L.divIcon({
    html,
    className: 'gigr-avatar-marker',
    iconSize: [40, 52],
    iconAnchor: [20, 52],
    popupAnchor: [0, -48],
  })
}


// "You are here" — a pulsing dot that never depends on CDN marker PNGs.
const userLocationIcon = L.divIcon({
  html: `
    <div style="position:relative;width:22px;height:22px;">
      <div class="gigr-ring" style="position:absolute;inset:0;border-radius:9999px;background:rgba(37,99,235,.35);"></div>
      <div style="position:absolute;top:5px;left:5px;width:12px;height:12px;border-radius:9999px;background:#2563eb;border:2px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.4);"></div>
    </div>`,
  className: 'gigr-user-marker',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
  popupAnchor: [0, -12],
})

// ── Map behaviour ─────────────────────────────────────────────────────────────

/**
 * Re-centre only when the *target* coordinate actually changes.
 *
 * The previous version called `map.setView()` on every render, so any state
 * change (a refetch, a hover, a theme toggle) yanked the viewport back from
 * wherever the user had panned to.
 */
function MapUpdater({ center, focus }: { center: [number, number]; focus: [number, number] | null }) {
  const map = useMap()
  // Seeded with the centre we were mounted with, so the first run is a no-op.
  // MapContainer already placed the view; flying there again would start an
  // animation on every mount for no reason.
  const lastCenter = useRef<string | null>(
    `${center[0].toFixed(5)},${center[1].toFixed(5)}`,
  )

  useEffect(() => {
    const key = `${center[0].toFixed(5)},${center[1].toFixed(5)}`
    if (lastCenter.current === key) return
    lastCenter.current = key
    map.flyTo(center, map.getZoom(), { duration: 0.6 })
  }, [map, center])

  // Selecting a result glides the map to it instead of jumping.
  useEffect(() => {
    if (!focus) return
    map.flyTo(focus, Math.max(map.getZoom(), 15), { duration: 0.7 })
  }, [map, focus])

  return null
}

/** Clears the selection when the user dismisses a popup or taps the map. */
function SelectionWatcher({ onClear }: { onClear?: () => void }) {
  useMapEvents({
    popupclose: () => onClear?.(),
    click: () => onClear?.(),
  })
  return null
}

function clusterPoints(map: L.Map, points: MapPoint[]) {
  const zoom = map.getZoom()
  const buckets = new Map<string, MapPoint[]>()
  for (const point of points) {
    const projected = map.project([point.lat, point.lng], zoom)
    const key = `${Math.floor(projected.x / CLUSTER_CELL_PX)}:${Math.floor(projected.y / CLUSTER_CELL_PX)}`
    const bucket = buckets.get(key)
    if (bucket) bucket.push(point)
    else buckets.set(key, [point])
  }
  return Array.from(buckets.values()).map((group) => ({
    lat: group.reduce((sum, p) => sum + p.lat, 0) / group.length,
    lng: group.reduce((sum, p) => sum + p.lng, 0) / group.length,
    points: group,
  }))
}

function PointPopup({ point, ownerName, ownerAvatar }: {
  point: MapPoint
  ownerName?: string | null
  ownerAvatar?: string | null
}) {
  const isJob = point.kind === 'job'
  // Straight to the thing itself: the list page was a dead end.
  const link = isJob
    ? `/dashboard/jobs?jobId=${point.id}`
    : `/dashboard/services/${point.id}`
  return (
    <div className="text-sm min-w-[170px]">
      <div className="flex items-center justify-between gap-2 mb-1">
        <Badge className={isJob ? 'bg-blue-100 dark:bg-blue-950/50 text-blue-800 dark:text-blue-400' : 'bg-green-100 dark:bg-green-950/50 text-green-800 dark:text-green-400'}>
          {isJob ? 'Open Job' : 'Service Provider'}
        </Badge>
        {point.distanceKm != null && (
          <span className="text-[11px] font-medium text-gray-500 dark:text-muted-foreground">{point.distanceKm} km</span>
        )}
      </div>
      <h3 className="font-bold leading-tight">{point.title}</h3>
      {point.description && (
        <p className="line-clamp-2 text-gray-600 dark:text-muted-foreground mt-0.5">{point.description}</p>
      )}
      <p className="font-semibold mt-1">{fmtPrice(point.price)}</p>
      <a
        href={link}
        className={`inline-flex items-center gap-1 mt-2 font-medium hover:underline ${isJob ? 'text-blue-600 dark:text-blue-400' : 'text-green-600 dark:text-green-400'}`}
      >
        {ownerAvatar && <img src={ownerAvatar} className="w-4 h-4 rounded-full object-cover" />}
        {ownerName || `View ${isJob ? 'job' : 'provider'}`} →
      </a>
    </div>
  )
}

/** Renders clustered markers, recomputing as the user pans and zooms. */
function ClusterLayer({
  points,
  owners,
  selectedId,
  onSelect,
  mode = 'pins',
}: {
  points: MapPoint[]
  owners: Map<string, { display_name?: string | null; profile_image_url?: string | null }>
  selectedId?: string | null
  onSelect?: (kind: 'job' | 'service', id: string) => void
  /** 'heat' draws density blobs instead of pins. */
  mode?: 'pins' | 'heat'
}) {
  const map = useMap()
  const [revision, setRevision] = useState(0)

  useMapEvents({
    zoomend: () => setRevision((r) => r + 1),
    moveend: () => setRevision((r) => r + 1),
  })

  const clusters = useMemo(
    () => clusterPoints(map, points),
    // `revision` re-clusters after a pan/zoom; `map` is a stable Leaflet instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [map, points, revision],
  )

  // Pins mode draws every listing as its own tappable profile marker.
  // Clustering used to replace nearby pins with a numbered bubble, which hid the
  // people, made them unclickable for details, and put counts on the map that the
  // header already shows.
  if (mode === 'pins') {
    return (
      <>
        {points.map((point, index) => {
          const owner = point.ownerId ? owners.get(point.ownerId) : undefined
          const highlighted = selectedId === point.id
          return (
            <Marker
              key={`${point.kind}-${point.id}`}
              position={[point.lat, point.lng]}
              icon={makeAvatarIcon(
                owner?.profile_image_url,
                owner?.display_name,
                point.kind === 'job' ? JOB_COLOR : SERVICE_COLOR,
                highlighted,
                point.kind === 'job' ? 'square' : 'round',
                Math.min(index * 60, 600),
              )}
              zIndexOffset={highlighted ? 1000 : 0}
              eventHandlers={{ click: () => onSelect?.(point.kind, point.id) }}
            >
              <Popup>
                <PointPopup
                  point={point}
                  ownerName={owner?.display_name}
                  ownerAvatar={owner?.profile_image_url}
                />
              </Popup>
            </Marker>
          )
        })}
      </>
    )
  }

  return (
    <>
      {clusters.map((cluster) => {
        const first = cluster.points[0]

        if (mode === 'heat') {
          // Density blob: warmer and larger where more listings overlap, which
          // is what makes a heat map readable at a glance.
          const n = cluster.points.length
          const jobsOnly = cluster.points.every((p) => p.kind === 'job')
          const servicesOnly = cluster.points.every((p) => p.kind === 'service')
          const color = jobsOnly ? JOB_COLOR : servicesOnly ? SERVICE_COLOR : MIXED_COLOR
          return (
            <Circle
              key={`heat-${first.id}-${n}`}
              center={[cluster.lat, cluster.lng]}
              radius={Math.min(160 + n * 45, 900)}
              pathOptions={{
                stroke: false,
                fillColor: color,
                fillOpacity: Math.min(0.14 + n * 0.05, 0.5),
              }}
              eventHandlers={{
                click: () =>
                  map.flyTo([cluster.lat, cluster.lng], Math.min(map.getZoom() + 2, 18), {
                    duration: 0.5,
                  }),
              }}
            />
          )
        }

        const owner = first.ownerId ? owners.get(first.ownerId) : undefined
        const highlighted = selectedId === first.id
        return (
          <Marker
            key={`${first.kind}-${first.id}`}
            position={[first.lat, first.lng]}
            icon={makeAvatarIcon(
              owner?.profile_image_url,
              owner?.display_name,
              first.kind === 'job' ? JOB_COLOR : SERVICE_COLOR,
              highlighted,
              first.kind === 'job' ? 'square' : 'round',
            )}
            zIndexOffset={highlighted ? 1000 : 0}
            eventHandlers={{ click: () => onSelect?.(first.kind, first.id) }}
          >
            <Popup>
              <PointPopup
                point={first}
                ownerName={owner?.display_name}
                ownerAvatar={owner?.profile_image_url}
              />
            </Popup>
          </Marker>
        )
      })}
    </>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export function NeighborhoodMap({
  latitude,
  longitude,
  type = 'all',
  radiusKm,
  onRadiusChange,
  height = 500,
  selectedId,
  onSelect,
  onSelectCleared,
  onResults,
  kindFilter = 'all',
  showHeat = false,
  onShowHeatChange,
}: {
  latitude: number
  longitude: number
  type?: 'jobs' | 'services' | 'all'
  /** Controlled radius in km; falls back to internal state when omitted. */
  radiusKm?: number
  onRadiusChange?: (km: number) => void
  height?: number
  /** Controlled selection, so a list beside the map can drive it (and vice versa). */
  selectedId?: string | null
  onSelect?: (kind: 'job' | 'service', id: string) => void
  /** Called when the popup is dismissed, so the parent can drop the selection. */
  onSelectCleared?: () => void
  /** Reports the fetched points so a parent can render a synced result list. */
  onResults?: (points: MapPoint[]) => void
  /** 'all' shows jobs and services together, which is the point of the map. */
  kindFilter?: 'all' | 'job' | 'service'
  /** Draw density blobs instead of pins. */
  showHeat?: boolean
  onShowHeatChange?: (on: boolean) => void
}) {
  const [internalRadius, setInternalRadius] = useState(10)
  // On a phone the map eats every swipe, so the page cannot be scrolled past it.
  // Gestures start off on touch devices and switch on when the user taps in.
  const [mapActive, setMapActive] = useState(false)
  const isTouchDevice =
    typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false)
  const gesturesOn = !isTouchDevice || mapActive
  const [internalSelected, setInternalSelected] = useState<{ kind: 'job' | 'service'; id: string } | null>(null)
  const radius = radiusKm ?? internalRadius

  // Controlled when the parent passes selectedId, uncontrolled otherwise.
  const activeSelectedId = selectedId !== undefined ? selectedId : internalSelected?.id ?? null

  const handleSelect = (kind: 'job' | 'service', id: string) => {
    setInternalSelected({ kind, id })
    onSelect?.(kind, id)
  }

  const validCenter = Number.isFinite(latitude) && Number.isFinite(longitude)

  // Tile config comes from the backend so URLs aren't hardcoded per component.
  const { data: mapConfig } = useQuery<{ tile_light_url: string; attribution: string }>({
    queryKey: ['map-config'],
    queryFn: async () => (await api.get('/location/map-config')).data,
    staleTime: 24 * 60 * 60 * 1000,
  })

  const jobsEnabled = validCenter && (type === 'jobs' || type === 'all')
  const servicesEnabled = validCenter && (type === 'services' || type === 'all')

  const { data: nearbyJobs, isFetching: jobsFetching, isError: jobsFailed } = useQuery<Job[]>({
    // Namespaced deliberately: ServicesPage holds an INFINITE query under
    // ['nearbyServices', lat, lon, radius] whose cached value is {pages, pageParams}.
    // Sharing that key meant this query received an object and the render loop
    // below threw "is not iterable" whenever the map and the list were both mounted.
    queryKey: ['map-nearby-jobs', latitude, longitude],
    queryFn: async () => {
      const { data } = await api.get('/jobs/search/nearby', {
        // Deliberately large rather than 0: 0 means "no limit" only on a backend
        // that accepts ge=0, and against an older one it is rejected outright,
        // which left the map empty. 500 km is the maximum the older validation
        // allows, so the map fills either way; the circle still shows the
        // neighbourhood the user actually picked.
        params: { lat: latitude, lon: longitude, radius: 500, limit: 100 },
      })
      return Array.isArray(data) ? data : []
    },
    enabled: jobsEnabled,
  })

  const { data: nearbyServices, isFetching: servicesFetching, isError: servicesFailed } = useQuery<Service[]>({
    queryKey: ['map-nearby-services', latitude, longitude],
    queryFn: async () => {
      const { data } = await api.get('/services/search/nearby', {
        // Same reasoning as the jobs query: 500 km works against both the old and
        // the new backend, where radius=0 only works once the backend is updated.
        params: { lat: latitude, lon: longitude, radius: 500, limit: 100 },
      })
      return Array.isArray(data) ? data : []
    },
    enabled: servicesEnabled,
  })

  const points: MapPoint[] = useMemo(() => {
    const out: MapPoint[] = []
    for (const job of asArray<Job>(nearbyJobs)) {
      // `== null` not falsy: 0 is a legitimate coordinate.
      if (job.latitude == null || job.longitude == null) continue
      out.push({
        id: job.id,
        kind: 'job',
        lat: Number(job.latitude),
        lng: Number(job.longitude),
        title: job.title,
        description: job.description,
        price: Number(job.price),
        ownerId: job.client_id ?? undefined,
        distanceKm: (job as Job & { distance_km?: number | null }).distance_km ?? null,
      })
    }
    for (const service of asArray<Service>(nearbyServices)) {
      if (service.latitude == null || service.longitude == null) continue
      out.push({
        id: service.id,
        kind: 'service',
        lat: Number(service.latitude),
        lng: Number(service.longitude),
        title: service.title,
        description: service.description,
        price: Number(service.price),
        ownerId: service.provider_id ?? undefined,
        distanceKm: (service as Service & { distance_km?: number | null }).distance_km ?? null,
      })
    }
    return out
  }, [nearbyJobs, nearbyServices])

  // The map fetches both kinds; the chips decide what is drawn.
  const visiblePoints = useMemo(
    () => (kindFilter === 'all' ? points : points.filter((p) => p.kind === kindFilter)),
    [points, kindFilter],
  )

  // Hand the fetched points to the parent so it can render a synced result list.
  // Kept in a ref so an inline callback from the parent can't retrigger the effect.
  const onResultsRef = useRef(onResults)
  onResultsRef.current = onResults
  useEffect(() => {
    onResultsRef.current?.(visiblePoints)
  }, [visiblePoints])

  // One batched, cached lookup per distinct owner instead of a hook per marker.
  const ownerIds = useMemo(
    () => Array.from(new Set(visiblePoints.map((p) => p.ownerId).filter(Boolean))) as string[],
    [visiblePoints],
  )
  const ownerQueries = useQueries({
    queries: ownerIds.map((id) => ({
      queryKey: ['user', id],
      queryFn: async () => (await api.get(`/users/${id}`)).data,
      staleTime: 5 * 60 * 1000,
    })),
  })
  const owners = useMemo(() => {
    const map = new Map<string, { display_name?: string | null; profile_image_url?: string | null }>()
    ownerIds.forEach((id, index) => {
      const data = ownerQueries[index]?.data
      if (data) map.set(id, data as { display_name?: string | null; profile_image_url?: string | null })
    })
    return map
  }, [ownerIds, ownerQueries])

  const selectedPoint = useMemo(
    () => (activeSelectedId ? visiblePoints.find((p) => p.id === activeSelectedId) ?? null : null),
    [activeSelectedId, visiblePoints],
  )

  if (!validCenter) {
    return (
      <div
        className="w-full rounded-xl border border-dashed border-gray-300 dark:border-border bg-gray-50 dark:bg-card flex flex-col items-center justify-center gap-2 text-center px-6"
        style={{ height }}
      >
        <Layers className="w-8 h-8 text-gray-400" />
        <p className="text-sm font-medium text-gray-600 dark:text-muted-foreground">Location needed</p>
        <p className="text-xs text-gray-500 dark:text-muted-foreground max-w-xs">
          Turn on location access to see jobs and providers around you on the map.
        </p>
      </div>
    )
  }

  const loading = jobsFetching || servicesFetching
  // Only meaningful for the kinds this map is actually showing.
  const loadFailed =
    (jobsEnabled && jobsFailed) || (servicesEnabled && servicesFailed)
  const jobCount = points.filter((p) => p.kind === 'job').length
  const serviceCount = points.filter((p) => p.kind === 'service').length
  const accentColor = jobCount > 0 ? JOB_COLOR : SERVICE_COLOR

  return (
    <div
      className="w-full rounded-xl overflow-hidden border border-gray-200 dark:border-border shadow-sm relative isolate"
      style={{ height }}
    >
      <MapContainer
        center={[latitude, longitude]}
        zoom={13}
        scrollWheelZoom={false}
        dragging={gesturesOn}
        touchZoom={gesturesOn}
        doubleClickZoom={gesturesOn}
        className="h-full w-full"
      >
        <TileLayer
          attribution={mapConfig?.attribution ?? OSM_ATTRIBUTION}
          url={mapConfig?.tile_light_url ?? OSM_FALLBACK_TILE}
        />
        <MapUpdater
          center={[latitude, longitude]}
          focus={selectedPoint ? [selectedPoint.lat, selectedPoint.lng] : null}
        />

        {/* Search radius, drawn to scale so "nearby" is visible, not implied —
            and gently animated so the covered area reads as live. */}
        {radius > 0 && (
          <Circle
            center={[latitude, longitude]}
            radius={radius * 1000}
            pathOptions={{
              color: JOB_COLOR,
              weight: 1.5,
              opacity: 0.7,
              fillColor: JOB_COLOR,
              fillOpacity: 0.06,
              className: 'gigr-radius-circle',
            }}
          />
        )}

        <Marker position={[latitude, longitude]} icon={userLocationIcon} zIndexOffset={2000}>
          <Popup>You are here</Popup>
        </Marker>

        <SelectionWatcher onClear={onSelectCleared} />

        <ClusterLayer
          points={visiblePoints}
          mode={showHeat ? 'heat' : 'pins'}
          owners={owners}
          selectedId={activeSelectedId}
          onSelect={handleSelect}
        />
      </MapContainer>

      {isTouchDevice && !mapActive && (
        <button
          type="button"
          onClick={() => setMapActive(true)}
          className="absolute inset-0 z-[640] flex items-end justify-center pb-24"
          aria-label="Tap to explore the map"
        >
          <span className="rounded-full bg-black/80 text-white text-xs font-semibold px-4 py-2 shadow-lg">
            Tap to explore the map
          </span>
        </button>
      )}

      {/* Controls overlay */}
      <div
        className={`absolute top-3 left-3 z-[650] flex flex-col gap-1.5 max-w-[calc(100%-1.5rem)] transition-opacity duration-200 ${
          activeSelectedId ? 'opacity-0 pointer-events-none' : 'opacity-100'
        }`}
      >
        <div className="bg-white/95 dark:bg-card/95 backdrop-blur rounded-xl shadow-lg border border-gray-200 dark:border-border px-3 py-2">
          <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-muted-foreground mb-1.5">
            <Navigation className="w-3 h-3" /> Radius
          </div>
          <div className="flex gap-1">
            {RADIUS_CHOICES.map((km) => {
              const active = km === radius
              return (
                <button
                  key={km}
                  onClick={() => {
                    setInternalRadius(km)
                    onRadiusChange?.(km)
                  }}
                  className={`px-2 py-1 rounded-lg text-xs font-semibold transition-colors ${
                    active
                      ? 'bg-blue-600 text-white shadow'
                      : 'bg-gray-100 dark:bg-muted text-gray-600 dark:text-muted-foreground hover:bg-gray-200 dark:hover:bg-secondary'
                  }`}
                >
                  {km === 0 ? 'All' : km < 1 ? `${Math.round(km * 1000)}m` : `${km}km`}
                </button>
              )
            })}
          </div>
        </div>

        <div className="bg-white/95 dark:bg-card/95 backdrop-blur rounded-xl shadow-lg border border-gray-200 dark:border-border px-3 py-2 text-xs">
          <div className="flex items-center gap-3 text-gray-500 dark:text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span
                className={showHeat ? 'w-2.5 h-2.5 rounded-full' : 'w-2.5 h-2.5 rounded-[3px]'}
                style={{ background: accentColor }}
              />
              {jobCount + serviceCount} on the map
            </span>
            {loading && <span className="text-gray-400">updating…</span>}
            <button
              type="button"
              onClick={() => onShowHeatChange?.(!showHeat)}
              aria-pressed={showHeat}
              title="Density view"
              className={`ml-auto px-2 py-0.5 rounded-lg font-semibold transition-colors ${
                showHeat
                  ? 'bg-amber-500 text-white'
                  : 'text-gray-500 dark:text-muted-foreground hover:bg-gray-100 dark:hover:bg-muted'
              }`}
            >
              Heat
            </button>
          </div>
          {!loading && visiblePoints.length === 0 && (
            <p className="mt-1.5 text-gray-500 dark:text-muted-foreground flex items-center gap-1">
              <Flame className="w-3 h-3 text-amber-500" />
              {loadFailed
                ? 'Could not load listings for the map. Pull to refresh, or try again shortly.'
                : 'No listings with a location yet.'}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
