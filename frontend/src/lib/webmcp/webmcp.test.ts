/**
 * webmcp.test.ts — unit tests for Gigr's WebMCP layer.
 *
 * Run with:  npm test   (vitest)
 *
 * Covers two layers:
 *   1. tools.ts  — each tool's `execute` maps to the right API call and shapes
 *                  its output for an agent, with auth pre-checks.
 *   2. registry.ts — tools are exposed/un-exposed as the user signs in/out
 *                    (AbortSignal lifecycle), so payment tools never exist on
 *                    a logged-out session.
 */
import { describe, expect, it } from 'vitest'
import { createGigrWebMCPTools, PUBLIC_TOOL_NAMES, AUTHED_TOOL_NAMES, ALL_TOOL_NAMES, type ToolApi, type CurrentUser } from './tools'
import { createRegistrar, type ModelContext } from './registry'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const USER: CurrentUser = { id: 'u-client', display_name: 'Ayo', email: 'ayo@example.com', is_verified: true }

const ASSIGNED_JOB = {
  id: 'job-1', client_id: 'u-client', provider_id: 'u-provider', title: 'Fix leaking sink',
  description: 'Kitchen sink under the window', status: 'assigned', price: '15000',
  category_id: 'cat-1', escrow_address: 'escrowAddr', created_at: '2026-09-01T10:00:00Z',
}

function jobWith(overrides: { status?: string; provider_id?: string | null } = {}) {
  return { ...ASSIGNED_JOB, ...overrides }
}

/** Mutable logged-in flag so tools can be tested both ways. */
function loggedInState(initial: CurrentUser | null) {
  const state = { user: initial }
  return {
    state,
    currentUser: () => state.user,
    signIn: () => { state.user = USER },
    signOut: () => { state.user = null },
  }
}

interface Call {
  url: string
  params?: Record<string, unknown>
  body?: unknown
}

function makeApi(overrides: { onGet?: (url: string, params?: Record<string, unknown>) => unknown; onPost?: (url: string, body?: unknown) => unknown } = {}) {
  const calls: { get: Call[]; post: Call[] } = { get: [], post: [] }
  const api: ToolApi = {
    async get<T = unknown>(url: string, params?: Record<string, unknown>): Promise<T> {
      calls.get.push({ url: String(url), params })
      const value = overrides.onGet ? overrides.onGet(String(url), params) : []
      return value as T
    },
    async post<T = unknown>(url: string, body?: unknown): Promise<T> {
      calls.post.push({ url: String(url), body })
      const value = overrides.onPost ? overrides.onPost(String(url), body) : {}
      return value as T
    },
  }
  return { api, calls }
}

/** Grab one tool definition by name. */
function findTool(tools: ReturnType<typeof createGigrWebMCPTools>, name: string) {
  const tool = tools.find((t) => t.name === name)
  if (!tool) throw new Error(`tool ${name} not found`)
  return tool
}

async function run(tools: ReturnType<typeof createGigrWebMCPTools>, name: string, input?: unknown) {
  return (await findTool(tools, name).execute(input)) as any
}

// ─── tools.ts behaviour ───────────────────────────────────────────────────────

describe('tool definitions', () => {
  it('has unique names covering the full Gigr story', () => {
    const tools = createGigrWebMCPTools({ api: makeApi().api, currentUser: () => null })
    const names = tools.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    expect(ALL_TOOL_NAMES).toEqual(new Set(names))
    // headline payment/trust tools exist
    expect(names).toEqual(expect.arrayContaining(['post_job', 'fund_escrow', 'release_escrow', 'search_providers', 'get_provider_reputation']))
  })
})

describe('get_auth_status', () => {
  it('reports signed out and lists which tools need sign-in', async () => {
    const { api } = makeApi()
    const tools = createGigrWebMCPTools({ api, currentUser: () => null })
    const res = await run(tools, 'get_auth_status')
    expect(res.signed_in).toBe(false)
    expect(res.requires_sign_in).toEqual(AUTHED_TOOL_NAMES)
    expect(res.user).toBeUndefined()
  })

  it('reports the signed-in user', async () => {
    const auth = loggedInState(USER)
    const tools = createGigrWebMCPTools({ api: makeApi().api, currentUser: auth.currentUser })
    const res = await run(tools, 'get_auth_status')
    expect(res.signed_in).toBe(true)
    expect(res.user).toMatchObject({ id: 'u-client', email: 'ayo@example.com' })
  })
})

