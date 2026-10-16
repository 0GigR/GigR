import { useCallback, useEffect, useRef, useState, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Briefcase, Wrench, MapPin, Sparkles } from 'lucide-react'
import { fmtPrice } from '@/store/currencyStore'
import { NeighborhoodMap, type MapPoint } from '@/components/NeighborhoodMap'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { useAgentMapSync } from '@/hooks/useAgentMapSync'
import { useAgentStore } from '@/store/agentStore'

/**
 * The neighbourhood map plus its result list, sharing one selection.
 *
 * Previously the map tab was a dead-end picture: you could read pins but not act
 * on them, and nothing connected the map to the listings. Now clicking a card
 * flies the map to that pin and highlights it, and clicking a pin highlights and
 * scrolls its card into view.
 *
 * New in this version:
 *  - Radar sweep conic-gradient overlay while the agent is scanning.
 *  - Crosshair centre reticle rendered on top of the map during the sweep.
 *  - Target reticle HUD panel that opens when a pin or list item is selected.
 *  - [REQUEST] and [AUTO-NEGOTIATE] quick-action buttons in the reticle panel.
 */
export function MapExplorer({
  latitude,
  longitude,
  type = 'all',
  radiusKm,
  onRadiusChange,
  height = 520,
}: {
  latitude: number
  longitude: number
  type?: 'jobs' | 'services' | 'all'
  radiusKm?: number
  onRadiusChange?: (km: number) => void
  height?: number
}) {
  const [points, setPoints] = useState<MapPoint[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  // Jobs and services have separate maps on purpose: the jobs map shows jobs,
  // the services map shows services. Mixing them made both harder to read.
  const [showHeat, setShowHeat] = useState(false)
  const [reticlePoint, setReticlePoint] = useState<MapPoint | null>(null)
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const { isAgentSearching, activeSearchQuery, agentMarkers, hasAgentResults, clearAgentPins } =
    useAgentMapSync()

  const handleResults = useCallback((next: MapPoint[]) => setPoints(next), [])

  // Map -> list: when a pin is chosen on the map, bring its card into view.
  useEffect(() => {
    if (!selectedId) return
    itemRefs.current[selectedId]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  // Merge agent pins if available
  const combinedPoints = useMemo<MapPoint[]>(() => {
    if (!hasAgentResults) return points
    const agentMapPoints: MapPoint[] = agentMarkers.map((m) => ({
      id: m.id,
      kind: m.kind,
      lat: m.latitude,
      lng: m.longitude,
      title: m.title,
      price: m.price,
      distanceKm: m.distanceKm ?? undefined,
    }))
    const existingIds = new Set(agentMapPoints.map((p) => p.id))
    const remainder = points.filter((p) => !existingIds.has(p.id))
    return [...agentMapPoints, ...remainder]
  }, [points, agentMarkers, hasAgentResults])

  const sorted = [...combinedPoints].sort((a, b) => {
    const da = a.distanceKm ?? Number.POSITIVE_INFINITY
    const db = b.distanceKm ?? Number.POSITIVE_INFINITY
    return da - db
  })

  return (
    <div className="space-y-3">
      {/* Agent Live Search & Overlay Banners */}
      {isAgentSearching && (
        <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-gray-200 text-xs animate-pulse">
          <span className="w-2 h-2 rounded-full bg-white animate-ping shrink-0" />
          <span className="font-semibold">[AGENT ACTIVE]</span>
          <span className="truncate">Scanning providers for &quot;{activeSearchQuery}&quot;</span>
        </div>
      )}
      {hasAgentResults && (
        <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-gray-900 border border-gray-700 text-gray-100 text-xs">
          <div className="flex items-center gap-2">
            <Sparkles className="w-3.5 h-3.5 text-gray-300" />
            <span className="font-semibold text-white">[AGENT OVERLAY]</span>
            <span>{agentMarkers.length} match(es) from your recent agent search</span>
          </div>
          <button
            onClick={clearAgentPins}
            className="text-xs text-gray-400 hover:text-white underline ml-2 cursor-pointer"
          >
            Clear Overlay
          </button>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-2">
      <ErrorBoundary compact label="The map" resetKey={`${latitude},${longitude}`}>
        {/* Relative wrapper so the radar overlay sits precisely on top of the map */}
        <div className="relative">
          <NeighborhoodMap
            latitude={latitude}
            longitude={longitude}
            type={type}
            radiusKm={radiusKm}
            onRadiusChange={onRadiusChange}
            height={height}
            selectedId={selectedId}
            onSelect={(_kind, id) => {
              setSelectedId(id)
              const match = combinedPoints.find((p) => p.id === id) ?? null
              setReticlePoint(match)
            }}
            onSelectCleared={() => setSelectedId(null)}
            onResults={handleResults}
            showHeat={showHeat}
            onShowHeatChange={setShowHeat}
          />

          {/* Radar sweep overlay — only rendered while the agent is scanning */}
          {isAgentSearching && (
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl"
            >
              {/* Rotating conic-gradient sweep beam */}
              <div
                className="absolute inset-0 animate-rotate-beam"
                style={{
                  background:
                    'conic-gradient(from 0deg, transparent 0deg, rgba(255, 255, 255, 0.12) 30deg, transparent 60deg)',
                  transformOrigin: 'center center',
                }}
              />
              {/* Crosshair centre reticle */}
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <div className="relative w-12 h-12">
                  <div className="absolute inset-0 rounded-full border border-white/30" />
                  <div className="absolute inset-3 rounded-full border border-white/50" />
                  <div className="absolute top-1/2 left-0 right-0 h-px bg-white/30 -translate-y-1/2" />
                  <div className="absolute left-1/2 top-0 bottom-0 w-px bg-white/30 -translate-x-1/2" />
                </div>
              </div>
            </div>
          )}
        </div>
      </ErrorBoundary>

      {/* Target reticle HUD panel — shows when a pin or list item is active */}
      {reticlePoint && (
        <div className="p-3 rounded-xl bg-gray-950/95 border border-gray-800 text-xs space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-white truncate max-w-[70%]">
              {reticlePoint.title}
            </span>
            <button
              type="button"
              onClick={() => setReticlePoint(null)}
              className="text-gray-500 hover:text-gray-300 text-[10px] font-mono"
              aria-label="Dismiss reticle"
            >
              [X]
            </button>
          </div>
          {reticlePoint.distanceKm !== undefined && reticlePoint.distanceKm !== null && (
            <p className="text-gray-400">
              Distance:{' '}
              <span className="text-white font-mono">
                {reticlePoint.distanceKm.toFixed(2)} km
              </span>
            </p>
          )}
          {reticlePoint.price !== undefined && (
            <p className="text-gray-400">
              Price:{' '}
              <span className="text-gray-200 font-semibold">
                {fmtPrice(reticlePoint.price)}
              </span>
            </p>
          )}
          <div className="flex gap-2 pt-1">
            <button
              type="button"
              onClick={() => {
                const { submitCommand } = useAgentStore.getState()
                submitCommand(`Request ${reticlePoint.title}`)
                setReticlePoint(null)
              }}
              className="flex-1 py-1 px-2 rounded-lg bg-white hover:bg-gray-200 text-black text-[11px] font-mono font-medium transition-colors"
            >
              [REQUEST]
            </button>
            <button
              type="button"
              onClick={() => {
                const { submitCommand } = useAgentStore.getState()
                submitCommand(
                  `Negotiate the best price for ${reticlePoint.title} at ID ${reticlePoint.id}`,
                )
                setReticlePoint(null)
              }}
              className="flex-1 py-1 px-2 rounded-lg bg-gray-800 hover:bg-gray-700 text-white border border-gray-700 text-[11px] font-mono transition-colors"
            >
              [AUTO-NEGOTIATE]
            </button>
          </div>
        </div>
      )}
      </div>

      <div
        className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 overflow-y-auto"
        style={{ maxHeight: height }}
      >
        <div className="px-4 py-3 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between sticky top-0 bg-white/95 dark:bg-gray-900/95 backdrop-blur">
          <span className="text-sm font-semibold text-gray-800 dark:text-gray-100">
            Nearby
          </span>
          <span className="text-xs text-gray-500">
            {sorted.length} {sorted.length === 1 ? 'result' : 'results'}
          </span>
        </div>

        {sorted.length === 0 ? (
          <div className="p-6 text-center text-sm text-gray-500">
            <MapPin className="w-6 h-6 mx-auto mb-2 text-gray-300" />
            Nothing in this area yet. Try a wider radius.
          </div>
        ) : (
          <ul className="divide-y divide-gray-100 dark:divide-gray-800">
            {sorted.map((point) => {
              const isJob = point.kind === 'job'
              const active = point.id === selectedId
              return (
                <li key={`${point.kind}-${point.id}`}>
                  <button
                    type="button"
                    ref={(el) => {
                      itemRefs.current[point.id] = el
                    }}
                    onClick={() => {
                      setSelectedId(point.id)
                      setReticlePoint(point)
                    }}
                    className={`w-full text-left px-4 py-3 transition-colors ${
                      active
                        ? 'bg-blue-50 dark:bg-blue-950/40'
                        : 'hover:bg-gray-50 dark:hover:bg-gray-800/60'
                    }`}
                  >
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded ${
                          isJob
                            ? 'bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300'
                            : 'bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300'
                        }`}
                      >
                        {isJob ? <Briefcase className="w-3 h-3" /> : <Wrench className="w-3 h-3" />}
                        {isJob ? 'Job' : 'Service'}
                      </span>
                      {point.distanceKm != null && (
                        <span className="text-[11px] text-gray-500">{point.distanceKm} km</span>
                      )}
                    </div>
                    <p className="mt-1 text-sm font-medium text-gray-900 dark:text-gray-100 line-clamp-1">
                      {point.title}
                    </p>
                    {point.description && (
                      <p className="text-xs text-gray-500 line-clamp-2 mt-0.5">
                        {point.description}
                      </p>
                    )}
                    <div className="mt-1 flex items-center justify-between">
                      <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                        {fmtPrice(point.price)}
                      </span>
                      <Link
                        to={isJob ? `/dashboard/jobs?jobId=${point.id}` : `/dashboard/services/${point.id}`}
                        className={`text-xs font-medium hover:underline ${
                          isJob ? 'text-blue-600' : 'text-green-600'
                        }`}
                      >
                        View
                      </Link>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  </div>
)
}
