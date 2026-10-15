/**
 * index.ts — Gigr WebMCP bootstrap.
 *
 * Wires the pure tool definitions (tools.ts) and the auth-gating registrar
 * (registry.ts) to the real app: the authenticated axios client, the zustand
 * auth store, and WebMCP's `document.modelContext` (when present).
 *
 * Why this works without agent login: WebMCP tools execute *inside the user's
 * already-open, already-authenticated tab*. Each `execute` reuses the app's
 * axios instance, which sends the same HttpOnly cookie / Bearer token the
 * logged-in user already has — so an agent calling these tools acts as the
 * signed-in user. Sign-in only gates which tools are exposed at all.
 *
 * Call `initWebMCP()` once at app boot. It degrades to a no-op in browsers
 * without WebMCP support.
 */

import api from '@/lib/api'
import { useAuthStore } from '@/store/authStore'
import { applyDisplayCurrency } from '@/store/currencyStore'
import type { CurrencyCode } from '@/lib/currency'
import { createGigrWebMCPTools, PUBLIC_TOOL_NAMES, type CurrentUser, type ToolApi, type WebMCPTool } from './tools'
import { createRegistrar, type ModelContext } from './registry'

function getModelContext(): ModelContext | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as Record<string, unknown>
  const document = w.document as (Document & { modelContext?: ModelContext }) | undefined
  if (document?.modelContext) return document.modelContext
  const nav = w.navigator as (Navigator & { modelContext?: ModelContext }) | undefined
  if (nav?.modelContext) return nav.modelContext // deprecated alias, keep as fallback
  return null
}

function hasRegisterTool(): boolean {
  const context = getModelContext()
  return !!context && typeof context.registerTool === 'function'
}

// Thin adapter: the axios `api` instance returns { data } — unwrap it so tools
// get the payload directly. Auth (cookie + Bearer) rides along automatically.
const adapter: ToolApi = {
  get: async (url, params) => {
    const res = await api.get(url, { params })
    return res.data
  },
  post: async (url, body) => {
    const res = await api.post(url, body)
    return res.data
  },
}

let started = false
let activeNavigator: ((targetRoute: string) => void) | null = null

export function setWebMCPNavigate(navigationFunction: (targetRoute: string) => void): void {
  activeNavigator = navigationFunction
}

export function initWebMCP(): void {
  if (started || typeof window === 'undefined') return
  started = true

  const currentUser = (): CurrentUser | null => {
    const u = useAuthStore.getState().user
    if (!u) return null
    return {
      id: u.id,
      display_name: u.display_name,
      email: u.email,
      is_verified: u.is_verified,
      role: u.role,
    }
  }

  const tools: WebMCPTool[] = createGigrWebMCPTools({
    api: adapter,
    currentUser,
    setDisplayCurrency: (code) => applyDisplayCurrency(code as CurrencyCode),
    navigate: (targetRoute) => {
      if (activeNavigator) activeNavigator(targetRoute)
    },
  })

  const registrar = createRegistrar({
    tools,
    publicToolNames: PUBLIC_TOOL_NAMES,
    isSignedIn: () => !!currentUser(),
    getModelContext,
    onAuthChange: (listener) =>
      useAuthStore.subscribe((state, prev) => {
        // Re-sync when the identity or the initial "still loading" flag changes.
        if (state.user !== prev.user || state.isLoading !== prev.isLoading) listener()
      }),
  })

  registrar.start()

  // Dev-only console hook so you can smoke-test the tools right now without an
  // agent host: run the real execute functions against the live backend, and
  // inspect what WebMCP actually exposes (when a host is present). Never ships.
  if (import.meta.env.DEV) {
    attachDevHooks(tools, registrar, currentUser)
  }

  // In some hosts WebMCP attaches `document.modelContext` slightly after the
  // first paint. Re-check briefly so the tools appear even then; once the
  // context is present the registrar handles everything from auth changes.
  if (!hasRegisterTool()) {
    let attempts = 0
    const timer = window.setInterval(() => {
      attempts += 1
      if (hasRegisterTool()) {
        registrar.sync()
        window.clearInterval(timer)
      } else if (attempts >= 10) {
        window.clearInterval(timer)
      }
    }, 500)
  }
}

interface DevHooks {
  tools: WebMCPTool[]
  registrar: ReturnType<typeof createRegistrar>
  currentUser: () => CurrentUser | null
}

/**
 * Exposes `window.__GIGR_WEBMCP__` in dev (never in production builds):
 *
 *   .tools              – all registered tool names
 *   .isSignedIn         – current auth state
 *   .modelContext       – whether this browser exposes document.modelContext
 *   .invoke(name, input)– run a tool's real execute against the live backend
 *   .getTools()         – what WebMCP itself currently lists (null if no host)
 *   .registerNow()      – force a re-sync of registration vs auth
 */
function attachDevHooks(tools: WebMCPTool[], registrar: ReturnType<typeof createRegistrar>, currentUser: () => CurrentUser | null): void {
  const w = window as unknown as Record<string, unknown>
  const hooks: DevHooks & {
    isSignedIn: boolean
    modelContext: boolean
    invoke: (name: string, input?: unknown) => Promise<unknown>
    getTools: () => Promise<unknown>
    registerNow: () => Promise<void>
  } = {
    tools,
    registrar,
    currentUser,
    get isSignedIn() {
      return !!currentUser()
    },
    get modelContext() {
      return hasRegisterTool()
    },
    async invoke(name: string, input?: unknown) {
      const tool = tools.find((t) => t.name === name)
      if (!tool) {
        return { ok: false, error: `Unknown tool "${name}". Available: ${tools.map((t) => t.name).join(', ')}` }
      }
      try {
        return await tool.execute(input)
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    async getTools() {
      try {
        const context = getModelContext() as (ModelContext & { getTools?: () => Promise<unknown> }) | null
        return context?.getTools ? await context.getTools() : null
      } catch {
        return null
      }
    },
    registerNow: () => registrar.sync(),
  }
  w.__GIGR_WEBMCP__ = hooks
  console.info(
    '[webmcp] dev hooks ready — try window.__GIGR_WEBMCP__.invoke("search_providers", { category: "Plumbing" })',
  )
}