describe('get_user_location', () => {
  it('returns the location saved in the user\'s profile when signed in', async () => {
    const { api, calls } = makeApi({
      onGet: (url) => (url === '/users/me' ? { id: 'u1', location_lat: 6.5244, location_lng: 3.3792 } : {}),
    })
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser })
    const res = await run(tools, 'get_user_location')
    expect(res.ok).toBe(true)
    expect(res.has_location).toBe(true)
    expect(res.source).toBe('saved_profile')
    expect(res.latitude).toBe(6.5244)
    expect(calls.get.map((c) => c.url)).toContain('/users/me')
  })

  it('does not hit the profile (or invent a location) while signed out with no GPS', async () => {
    const { api, calls } = makeApi()
    const tools = createGigrWebMCPTools({ api, currentUser: () => null })
    const res = await run(tools, 'get_user_location')
    expect(res.ok).toBe(true)
    expect(res.has_location).toBe(false)
    expect(res.latitude).toBeNull()
    expect(calls.get).toHaveLength(0)
  })

  it('falls back to browser GPS when the profile has no saved location', async () => {
    // Node ≥21 ships a global `navigator` without geolocation. Stub it when the
    // runtime allows; otherwise just assert the graceful no-location path.
    let overridden = false
    const desc = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
    try {
      Object.defineProperty(globalThis, 'navigator', {
        configurable: true,
        value: {
          geolocation: {
            getCurrentPosition: (ok: (p: unknown) => void) =>
              ok({ coords: { latitude: 6.52, longitude: 3.37, accuracy: 12 } }),
          },
        },
      })
      overridden = true
    } catch {
      overridden = false
    }
    try {
      const { api } = makeApi({ onGet: () => ({ id: 'u1' }) }) // signed-in but no saved location
      const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser })
      const res = await run(tools, 'get_user_location')
      if (overridden) {
        expect(res.ok).toBe(true)
        expect(res.has_location).toBe(true)
        expect(res.source).toBe('browser_gps')
        expect(res.latitude).toBe(6.52)
      } else {
        expect(res.has_location).toBe(false)
      }
    } finally {
      if (overridden) {
        if (desc) Object.defineProperty(globalThis, 'navigator', desc)
        else delete (globalThis as any).navigator
      }
    }
  })
})

describe('post_job', () => {
  it('blocks when signed out', async () => {
    const { api, calls } = makeApi()
    const tools = createGigrWebMCPTools({ api, currentUser: () => null })
    const res = await run(tools, 'post_job', { title: 'Fix sink', description: 'x', price: 15000 })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/sign in/i)
    expect(calls.post).toHaveLength(0)
  })

  it('posts a job, resolving a category name to its UUID', async () => {
    const { api, calls } = makeApi({
      onGet: (url) => (url === '/categories' ? [{ id: 'cat-1', name: 'Plumbing' }] : []),
      onPost: (url) => (url === '/jobs/' ? ASSIGNED_JOB : {}),
    })
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser })
    const res = await run(tools, 'post_job', { title: 'Fix leaking sink', description: 'Kitchen sink', price: '15000', category: 'Plumbing' })

    expect(res.ok).toBe(true)
    expect(res.job.status).toBe('assigned')
    expect(calls.get).toEqual([{ url: '/categories', params: undefined }])
    const posted = calls.post.find((c) => c.url === '/jobs/')
    expect(posted?.body).toMatchObject({
      title: 'Fix leaking sink',
      price: 15000,
      category_id: 'cat-1',
    })
  })

  it('does not fetch categories when none is given', async () => {
    const { api, calls } = makeApi({ onPost: () => ASSIGNED_JOB })
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser })
    const res = await run(tools, 'post_job', { title: 'Fix sink', description: 'x', price: 15000 })
    expect(res.ok).toBe(true)
    expect(calls.get).toHaveLength(0)
  })
})

