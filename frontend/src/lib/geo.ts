/**
 * Straight-line distance on the client — one implementation.
 *
 * This maths was copy-pasted into JobsPage, PublicProfilePage and
 * ServiceDetailPage. The geo endpoints now return a server-computed
 * `distance_km` wherever they can, so this is only for the cases where two
 * arbitrary points are already in hand (e.g. a public profile's distance from
 * the viewer).
 *
 * Returns `null` when any coordinate is missing, so callers can distinguish
 * "unknown" from "zero km away". Note the explicit `== null` checks: a
 * coordinate of 0 is a real place (the equator / prime meridian).
 */
export function haversineKm(
  lat1: number | null | undefined,
  lon1: number | null | undefined,
  lat2: number | null | undefined,
  lon2: number | null | undefined,
): number | null {
  if (lat1 == null || lon1 == null || lat2 == null || lon2 == null) return null

  const earthRadiusKm = 6371.0088
  const dLat = ((lat2 - lat1) * Math.PI) / 180
  const dLon = ((lon2 - lon1) * Math.PI) / 180
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
