import { useState, useEffect, useCallback } from 'react'

interface GeolocationState {
  latitude: number | null
  longitude: number | null
  accuracy: number | null
  error: string | null
  loading: boolean
}

export function useGeolocation() {
  const [state, setState] = useState<GeolocationState>({
    latitude: null,
    longitude: null,
    accuracy: null,
    error: null,
    loading: true,
  })

  const getPosition = useCallback(() => {
    if (!navigator.geolocation) {
      setState({ latitude: null, longitude: null, accuracy: null, error: 'Geolocation not supported', loading: false })
      return
    }
    setState((s) => ({ ...s, loading: true, error: null }))

    const onSuccess = (position: GeolocationPosition) => {
      setState({
        latitude: position.coords.latitude,
        longitude: position.coords.longitude,
        accuracy: position.coords.accuracy,
        error: null,
        loading: false,
      })
    }

    // iOS Safari: high-accuracy can fail silently or timeout.
    // Try high-accuracy first; on any error fall back to low-accuracy.
    const onError = (err: GeolocationPositionError) => {
      if (err.code === err.TIMEOUT || err.code === err.POSITION_UNAVAILABLE) {
        // Fallback: low accuracy, longer timeout — works better on iOS
        navigator.geolocation.getCurrentPosition(
          onSuccess,
          (err2) => {
            setState({
              latitude: null,
              longitude: null,
              accuracy: null,
              error: err2.code === err2.PERMISSION_DENIED
                ? 'Location permission denied. Please enable it in your browser/device settings.'
                : err2.message,
              loading: false,
            })
          },
          { enableHighAccuracy: false, timeout: 20000, maximumAge: 300000 }
        )
      } else {
        setState({
          latitude: null,
          longitude: null,
          accuracy: null,
          error: err.code === err.PERMISSION_DENIED
            ? 'Location permission denied. Please enable it in your browser/device settings.'
            : err.message,
          loading: false,
        })
      }
    }

    navigator.geolocation.getCurrentPosition(
      onSuccess,
      onError,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 }
    )
  }, [])

  useEffect(() => {
    getPosition()
  }, [getPosition])

  return { ...state, refresh: getPosition }
}