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

async function getVapidPublicKey(): Promise<string> {
  const res = await api.get('/push/vapid-public-key')
  return res.data.publicKey
}

async function saveSubscription(subscription: PushSubscription): Promise<void> {
  const subJSON = subscription.toJSON()
  await api.post('/push/subscribe', {
    endpoint: subJSON.endpoint,
    keys: subJSON.keys
  })
}

/**
 * Re-send the browser's existing push subscription to the backend without
 * prompting the user. Call on app load: if the backend lost the subscription
 * (410 Gone, DB reset) or the user cleared site data, this heals it silently.
 * Never requests permission and never prompts the native dialog.
 */
export async function syncPushSubscription(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
  if (Notification.permission !== 'granted') return false

  try {
    const registration = await navigator.serviceWorker.ready
    const subscription = await registration.pushManager.getSubscription()
    if (!subscription) return false
    await saveSubscription(subscription)
    return true
  } catch (err) {
    console.warn('Push subscription sync failed:', err)
    return false
  }
}

export async function subscribeToPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push messaging is not supported.')
    return false
  }

  try {
    // 1. Get VAPID public key from backend
    const publicKey = await getVapidPublicKey()

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
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey,
      })
    }

    // 5. Send subscription to backend
    await saveSubscription(subscription)
    
    console.log('Successfully subscribed to web push notifications')
    return true
  } catch (err) {
    console.error('Error subscribing to web push:', err)
    return false
  }
}
