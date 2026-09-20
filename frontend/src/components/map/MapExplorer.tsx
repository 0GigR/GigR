import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Briefcase, Wrench, MapPin } from 'lucide-react'
import { fmtPrice } from '@/store/currencyStore'
import { NeighborhoodMap, type MapPoint } from '@/components/NeighborhoodMap'
import { ErrorBoundary } from '@/components/ErrorBoundary'

/**
 * The neighbourhood map plus its result list, sharing one selection.
 *
 * Previously the map tab was a dead-end picture: you could read pins but not act
 * on them, and nothing connected the map to the listings. Now clicking a card
 * flies the map to that pin and highlights it, and clicking a pin highlights and
 * scrolls its card into view.
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
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({})

  const handleResults = useCallback((next: MapPoint[]) => setPoints(next), [])

  // Map → list: when a pin is chosen on the map, bring its card into view.
  useEffect(() => {
    if (!selectedId) return
    itemRefs.current[selectedId]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedId])

  const sorted = [...points].sort((a, b) => {
    const da = a.distanceKm ?? Number.POSITIVE_INFINITY
    const db = b.distanceKm ?? Number.POSITIVE_INFINITY
    return da - db
  })

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      <ErrorBoundary compact label="The map" resetKey={`${latitude},${longitude}`}>
        <NeighborhoodMap
          latitude={latitude}
        longitude={longitude}
        type={type}
        radiusKm={radiusKm}
        onRadiusChange={onRadiusChange}
        height={height}
        selectedId={selectedId}
        onSelect={(_kind, id) => setSelectedId(id)}
        onSelectCleared={() => setSelectedId(null)}
          onResults={handleResults}
          showHeat={showHeat}
          onShowHeatChange={setShowHeat}
        />
      </ErrorBoundary>

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
                    onClick={() => setSelectedId(point.id)}
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
                        View →
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
  )
}
