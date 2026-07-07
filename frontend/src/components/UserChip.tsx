import { Link } from 'react-router-dom'
import OnlineIndicator from '@/components/OnlineIndicator'

interface UserChipProps {
  userId: string
  name?: string | null
  avatarUrl?: string | null
  lastSeenAt?: string | null
  size?: 'sm' | 'md'
  className?: string
}

export default function UserChip({
  userId,
  name,
  avatarUrl,
  lastSeenAt,
  size = 'sm',
  className = '',
}: UserChipProps) {
  const initials = name ? name.slice(0, 2).toUpperCase() : '?'
  const avatarSize = size === 'sm' ? 'w-6 h-6 text-[10px]' : 'w-8 h-8 text-xs'

  return (
    <Link
      to={`/dashboard/user/${userId}`}
      className={`inline-flex items-center gap-1.5 hover:opacity-80 transition-opacity ${className}`}
      onClick={(e) => e.stopPropagation()}
    >
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={name ?? 'User'}
          className={`${avatarSize} rounded-full object-cover shrink-0`}
        />
      ) : (
        <span className={`${avatarSize} rounded-full bg-gray-200 flex items-center justify-center font-medium text-gray-600 shrink-0`}>
          {initials}
        </span>
      )}
      {name && (
        <span className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate max-w-[120px]">
          {name}
        </span>
      )}
      <OnlineIndicator lastSeenAt={lastSeenAt} />
    </Link>
  )
}
