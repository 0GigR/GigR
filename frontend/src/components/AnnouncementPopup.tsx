import { useEffect, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X, Megaphone, ExternalLink } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import api from '@/lib/api'
import { Button } from '@/components/ui/button'
import { useAuthStore } from '@/store/authStore'
import { Link } from 'react-router-dom'
import { safeAppLink } from '@/lib/appLinks'

interface Announcement {
  id: string
  title: string
  message: string
  image_url?: string | null
  link?: string | null
  created_at?: string | null
}

const SEEN_KEY = 'gigr_announcement_seen'
const POLL_MS = 60_000

function getSeen(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function markSeen(id: string) {
  try {
    const seen = getSeen()
    if (!seen.includes(id)) {
      seen.push(id)
      localStorage.setItem(SEEN_KEY, JSON.stringify(seen.slice(-50)))
    }
  } catch {
    /* ignore */
  }
}

export default function AnnouncementPopup() {
  const { user } = useAuthStore()
  const [dismissed, setDismissed] = useState<string[]>(getSeen)
  const [current, setCurrent] = useState<Announcement | null>(null)

  const { data: announcements = [] } = useQuery<Announcement[]>({
    queryKey: ['announcements-active'],
    queryFn: async () => {
      const { data } = await api.get('/announcements/active')
      return data
    },
    refetchInterval: POLL_MS,
    enabled: !!user,
  })

  // Show the newest announcement the user hasn't dismissed yet. Deliberately a
  // chain: once one is closed, the next unseen one takes its place on the next
  // poll — not all at once.
  const nextUnseen = useMemo(
    () => announcements.find((a) => !dismissed.includes(a.id)) || null,
    [announcements, dismissed],
  )

  useEffect(() => {
    if (nextUnseen) setCurrent(nextUnseen)
  }, [nextUnseen])

  const close = () => {
    if (current) {
      markSeen(current.id)
      setDismissed((prev) => [...prev, current.id])
    }
    setCurrent(null)
  }

  return (
    <AnimatePresence>
      {current && (
        <motion.div
          className="fixed inset-0 z-[9997] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={close}
        >
          <motion.div
            className="relative w-full max-w-md rounded-3xl bg-white dark:bg-card shadow-2xl overflow-hidden"
            initial={{ scale: 0.92, y: 24, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.92, y: 24, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 24 }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* Close */}
            <button
              onClick={close}
              className="absolute top-3 right-3 z-10 h-8 w-8 rounded-full bg-black/50 text-white flex items-center justify-center hover:bg-black/70"
              aria-label="Close announcement"
            >
              <X className="h-4 w-4" />
            </button>

            {/* Banner image */}
            {current.image_url ? (
              <img
                src={current.image_url}
                alt=""
                className="w-full h-44 object-cover"
              />
            ) : (
              <div className="h-24 bg-gradient-to-br from-violet-600 to-black relative flex items-center justify-center">
                <Megaphone className="w-10 h-10 text-white/80" />
              </div>
            )}

            <div className="p-6">
              <p className="text-xs font-semibold uppercase tracking-wider text-violet-600 dark:text-violet-400 mb-1">
                Announcement
              </p>
              <h2 className="text-xl font-bold mb-2">{current.title}</h2>
              <p className="text-gray-600 dark:text-muted-foreground leading-relaxed whitespace-pre-wrap text-sm">
                {current.message}
              </p>

              <div className="mt-6 flex items-center gap-3">
                {current.link && current.link.startsWith('/') && !current.link.startsWith('//') ? (
                  <Link
                    to={safeAppLink(current.link)}
                    onClick={close}
                    className="inline-flex items-center gap-2 rounded-full bg-black text-white px-5 py-2.5 text-sm font-semibold hover:opacity-90"
                  >
                    Open <ExternalLink className="h-3.5 w-3.5" />
                  </Link>
                ) : current.link ? (
                  <a
                    href={current.link}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={close}
                    className="inline-flex items-center gap-2 rounded-full bg-black text-white px-5 py-2.5 text-sm font-semibold hover:opacity-90"
                  >
                    Open <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                ) : null}
                <Button variant="ghost" onClick={close} className="text-gray-500 dark:text-muted-foreground">
                  Close
                </Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
