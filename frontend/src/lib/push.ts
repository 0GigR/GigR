import api from '@/lib/api'

// Helper to convert base64 url-safe to Uint8Array for PushManager
function urlB64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4)
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/')

  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}

export async function subscribeToPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push messaging is not supported.')
    return false
  }

  try {
    // 1. Get VAPID public key from backend
    const res = await api.get('/push/vapid-public-key')
    const { publicKey } = res.data

    // 2. Request permission (if not already granted/denied)
    let permission = Notification.permission
    if (permission === 'default') {
      permission = await Notification.requestPermission()
    }
    
    if (permission !== 'granted') {
      console.warn('Push notification permission denied.')
      return false
    }

    // 3. Get Service Worker registration
    const registration = await navigator.serviceWorker.ready

    // 4. Subscribe
    const applicationServerKey = urlB64ToUint8Array(publicKey)
    let subscription = await registration.pushManager.getSubscription()
    if (subscription) {
      // If already subscribed but maybe key changed or not saved on backend, update it
      // For simplicity, we just send it to backend again
    } else {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey,
      })
    }

    // 5. Send subscription to backend
    const subJSON = subscription.toJSON()
    await api.post('/push/subscribe', {
      endpoint: subJSON.endpoint,
      keys: subJSON.keys
    })
    
    console.log('Successfully subscribed to web push notifications')
    return true
  } catch (err) {
    console.error('Error subscribing to web push:', err)
    return false
  }
}
