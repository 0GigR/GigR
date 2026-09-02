/**
 * registry.ts — registers/unregisters Gigr's WebMCP tools for the current auth
 * state (pure, dependency-injected so it's easy to unit test).
 *
 * WebMCP has no `unregisterTool`: a tool lives until the AbortSignal passed at
 * registration time is aborted. So we keep one AbortController per registered
 * tool and abort it the moment the tool should disappear.
 *
 * The gating rule:
 *   - signed out  → only PUBLIC tools are registered (get_auth_status,
 *                   search_providers, get_provider_reputation)
 *   - signed in   → every tool is registered
 *
 * Sensitive tools (fund_escrow, release_escrow, post_job, …) are therefore not
 * merely checked at runtime — on a logged-out session they are never exposed to
 * the agent at all.
 */

import type { WebMCPTool } from './tools'

export interface ModelContext {
  registerTool(def: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<void> | void
}

export interface RegistrarOptions {
  tools: readonly WebMCPTool[]
  /** Names that stay registered even while signed out. */
  publicToolNames: ReadonlySet<string>
  isSignedIn: () => boolean
  getModelContext: () => ModelContext | null
  /** Called to hook auth changes; must return an unsubscribe function. */
  onAuthChange: (listener: () => void) => () => void
}

export interface Registrar {
  /** Register the current tool set and start listening for auth changes. */
  start: () => void
  /** Stop listening and unregister every tool. */
  stop: () => void
  /** Re-evaluate auth state and register/unregister accordingly. */
  sync: () => Promise<void>
}

export function createRegistrar(opts: RegistrarOptions): Registrar {
  const controllers = new Map<string, AbortController>()
  const registered = new Set<string>()
  let stopped = false
  let queue: Promise<unknown> = Promise.resolve()
  let unsubscribe: (() => void) | null = null

  function desiredToolNames(): Set<string> {
    const signedIn = opts.isSignedIn()
    const names = new Set<string>()
    for (const tool of opts.tools) {
      if (signedIn || opts.publicToolNames.has(tool.name)) names.add(tool.name)
    }
    return names
  }

  async function sync(): Promise<void> {
    if (stopped) return
    const context = opts.getModelContext()
    if (!context || typeof context.registerTool !== 'function') return

    const desired = desiredToolNames()

    // Unregister tools that are no longer allowed (e.g. user just signed out).
    for (const [name, controller] of [...controllers.entries()]) {
      if (!desired.has(name)) {
        controller.abort()
        controllers.delete(name)
        registered.delete(name)
      }
    }

    // Register tools that should be present but aren't yet (e.g. user just
    // signed in). Duplicate names are simply re-registered (spec replaces).
    for (const tool of opts.tools) {
      if (!desired.has(tool.name) || registered.has(tool.name)) continue
      const controller = new AbortController()
      controllers.set(tool.name, controller)
      try {
        await context.registerTool(
          {
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            annotations: tool.annotations,
            execute: tool.execute,
          },
          { signal: controller.signal },
        )
        registered.add(tool.name)
      } catch (err) {
        // Duplicate/name collision or invalid definition. Drop our controller so
        // a later sync can retry; don't take the page down over it.
        if (controllers.get(tool.name) === controller) controllers.delete(tool.name)
        console.warn('[webmcp] failed to register tool', tool.name, err)
      }
    }
  }

  // Serialise syncs so a login/logout burst can't interleave registrations.
  function schedule(): void {
    queue = queue.then(sync).catch(() => undefined)
  }

  return {
    start() {
      if (stopped) return
      schedule()
      if (!unsubscribe) {
        unsubscribe = opts.onAuthChange(() => schedule())
      }
    },

    stop() {
      stopped = true
      if (unsubscribe) {
        unsubscribe()
        unsubscribe = null
      }
      for (const controller of controllers.values()) controller.abort()
      controllers.clear()
      registered.clear()
    },

    sync,
  }
}
