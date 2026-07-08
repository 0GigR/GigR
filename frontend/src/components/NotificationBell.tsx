import { useState } from 'react'
import { Bell } from 'lucide-react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import api from '@/lib/api'
import { Link } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { subscribeToPushNotifications } from '@/lib/push'

import { formatDistanceToNow } from 'date-fns'

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
          <div className="fixed inset-0 bg-black/40 z-[9998]" onClick={() => setOpen(false)} />
          <div className="fixed top-0 right-0 h-full w-full max-w-sm bg-white dark:bg-gray-950 border-l border-gray-200 dark:border-gray-800 shadow-2xl z-[9999] flex flex-col animate-in slide-in-from-right duration-300">
            <div className="flex justify-between items-center p-4 border-b border-gray-100 dark:border-gray-800 shrink-0">
              <h3 className="font-semibold text-lg">Notifications</h3>
              <div className="flex items-center gap-3">
                {unreadCount > 0 && (
                  <button
                    className="text-xs text-blue-600 hover:underline font-medium"
                    onClick={() => markAllReadMutation.mutate()}
                    disabled={markAllReadMutation.isPending}
                  >
                    Mark all read
                  </button>
                )}
                <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => setOpen(false)}>
                  ✕
                </Button>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto">
              {notifications.length === 0 ? (
                <div className="p-8 text-center text-sm text-gray-500 flex flex-col items-center justify-center h-full">
                  <Bell className="w-12 h-12 text-gray-200 dark:text-gray-800 mb-3" />
                  <p>No notifications yet.</p>
                </div>
              ) : (
                <div className="flex flex-col divide-y divide-gray-50 dark:divide-gray-800/50">
                  {notifications.map(n => (
                    <div
                      key={n.id}
                      className={`p-4 text-sm transition-colors hover:bg-gray-50 dark:hover:bg-gray-900/50 ${
                        n.is_read ? 'bg-transparent opacity-80' : 'bg-blue-50/50 dark:bg-blue-900/10'
                      }`}
                    >
                      <Link
                        to={n.link || '#'}
                        onClick={() => setOpen(false)}
                        className="block"
                      >
                        <p className="font-semibold mb-1 flex items-center gap-2">
                          {n.title}
                          {!n.is_read && <span className="w-2 h-2 rounded-full bg-blue-600" />}
                        </p>
                        <p className="text-gray-600 dark:text-gray-300 text-sm leading-relaxed">
                          {n.message}
                        </p>
                        <p className="text-xs text-gray-400 mt-2 font-medium">
                          {formatDistanceToNow(new Date(n.created_at), { addSuffix: true })}
                        </p>
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </div>
            
            {/* Push notification banner */}
            <div className="p-4 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50 text-center shrink-0">
              <button onClick={handleSubscribe} className="text-sm text-blue-600 hover:underline font-medium">
                Enable Push Notifications
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
