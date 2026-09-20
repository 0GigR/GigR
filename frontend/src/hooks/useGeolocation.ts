import { useEffect } from 'react'
import { useLocationStore } from '@/store/locationStore'

/**
 * Reads the shared device location.
 *
 * The signature is unchanged, but this no longer talks to the browser itself:
 * mounting it anywhere simply requests a fix from `locationStore`, which
 * de-duplicates concurrent requests, caches a recent position, and owns the
 * single server sync. Five components used to mount this hook independently and
 * each fire their own `getCurrentPosition`.
 */
export function useGeolocation() {
  const latitude = useLocationStore((s) => s.latitude)
  const longitude = useLocationStore((s) => s.longitude)
  const accuracy = useLocationStore((s) => s.accuracy)
  const error = useLocationStore((s) => s.error)
  const loading = useLocationStore((s) => s.loading)
  const request = useLocationStore((s) => s.request)
  const refresh = useLocationStore((s) => s.refresh)

  useEffect(() => {
    request()
  }, [request])

  return { latitude, longitude, accuracy, error, loading, refresh }
}
