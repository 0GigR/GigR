// sw.js — Gigr Service Worker v3 (force-update + cache clear)

// ── Immediate activation on install ──────────────────────
self.addEventListener('install', () => {
  self.skipWaiting()
})

// ── Take control of all tabs + wipe old caches on activate ──
self.addEventListener('activate', (event) => {
  event.waitUntil(
    self.clients.claim().then(() => {
      return self.caches.keys().then((keys) => {
        return Promise.all(keys.map((key) => self.caches.delete(key)))
      })
    })
  )
})

// ── Precache (auto‑injected by vite‑plugin‑pwa) ─────────
import { precacheAndRoute } from 'workbox-precaching'
precacheAndRoute(self.__WB_MANIFEST || [])

// ── Listen for skip‑waiting from client ──────────────────
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting()
  }
})

// ── Push notifications ───────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return

  let data = {}
  try {
    data = event.data.json()
  } catch (e) {
    data = { title: 'New Notification', body: event.data.text() }
  }

  const options = {
    body: data.body || 'You have a new update.',
    icon: '/favicon.svg',
    badge: '/favicon.svg',
    data: {
      url: data.url || '/'
    }
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Gigr', options)
  )
})

// ── Notification click handler ───────────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const urlToOpen = new URL(event.notification.data.url, self.location.origin).href

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i]
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus()
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(urlToOpen)
      }
    })
  )
})