import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { GoogleOAuthProvider } from '@react-oauth/google'
import './index.css'
import App from './App.tsx'

const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || ''

// Wake up the backend (useful for serverless cold starts on Vercel hobby tier)
const apiUrl = import.meta.env.VITE_API_URL || 'https://gig-r.vercel.app/api/v1'
const docsUrl = apiUrl.replace(/\/api\/v1\/?$/, '/docs')
fetch(docsUrl, { mode: 'no-cors' }).catch(() => {})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID}>
      <App />
    </GoogleOAuthProvider>
  </StrictMode>,
)
