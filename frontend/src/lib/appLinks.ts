// Only navigate to in-app paths. Notification and announcement links come from
// the backend or an admin, and a malformed one (e.g. a deep link to a route
// that doesn't exist, like /dashboard/jobs/<id> instead of /dashboard/jobs)
// would otherwise strand the user on the 404 page.
const KNOWN_PREFIXES = ['/dashboard', '/profile/']

export function safeAppLink(link?: string | null): string {
  if (!link || !link.startsWith('/')) return '/dashboard'
  if (link.startsWith('//')) return '/dashboard' // protocol-relative URL
  return KNOWN_PREFIXES.some((p) => link.startsWith(p)) ? link : '/dashboard'
}
