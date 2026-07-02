import { useState } from 'react'
import { Bell } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import api from '@/lib/api'
import { Link } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { subscribeToPushNotifications } from '@/lib/push'

export interface Notification {
  id: string
  title: string
  message: string
  link?: string
  is_read: boolean
  created_at: string
}

export default function NotificationBell() {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const { user } = useAuthStore()

  // Polling notifications every 15s
  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: ['notifications'],
    queryFn: async () => {
      const { data } = await api.get('/notifications/')
      return data
    },
    refetchInterval: 15000,
    enabled: !!user,
  })

  const markAllReadMutation = useMutation({
    mutationFn: async () => {
      await api.post('/notifications/read-all')
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] })
      setOpen(false)
    },
  })

  const handleSubscribe = async () => {
    const success = await subscribeToPushNotifications()
    if (success) {
      alert('Successfully enabled push notifications!')
    } else {
      alert('Failed or denied. Check browser settings.')
    }
  }

  const unreadCount = notifications.filter(n => !n.is_read).length

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(!open)}
        className="relative"
        title="Notifications"
      >
        <Bell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center px-1">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-2 w-80 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-xl shadow-xl z-50 overflow-hidden">
            <div className="flex justify-between items-center p-3 border-b border-gray-100 dark:border-gray-800">
              <h3 className="font-semibold">Notifications</h3>
              {unreadCount > 0 && (
                <button
                  className="text-xs text-blue-600 hover:underline"
                  onClick={() => markAllReadMutation.mutate()}
                  disabled={markAllReadMutation.isPending}
                >
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="p-8 text-center text-sm text-gray-500">
                  No notifications yet.
                </div>
              ) : (
                <div className="flex flex-col divide-y divide-gray-50 dark:divide-gray-800/50">
                  {notifications.map(n => (
                    <div
                      key={n.id}
                      className={`p-3 text-sm transition-colors ${
                        n.is_read ? 'bg-transparent opacity-75' : 'bg-blue-50/50 dark:bg-blue-900/10'
                      }`}
                    >
                      <Link
                        to={n.link || '#'}
                        onClick={() => setOpen(false)}
                        className="block"
                      >
                        <p className="font-semibold mb-0.5 flex items-center gap-2">
                          {n.title}
                          {!n.is_read && <span className="w-2 h-2 rounded-full bg-blue-600" />}
                        </p>
                        <p className="text-gray-600 dark:text-gray-300 text-xs line-clamp-2">
                          {n.message}
                        </p>
                        <p className="text-[10px] text-gray-400 mt-1">
                          {new Date(n.created_at).toLocaleString()}
                        </p>
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </div>
            {/* Push notification banner */}
            <div className="p-2 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 text-center">
              <button onClick={handleSubscribe} className="text-xs text-blue-600 hover:underline font-medium">
                Enable Push Notifications
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