describe('post_service', () => {
  it('publishes a provider listing (be hired) with a resolved category + location', async () => {
    const { api, calls } = makeApi({
      onGet: (url) => (url === '/categories' ? [{ id: 'cat-2', name: 'Tutoring' }] : []),
      onPost: (url) =>
        url === '/services/'
          ? { id: 'svc-1', provider_id: 'u-provider', title: 'Piano lessons for beginners', price: '10000', category_id: 'cat-2' }
          : {},
    })
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser })
    const res = await run(tools, 'post_service', {
      title: 'Piano lessons for beginners',
      price: 10000,
      category: 'Tutoring',
      latitude: 6.5,
      longitude: 3.37,
    })
    expect(res.ok).toBe(true)
    expect(res.service.title).toBe('Piano lessons for beginners')
    const posted = calls.post.find((c) => c.url === '/services/')
    expect(posted?.body).toMatchObject({ category_id: 'cat-2', price: 10000, latitude: 6.5, longitude: 3.37 })
  })

  it('asks for a location rather than guessing', async () => {
    const tools = createGigrWebMCPTools({ api: makeApi().api, currentUser: loggedInState(USER).currentUser })
    const res = await run(tools, 'post_service', { title: 'Piano lessons', price: 10000, category: 'Tutoring' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/latitude and longitude/)
  })
})

describe('set_display_currency', () => {
  it('is gated behind sign-in', async () => {
    const { api } = makeApi()
    const tools = createGigrWebMCPTools({ api, currentUser: () => null, setDisplayCurrency: () => {} })
    const res = await run(tools, 'set_display_currency', { code: 'USD' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/sign in/i)
  })

  it('switches the user display currency via the injected setter', async () => {
    const { api } = makeApi()
    const calls: string[] = []
    const tools = createGigrWebMCPTools({
      api,
      currentUser: loggedInState(USER).currentUser,
      setDisplayCurrency: async (code: string) => { calls.push(code) },
    })
    const res = await run(tools, 'set_display_currency', { code: 'usd' }) // case-insensitive
    expect(res.ok).toBe(true)
    expect(res.display_currency).toBe('USD')
    expect(calls).toEqual(['USD'])
  })

  it('rejects unsupported codes', async () => {
    const { api } = makeApi()
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser, setDisplayCurrency: () => {} })
    const res = await run(tools, 'set_display_currency', { code: 'BTC' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/USD/)
  })
})

describe('navigate_to', () => {
  it('calls the injected navigate callback with the validated path', async () => {
    const { api } = makeApi()
    const routes: string[] = []
    const tools = createGigrWebMCPTools({
      api,
      currentUser: loggedInState(USER).currentUser,
      navigate: (target) => { routes.push(target) },
    })

    const res = await run(tools, 'navigate_to', { path: '/dashboard/explore' })
    expect(res.ok).toBe(true)
    expect(res.navigated).toBe(true)
    expect(routes).toEqual(['/dashboard/explore'])
  })

  it('rejects missing or non-slash paths', async () => {
    const { api } = makeApi()
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser })

    const emptyRes = await run(tools, 'navigate_to', { path: '' })
    expect(emptyRes.ok).toBe(false)

    const invalidRes = await run(tools, 'navigate_to', { path: 'relative/path' })
    expect(invalidRes.ok).toBe(false)
    expect(invalidRes.error).toMatch(/start with "\/"/i)
  })
})

describe('scroll_into_view', () => {
  it('rejects empty selectors and gracefully handles unmatched elements', async () => {
    const { api } = makeApi()
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser })

    const emptyRes = await run(tools, 'scroll_into_view', { selector: '' })
    expect(emptyRes.ok).toBe(false)

    const unmatchedRes = await run(tools, 'scroll_into_view', { selector: '#non-existent-element-xyz' })
    expect(unmatchedRes.ok).toBe(true)
    expect(unmatchedRes.scrolled).toBe(false)
  })
})

