import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

const API_TARGET = process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:8000'

export default defineConfig({
  plugins: [
    react(), 
    tailwindcss(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      registerType: 'prompt',
      includeAssets: ['favicon.svg', 'icon.png', 'pwa-192x192.png', 'pwa-512x512.png', 'pwa-maskable-512x512.png'],
      injectManifest: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB limit to allow heic2any
      },
      manifest: {
        name: 'Gigr Local Services',
        short_name: 'GigR',
        description: 'Verifiable Trust for Local Work',
        theme_color: '#000000',
        background_color: '#ffffff',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        lang: 'en',
        icons: [
          // PNG icons are required for installability and web push on Android
          // Chrome and iOS 16.4+ Safari — the SVG alone is not enough.
          {
            src: 'pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: 'pwa-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          },
          {
            src: 'favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any'
          }
        ]
      }
    })
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
    },
    proxy: {
      // Configurable so the dev server can point at a backend on another port
      // (localhost:8000 is frequently taken by an unrelated project). Same-origin
      // proxying also avoids CORS entirely while recording a demo.
      '/api': API_TARGET,
      '/ws': {
        target: API_TARGET.replace(/^http/, 'ws'),
        ws: true,
      },
    },
  },
})
