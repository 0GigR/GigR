import { defineConfig } from 'vitest/config'
import path from 'path'

// Dedicated Vitest config: intentionally does NOT load the app's Vite plugins
// (React, Tailwind, PWA), because the WebMCP unit tests only exercise pure
// TypeScript modules and run fine in a plain Node environment.
const srcDir = path.resolve(import.meta.dirname, './src')

export default defineConfig({
  resolve: {
    alias: {
      '@': srcDir,
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
