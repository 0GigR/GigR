// sw.js — Gigr Service Worker v4 (force-update + cache clear + rich push)

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

// Resolve app-relative asset paths against the SW origin so
// icons/badges work on every platform (Android, iOS, desktop).
const resolveAsset = (path) => new URL(path || '/icon.png', self.location.origin).href

// ── Push notifications ───────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return

  let data = {}
  try {
    data = event.data.json()
  } catch (e) {
    data = { title: 'New Notification', body: event.data.text() }
  }

  const type = data.type || 'system'
  const vibrate = Array.isArray(data.vibrate) ? data.vibrate : [100, 50, 100]

  const options = {
    body: data.body || 'You have a new update.',
    icon: resolveAsset(data.icon),
    badge: resolveAsset(data.badge),
    vibrate,
    timestamp: data.timestamp || Date.now(),
    renotify: !!data.renotify,
    data: {
      url: data.url || '/',
      type,
    },
  }

  // tag ⇒ new notifications of the same tag replace the old one
  // (one toast per chat instead of a stack), with renotify so it still alerts.
  if (data.tag) options.tag = data.tag

  // Sticky notifications for things that need a decision (hired, funded, work submitted).
  if (data.requireInteraction) options.requireInteraction = true

  // Action buttons (rendered on Android/desktop; ignored elsewhere).
  if (Array.isArray(data.actions) && data.actions.length) {
    options.actions = data.actions.slice(0, 2)
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Gigr', options)
  )
})

// ── Notification click handler ───────────────────────────
// Opens the app (PWA window or existing tab) at the exact deep link, instead of
// spawning a new browser tab. On installed PWAs this focuses the app window.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  // Action buttons route the same place the main body does (Open chat, etc.).
  const urlToOpen = new URL(
    (event.notification.data && event.notification.data.url) || '/',
    self.location.origin
  ).href
  const origin = self.location.origin

  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })

      // 1. Prefer an existing window/tab on our origin: navigate it to the deep
      //    link (SPA: same-origin navigate is a client-side route change) and
      //    focus it. This covers both the installed PWA window and a desktop tab.
      for (const client of windowClients) {
        try {
          if (new URL(client.url).origin !== origin) continue
          if (client.url !== urlToOpen && 'navigate' in client) {
            await client.navigate(urlToOpen)
          }
          if ('focus' in client) await client.focus()
          return
        } catch (e) {
          // Fall through to the next client if navigate/focus failed.
        }
      }

      // 2. No app window open — open one at the deep link. From an installed
      //    PWA's service worker this opens the standalone app window, not a tab.
      if (self.clients.openWindow) {
        await self.clients.openWindow(urlToOpen)
      }
    })()
  )
})
