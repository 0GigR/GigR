import { useCallback, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import api from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { useUnreadStore } from '@/store/unreadStore'
import { useWebSocketMessages } from '@/hooks/useWebSocketMessages'
import type { components } from '@/types/api'

type Job = components['schemas']['JobOut']
type Message = components['schemas']['MessageOut']

/**
 * Global, app-wide message notifier. Mounted once in the dashboard layout so that
 * new messages produce a notification light + toast popup on ANY page — not only
 * while the Messages page is open. When the Messages page is mounted it owns unread
 * tracking, so this hook defers to it to avoid double-counting / duplicate toasts.
 */
export function useMessageNotifications() {
  const { user } = useAuthStore()
  const navigate = useNavigate()

  // All jobs the user has a conversation in — the rooms we listen on.
  const { data: jobs } = useQuery<Job[]>({
    queryKey: ['myJobsForMessages'],
    queryFn: async () => {
      const { data } = await api.get('/jobs/my-conversations')
      return data
    },
    enabled: !!user?.id,
  })

  const jobIds = useMemo(
    () => (jobs || [])
      .filter((j) => !['completed', 'cancelled'].includes(j.status))
      .map((j) => j.id),
    [jobs]
  )

  const handleNewMessage = useCallback((msg: Message) => {
    const store = useUnreadStore.getState()
    // Ignore our own messages and let the Messages page handle things when it's open.
    if (msg.sender_id === user?.id) return
    if (store.messagesPageActive) return

    store.bumpUnread()
    toast.message('New message', {
      description: msg.content?.slice(0, 80) || 'You have a new message',
      action: { label: 'Open', onClick: () => navigate('/dashboard/messages') },
    })
  }, [user?.id, navigate])

  useWebSocketMessages({
    jobIds,
    onNewMessage: handleNewMessage,
    enabled: jobIds.length > 0,
  })
}
