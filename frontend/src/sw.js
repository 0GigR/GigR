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
// Opens the app at the exact deep link. Behaviour is platform-aware:
//  - Mobile (Android PWA / iOS): openWindow() raises the existing app window
//    for the same scope (it does not duplicate it) and navigates it. focus()
//    alone does NOT bring an Android PWA to the foreground — that's why taps
//    used to navigate the app without ever showing it.
//  - Desktop: reuse the existing tab — navigate it to the deep link (SPA:
//    same-origin navigate is a client-side route change) and focus it, so a
//    tap never spawns a duplicate tab.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  // Action buttons route the same place the main body does (Open chat, etc.).
  const urlToOpen = new URL(
    (event.notification.data && event.notification.data.url) || '/',
    self.location.origin
  ).href
  const origin = self.location.origin
  const platform = (event.notification.data && event.notification.data.platform) || 'desktop'

  event.waitUntil(
    (async () => {
      if ((platform === 'android' || platform === 'ios') && self.clients.openWindow) {
        await self.clients.openWindow(urlToOpen)
        return
      }

      const windowClients = await self.clients.matchAll({
        type: 'window',
        includeUncontrolled: true,
      })

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

      if (self.clients.openWindow) {
        await self.clients.openWindow(urlToOpen)
      }
    })()
  )
})
