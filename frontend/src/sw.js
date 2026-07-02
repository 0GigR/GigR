import { precacheAndRoute } from 'workbox-precaching'

// This will be replaced by workbox-build (via vite-plugin-pwa)
precacheAndRoute(self.__WB_MANIFEST || [])

// Handle incoming push notifications
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

// Handle notification click
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const urlToOpen = new URL(event.notification.data.url, self.location.origin).href

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Check if there is already a window/tab open with the target URL
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i]
        if (client.url === urlToOpen && 'focus' in client) {
          return client.focus()
        }
      }
      // If not, open a new one
      if (self.clients.openWindow) {
        return self.clients.openWindow(urlToOpen)
      }
    })
  )
})
