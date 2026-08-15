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

// Telemetry: report where the push flow gets to (and where it stops) so
// failures that happen before any push API call show up in the server logs
// instead of vanishing. Best-effort — never breaks the flow.
async function diag(event: string, detail?: string) {
  try {
    await api.post('/push/diagnostic', { event, detail })
  } catch {
    // ignore — telemetry must never break push
  }
}

/**
 * Ensure the backend has a working copy of the browser's push subscription,
 * without prompting the user. Call on app load: if the backend lost the
 * subscription (410 Gone, DB reset), the user cleared site data, or the token
 * expired and the local subscription vanished, this heals it silently.
 *
 * Never requests permission and never shows the native dialog. When permission
 * is already granted but no subscription exists (expired token, cleared data),
 * it re-subscribes directly — the browser allows this without a prompt.
 */
export async function syncPushSubscription(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return false
  if (Notification.permission !== 'granted') return false

  try {
    const registration = await navigator.serviceWorker.ready
    let subscription = await registration.pushManager.getSubscription()
    if (!subscription) {
      // Permission granted but no active subscription (expired token or
      // cleared site data) — re-subscribe silently, no prompt needed.
      const publicKey = await getVapidPublicKey()
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToUint8Array(publicKey),
      })
    }
    await saveSubscription(subscription)
    diag('synced')
    return true
  } catch (err: any) {
    console.warn('Push subscription sync failed:', err)
    diag('sync-error', `${err?.name}: ${err?.message}`)
    return false
  }
}

/**
 * Create (or reuse) the browser's push subscription and, when logged in, save
 * it to the backend.
 *
 * Pass skipServerSave for pre-login enablement (landing page): the browser
 * subscription is created early in the funnel, and syncPushSubscription links
 * it to the account after sign-in — the server save requires auth.
 */
export async function subscribeToPushNotifications(skipServerSave = false) {
  diag('start', skipServerSave ? 'pre-login' : 'authed')

  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push messaging is not supported.')
    diag('unsupported', `sw=${'serviceWorker' in navigator} pushMgr=${'PushManager' in window}`)
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
      diag('permission-denied', String(permission))
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

    // 5. Send subscription to backend (skip pre-login: it needs an account)
    if (!skipServerSave) {
      await saveSubscription(subscription)
    }
    
    console.log('Successfully subscribed to web push notifications')
    diag('subscribed')
    return true
  } catch (err: any) {
    console.error('Error subscribing to web push:', err)
    diag('error', `${err?.name}: ${err?.message}`)
    return false
  }
}