describe('fund_escrow / release_escrow', () => {
  it('funds only an assigned (hired) job', async () => {
    const { api, calls } = makeApi({
      onGet: () => ASSIGNED_JOB,
      onPost: (url) => (url.endsWith('/fund') ? { ...ASSIGNED_JOB, status: 'funded' } : ASSIGNED_JOB),
    })
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser })

    const res = await run(tools, 'fund_escrow', { job_id: 'job-1' })
    expect(res.ok).toBe(true)
    expect(calls.post.map((c) => c.url)).toContain('/jobs/job-1/fund')
  })

  it('refuses to fund an open (unhired) job and explains why', async () => {
    const { api, calls } = makeApi({ onGet: () => jobWith({ status: 'open', provider_id: null }) })
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser })
    const res = await run(tools, 'fund_escrow', { job_id: 'job-1' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no hired provider/i)
    expect(calls.post).toHaveLength(0)
  })

  it('releases a funded job to the provider', async () => {
    const { api, calls } = makeApi({
      onGet: () => jobWith({ status: 'funded' }),
      onPost: (url) => (url.endsWith('/release') ? { ...ASSIGNED_JOB, status: 'completed' } : ASSIGNED_JOB),
    })
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser })
    const res = await run(tools, 'release_escrow', { job_id: 'job-1' })
    expect(res.ok).toBe(true)
    expect(res.note).toMatch(/released/)
    expect(calls.post.map((c) => c.url)).toContain('/jobs/job-1/release')
  })

  it('is a no-op (with explanation) when the job is already completed', async () => {
    const { api, calls } = makeApi({ onGet: () => jobWith({ status: 'completed' }) })
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser })
    const res = await run(tools, 'release_escrow', { job_id: 'job-1' })
    expect(res.ok).toBe(true)
    expect(calls.post).toHaveLength(0)
    expect(res.job.status).toBe('completed')
  })
})

describe('accept_job', () => {
  it('accepts a requested service request', async () => {
    const { api, calls } = makeApi({
      onGet: () => jobWith({ status: 'requested' }),
      onPost: (url) => (url.endsWith('/accept-request') ? jobWith({ status: 'assigned' }) : ASSIGNED_JOB),
    })
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState({ ...USER, id: 'u-provider' }).currentUser })
    const res = await run(tools, 'accept_job', { job_id: 'job-1' })
    expect(res.ok).toBe(true)
    expect(res.job.status).toBe('assigned')
    expect(calls.post.map((c) => c.url)).toContain('/jobs/job-1/accept-request')
  })
})

describe('list_my_jobs / get_job_status / get_notifications', () => {
  it('lists the user\'s jobs as client/provider with status filter', async () => {
    const { api, calls } = makeApi({ onGet: () => [jobWith({ status: 'assigned' })] })
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser })
    const res = await run(tools, 'list_my_jobs', { role: 'client', status: 'assigned' })
    expect(res.ok).toBe(true)
    expect(res.count).toBe(1)
    expect(calls.get[0]).toMatchObject({ url: '/jobs/', params: { my: 'client', status: 'assigned' } })
  })

  it('returns the lifecycle + next action for a job status', async () => {
    const { api } = makeApi({ onGet: () => ASSIGNED_JOB })
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser })
    const res = await run(tools, 'get_job_status', { job_id: 'job-1' })
    expect(res.ok).toBe(true)
    expect(res.status).toBe('assigned')
    expect(res.next_actions).toMatch(/fund/)
  })

  it('returns unread notification count', async () => {
    const { api } = makeApi({
      onGet: () => [
        { id: 'n1', title: 'Escrow Funded', message: 'm', type: 'payment', link: null, is_read: false, created_at: 'x' },
        { id: 'n2', title: 'Old', message: 'm2', type: 'message', link: null, is_read: true, created_at: 'x' },
      ],
    })
    const tools = createGigrWebMCPTools({ api, currentUser: loggedInState(USER).currentUser })
    const res = await run(tools, 'get_notifications')
    expect(res.unread_count).toBe(1)
    expect(res.notifications).toHaveLength(2)
  })
})

