import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { GoogleOAuthProvider } from '@react-oauth/google'
import './index.css'
import App from './App.tsx'
import { initWebMCP } from '@/lib/webmcp'
import { initCurrencyDisplay } from '@/store/currencyStore'

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''

// Expose Gigr's WebMCP tools (post_job, fund_escrow, search_providers, …) to
// AI agents that browse the app. No-op in browsers without WebMCP support.
initWebMCP()

// Apply the user's saved display-currency preference at boot (default NGN).
initCurrencyDisplay()

// Automatically reload when a new deployment invalidates cached chunks
window.addEventListener('vite:preloadError', () => {
  window.location.reload()
})

// Wake up the backend (useful for serverless cold starts on Vercel hobby tier)
const apiUrl = import.meta.env.VITE_API_URL || 'https://wispy-lilly-ksschkw-ee52198c.koyeb.app/api/v1'
const docsUrl = apiUrl.replace(/\/api\/v1\/?$/, '/docs')
fetch(docsUrl, { mode: 'no-cors' }).catch(() => {})

// Register the service worker at app boot, on every page (landing, login,
// dashboard). Previously it only registered inside the logged-in dashboard, so
// an installed PWA's first load had no service worker — which on iOS 16.4+
// means web push silently can't work from the installed app. useRegisterSW in
// DashboardLayout still handles the update-prompt flow; registering the same
// URL again is idempotent (browser dedupes by URL).
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('Service worker registration failed:', err)
    })
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <App />
    </GoogleOAuthProvider>
  </StrictMode>,
)
