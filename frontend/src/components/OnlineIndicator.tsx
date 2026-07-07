import { formatDistanceToNow } from 'date-fns'

interface OnlineIndicatorProps {
  lastSeenAt?: string | null
  showLabel?: boolean
  className?: string
}

function isOnline(lastSeenAt?: string | null): boolean {
  if (!lastSeenAt) return false
  return Date.now() - new Date(lastSeenAt).getTime() < 5 * 60 * 1000
}

export default function OnlineIndicator({ lastSeenAt, showLabel = false, className = '' }: OnlineIndicatorProps) {
  const online = isOnline(lastSeenAt)

  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <span
        className={`w-2 h-2 rounded-full shrink-0 ${online ? 'bg-green-500' : 'bg-gray-300'}`}
        title={online ? 'Online' : lastSeenAt ? `Last seen ${formatDistanceToNow(new Date(lastSeenAt), { addSuffix: true })}` : 'Offline'}
      />
      {showLabel && (
        <span className="text-xs text-gray-500">
          {online ? 'Online' : lastSeenAt ? `Last seen ${formatDistanceToNow(new Date(lastSeenAt), { addSuffix: true })}` : 'Offline'}
        </span>
      )}
    </span>
  )
}