describe('search_providers / get_provider_reputation', () => {
  it('searches nearby providers and enriches with reputation', async () => {
    const service = {
      id: 'svc-1', provider_id: 'u-provider', category_id: 'cat-1', title: 'Sink repair',
      description: null, price: '10000', latitude: 6.5, longitude: 3.4, radius_km: 5,
    }
    const profile = {
      id: 'u-provider', display_name: 'Emeka', is_verified: true, avg_rating: 4.8,
      rating_count: 12, vouches_received_count: 5, skills: ['plumbing'], bio: 'hi',
    }
    const { api, calls } = makeApi({
      onGet: (url) => {
        if (url === '/categories') return [{ id: 'cat-1', name: 'Plumbing' }]
        if (url === '/services/search/nearby') return [service]
        if (url === '/users/u-provider') return profile
        return []
      },
    })
    const tools = createGigrWebMCPTools({ api, currentUser: () => null }) // browsing works signed out
    const res = await run(tools, 'search_providers', { category: 'Plumbing', latitude: 6.5, longitude: 3.4, radius_km: 5 })

    expect(res.ok).toBe(true)
    expect(res.count).toBe(1)
    expect(calls.get).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: '/services/search/nearby',
          params: expect.objectContaining({ lat: 6.5, lon: 3.4, radius: 5, category_id: 'cat-1' }),
        }),
        expect.objectContaining({ url: '/users/u-provider' }),
      ]),
    )
    expect(res.results[0].provider.display_name).toBe('Emeka')
    expect(res.results[0].provider.vouches_received_count).toBe(5)
  })

  it('asks for at least a location or a query', async () => {
    const tools = createGigrWebMCPTools({ api: makeApi().api, currentUser: () => null })
    const res = await run(tools, 'search_providers', {})
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/latitude|location/i)
  })

  it('returns a provider\'s verifiable trust record', async () => {
    const { api, calls } = makeApi({
      onGet: (url) => {
        if (url === '/users/u-provider') return { id: 'u-provider', display_name: 'Emeka', is_verified: true, avg_rating: 4.8, rating_count: 12, vouches_received_count: 5 }
        if (url === '/vouches/user/u-provider') return [
          { id: 'v1', job_id: 'j9', voucher_id: 'u-a', vouchee_id: 'u-provider', cnf_nft_id: 'nft-1', transaction_signature: 'sig-1', created_at: 'x' },
        ]
        return []
      },
    })
    const tools = createGigrWebMCPTools({ api, currentUser: () => null })
    const res = await run(tools, 'get_provider_reputation', { provider_id: 'u-provider' })
    expect(res.ok).toBe(true)
    expect(res.provider.vouches_received_count).toBe(5)
    expect(res.recent_verified_vouches[0].cnf_nft_id).toBe('nft-1')
    expect(calls.get.map((c) => c.url)).toContain('/vouches/user/u-provider')
  })
})

// ─── registry.ts auth gating ─────────────────────────────────────────────────

