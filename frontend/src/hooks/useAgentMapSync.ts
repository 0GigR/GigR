/**
 * useAgentMapSync.ts — React hook synchronizing background agent activity with the map.
 *
 * Observes agent tasks from the store to detect when the agent is running geo searches,
 * extracts spatial results (services/jobs with coordinates) from task logs, and provides
 * reactive markers and searching indicators to map components (MapExplorer, NeighborhoodMap).
 *
 * House Standard Compliance:
 * - Zero emojis
 * - No banned variable names
 */

import { useState, useMemo, useCallback } from 'react'
import { useAgentStore, AgentTask } from '@/store/agentStore'
import { isFeatureEnabled } from '@/lib/featureFlags'

export interface AgentMapPinItem {
  id: string
  title: string
  price: number
  latitude: number
  longitude: number
  kind: 'service' | 'job'
  distanceKm?: number | null
}

export function useAgentMapSync() {
  const tasks = useAgentStore((state) => state.tasks)
  const isMapFeatureActive = isFeatureEnabled('mapResults')
  const [clearedTaskIds, setClearedTaskIds] = useState<Set<string>>(new Set())

  // Check if any geo-search task is actively executing
  const activeSearchTask = useMemo<AgentTask | null>(() => {
    return (
      tasks.find(
        (t) =>
          (t.status === 'running' || t.status === 'queued') &&
          ['find_service', 'find_job', 'negotiate', 'proactive_hunt'].includes(t.task_type)
      ) || null
    )
  }, [tasks])

  const isAgentSearching = Boolean(activeSearchTask) && isMapFeatureActive
  const activeSearchQuery = activeSearchTask?.command_text || ''

  // Collect markers from the most recent completed search task
  const agentMarkers = useMemo<AgentMapPinItem[]>(() => {
    if (!isMapFeatureActive) return []

    // Look for the most recent completed task that yielded service or job cards with coordinates
    for (const task of tasks) {
      if (clearedTaskIds.has(task.id)) continue

      // Check task logs for render_type: service_cards
      for (const logItem of task.logs || []) {
        const payloadData = logItem.data as Record<string, unknown> | null | undefined
        if (payloadData && payloadData.render_type === 'service_cards') {
          const rawServices = payloadData.services as Array<Record<string, unknown>> | undefined
          if (Array.isArray(rawServices)) {
            const mappedPins: AgentMapPinItem[] = []
            for (const s of rawServices) {
              const lat = Number(s.latitude)
              const lng = Number(s.longitude)
              if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
                mappedPins.push({
                  id: String(s.id),
                  title: String(s.title || 'Service Provider'),
                  price: Number(s.price || 0),
                  latitude: lat,
                  longitude: lng,
                  kind: 'service',
                  distanceKm: typeof s.distance_km === 'number' ? s.distance_km : null,
                })
              }
            }
            if (mappedPins.length > 0) {
              return mappedPins
            }
          }
        }
      }

      // Check task result for services with geo
      if (task.result && Array.isArray((task.result as Record<string, unknown>).services)) {
        const rawServices = (task.result as Record<string, unknown>).services as Array<
          Record<string, unknown>
        >
        const mappedPins: AgentMapPinItem[] = []
        for (const s of rawServices) {
          const lat = Number(s.latitude)
          const lng = Number(s.longitude)
          if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
            mappedPins.push({
              id: String(s.id),
              title: String(s.title || 'Service Provider'),
              price: Number(s.price || 0),
              latitude: lat,
              longitude: lng,
              kind: 'service',
            })
          }
        }
        if (mappedPins.length > 0) {
          return mappedPins
        }
      }
    }

    return []
  }, [tasks, clearedTaskIds, isMapFeatureActive])

  const clearAgentPins = useCallback(() => {
    const allTaskIds = new Set(tasks.map((t) => t.id))
    setClearedTaskIds(allTaskIds)
  }, [tasks])

  return {
    isAgentSearching,
    activeSearchQuery,
    agentMarkers,
    hasAgentResults: agentMarkers.length > 0,
    clearAgentPins,
  }
}