describe('createRegistrar (auth gating)', () => {
  function contextFixture() {
    const live = new Map<string, { signal?: AbortSignal }>()
    const events: Array<{ name: string; signal?: AbortSignal }> = []
    const ctx: ModelContext = {
      registerTool(def, opts) {
        events.push({ name: String(def.name), signal: opts?.signal })
        live.set(String(def.name), { signal: opts?.signal })
        return Promise.resolve()
      },
    }
    return { ctx, live, events }
  }

  function toolsFixture() {
    const { api } = makeApi()
    return createGigrWebMCPTools({ api, currentUser: () => null })
  }

  it('registers only public tools while signed out, all tools once signed in', async () => {
    const { ctx, live } = contextFixture()
    let signedIn = false
    const registrar = createRegistrar({
      tools: toolsFixture(),
      publicToolNames: PUBLIC_TOOL_NAMES,
      isSignedIn: () => signedIn,
      getModelContext: () => ctx,
      onAuthChange: () => () => {},
    })

    await registrar.sync()
    expect(live.has('get_auth_status')).toBe(true)
    expect(live.has('search_providers')).toBe(true)
    expect(live.has('get_provider_reputation')).toBe(true)
    expect(live.has('fund_escrow')).toBe(false)
    expect(live.has('post_job')).toBe(false)
    expect(live.size).toBe(PUBLIC_TOOL_NAMES.size)

    signedIn = true
    await registrar.sync()
    for (const name of ALL_TOOL_NAMES) expect(live.has(name)).toBe(true)
  })

  it('aborts the payment tools when the user signs out (unregisters via signal)', async () => {
    const { ctx, live } = contextFixture()
    let signedIn = true
    const registrar = createRegistrar({
      tools: toolsFixture(),
      publicToolNames: PUBLIC_TOOL_NAMES,
      isSignedIn: () => signedIn,
      getModelContext: () => ctx,
      onAuthChange: () => () => {},
    })

    await registrar.sync()
    const fundSignal = live.get('fund_escrow')?.signal
    expect(fundSignal?.aborted).toBe(false)

    signedIn = false
    await registrar.sync()
    // The host unregisters a tool when its AbortSignal fires.
    expect(fundSignal?.aborted).toBe(true)
  })

  it('re-registers a gated tool after sign-out then sign-in', async () => {
    const { ctx, events } = contextFixture()
    let signedIn = false
    const registrar = createRegistrar({
      tools: toolsFixture(),
      publicToolNames: PUBLIC_TOOL_NAMES,
      isSignedIn: () => signedIn,
      getModelContext: () => ctx,
      onAuthChange: () => () => {},
    })

    await registrar.sync() // signed out: no fund_escrow
    signedIn = true
    await registrar.sync()
    signedIn = false
    await registrar.sync()
    signedIn = true
    await registrar.sync()

    const fundRegistrations = events.filter((e) => e.name === 'fund_escrow')
    expect(fundRegistrations).toHaveLength(2) // one per signed-in session
  })

  it('does not double-register on repeated syncs', async () => {
    const { ctx, events } = contextFixture()
    const registrar = createRegistrar({
      tools: toolsFixture(),
      publicToolNames: PUBLIC_TOOL_NAMES,
      isSignedIn: () => true,
      getModelContext: () => ctx,
      onAuthChange: () => () => {},
    })
    await registrar.sync()
    await registrar.sync()
    expect(events.filter((e) => e.name === 'post_job')).toHaveLength(1)
  })

  it('reacts to auth changes once started', async () => {
    const { ctx, live } = contextFixture()
    let signedIn = false
    let authListener: (() => void) | null = null
    const registrar = createRegistrar({
      tools: toolsFixture(),
      publicToolNames: PUBLIC_TOOL_NAMES,
      isSignedIn: () => signedIn,
      getModelContext: () => ctx,
      onAuthChange: (cb) => {
        authListener = cb
        return () => { authListener = null }
      },
    })

    registrar.start()
    expect(authListener).not.toBeNull()
    signedIn = true
    authListener!()
    await new Promise((r) => setTimeout(r, 0))
    expect(live.has('fund_escrow')).toBe(true)
    registrar.stop()
    expect(authListener).toBeNull()
  })

  it('is a harmless no-op when WebMCP is unavailable', async () => {
    const registrar = createRegistrar({
      tools: toolsFixture(),
      publicToolNames: PUBLIC_TOOL_NAMES,
      isSignedIn: () => true,
      getModelContext: () => null,
      onAuthChange: () => () => {},
    })
    await expect(registrar.sync()).resolves.toBeUndefined()
    registrar.stop()
  })

  it('stop() tears everything down', async () => {
    const { ctx, live } = contextFixture()
    const registrar = createRegistrar({
      tools: toolsFixture(),
      publicToolNames: PUBLIC_TOOL_NAMES,
      isSignedIn: () => true,
      getModelContext: () => ctx,
      onAuthChange: () => () => {},
    })
    await registrar.sync()
    expect(live.size).toBe(ALL_TOOL_NAMES.size)
    registrar.stop()
    // Every controller was aborted, so every signal is fired.
    for (const { signal } of live.values()) expect(signal?.aborted).toBe(true)
  })
})
