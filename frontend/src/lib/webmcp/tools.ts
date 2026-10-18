/**
 * tools.ts — Gigr WebMCP tool definitions (pure).
 *
 * Every tool here is a plain object that the registry hands to WebMCP's
 * imperative API (`document.modelContext.registerTool(def, { signal })`). The
 * `execute` functions run inside the user's already-open, already-authenticated
 * tab and reuse the app's real API layer, so an agent that calls a tool acts as
 * the logged-in user — there is no separate agent login to build.
 *
 * Nothing in this file touches the DOM, React, or the axios instance directly:
 * the API client and the current-user getter are injected (`deps`). That keeps
 * the whole surface unit-testable with a mock client.
 */

import { CURRENCIES, isCurrencyCode } from '@/lib/currency'

export interface ToolApi {
  get<T = unknown>(url: string, params?: Record<string, unknown>): Promise<T>
  post<T = unknown>(url: string, body?: unknown): Promise<T>
}

export interface CurrentUser {
  id: string
  display_name?: string | null
  email?: string | null
  is_verified?: boolean
  role?: string | null
}

export interface ToolDeps {
  api: ToolApi
  currentUser: () => CurrentUser | null
  /**
   * Optional: switch the user's DISPLAY currency (NGN default; stored/settled
   * amounts are always Naira). Used by the `set_display_currency` tool.
   */
  setDisplayCurrency?: (code: string) => void | Promise<unknown>
  /**
   * Optional: open a URL for the human (e.g. the PayPal approval page) in a new
   * tab. Best-effort — browsers may block popups outside a user gesture, so the
   * tool always returns the URL too.
   */
  openUrl?: (url: string) => void
  /** Optional: navigate to an app route (react-router-dom). */
  navigate?: (targetRoute: string) => void
}

export interface WebMCPTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  execute: (input: any) => unknown | Promise<unknown>
  annotations?: { readOnlyHint?: boolean }
}

// Tools that require a signed-in Gigr user. They are not just guarded at
// runtime — the registry only *registers* them once the user is logged in, so
// an agent on a logged-out session never even sees them in the tool list.
export const PUBLIC_TOOL_NAMES: ReadonlySet<string> = new Set([
  'get_auth_status',
  'get_user_location',
  'search_providers',
  'get_provider_reputation',
])

export const AUTHED_TOOL_NAMES: readonly string[] = [
  'post_job',
  'post_service',
  'get_job_status',
  'list_my_jobs',
  'fund_escrow',
  'get_payment_status',
  'release_escrow',
  'accept_job',
  'send_message',
  'get_notifications',
  'set_display_currency',
  'navigate_to',
  'scroll_into_view',
]

export const ALL_TOOL_NAMES: ReadonlySet<string> = new Set([...PUBLIC_TOOL_NAMES, ...AUTHED_TOOL_NAMES])

// ─── Small helpers ────────────────────────────────────────────────────────────

const ok = (payload: Record<string, unknown>) => ({ ok: true, ...payload })
const fail = (error: string) => ({ ok: false, error })

/** Pull a human-readable detail out of an axios-style error. */
function detailOf(err: unknown): string {
  const e = err as any
  const detail = e?.response?.data?.detail
  if (typeof detail === 'string' && detail) return detail
  const nested = e?.response?.data?.error?.message
  if (typeof nested === 'string' && nested) return nested
  return e?.message ? String(e.message) : 'Unknown error'
}

/** First line of defence for auth-gated tools (second line is registration gating). */
function requireUser(currentUser: CurrentUser | null):
  | { ok: true; user: CurrentUser }
  | { ok: false; error: string } {
  if (!currentUser) {
    return {
      ok: false,
      error:
        'Not signed in. Ask the user to sign in to Gigr (Google OAuth or email) first — ' +
        'payment and job tools are only enabled for a signed-in session.',
    }
  }
  return { ok: true, user: currentUser }
}

/** Match a category by name (e.g. "Plumbing") to its UUID, or pass a UUID through. */
async function resolveCategoryId(api: ToolApi, category?: unknown): Promise<string | undefined> {
  if (category == null || category === '') return undefined
  const raw = String(category)
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return raw
  const cats = await api.get<{ id: string; name: string }[]>('/categories')
  const hit = cats.find((c) => c.name.toLowerCase() === raw.toLowerCase())
  if (hit) return hit.id
  const available = cats.map((c) => c.name).join(', ')
  throw new Error(`Unknown category "${raw}". Known categories: ${available || 'none'}.`)
}

/** Slice a Job row down to the fields an agent can act on. */
function summarizeJob(job: any): Record<string, unknown> {
  return {
    id: String(job.id),
    title: job.title,
    status: job.status,
    price: job.price,
    client_id: String(job.client_id),
    provider_id: job.provider_id ? String(job.provider_id) : null,
    category_id: job.category_id ? String(job.category_id) : null,
    escrow_address: job.escrow_address ?? null,
    created_at: job.created_at ?? null,
  }
}

/**
 * A human/agent-readable read of a job's lifecycle, so an agent knows what it
 * can do next instead of fumbling with raw status strings.
 */
function jobLifecycle(job: any): Record<string, unknown> {
  const j = summarizeJob(job)
  const guide: Record<string, string> = {
    open: 'Waiting for a provider. A client can assign a provider (status becomes assigned), or a provider applies and the client assigns.',
    requested: 'A client requested a provider\'s service listing. The provider can accept this job (status becomes assigned).',
    assigned: 'Provider hired. The client can now fund the escrow (status becomes funded).',
    funded: 'Escrow is funded and held safely. The provider can submit work; the client can still release early.',
    in_progress: 'Provider submitted work. The client reviews — release the escrow or the job auto-releases when the review window ends.',
    completed: 'Payment released to the provider. The client can leave a rating/vouch.',
    cancelled: 'This job was cancelled.',
    disputed: 'This job is under dispute.',
  }
  return {
    ...j,
    next_actions: guide[job.status] ?? 'No further automated actions for this status.',
  }
}

function pickProviderProfile(p: any): Record<string, unknown> {
  return {
    id: String(p.id),
    display_name: p.display_name,
    profile_image_url: p.profile_image_url ?? null,
    is_verified: !!p.is_verified,
    avg_rating: p.avg_rating ?? null,
    rating_count: p.rating_count ?? 0,
    vouches_received_count: p.vouches_received_count ?? 0,
    skills: p.skills ?? [],
    bio: p.bio ?? null,
  }
}

/**
 * Ask the browser's Geolocation API for the device position, with a timeout so
 * a permission prompt / denial can't hang an agent call. Returns null when the
 * API is unavailable or the user declines.
 */
function getBrowserPosition(timeoutMs = 4000): Promise<{ latitude: number; longitude: number; accuracy: number } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || typeof navigator.geolocation === 'undefined') {
      resolve(null)
      return
    }
    const timer = globalThis.setTimeout(() => resolve(null), timeoutMs)
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          globalThis.clearTimeout(timer)
          resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy ?? 0 })
        },
        () => {
          globalThis.clearTimeout(timer)
          resolve(null)
        },
        { enableHighAccuracy: false, timeout: timeoutMs, maximumAge: 600_000 },
      )
    } catch {
      globalThis.clearTimeout(timer)
      resolve(null)
    }
  })
}

// ─── Tool factory ─────────────────────────────────────────────────────────────

export function createGigrWebMCPTools(deps: ToolDeps): WebMCPTool[] {
  const { api } = deps
  const me = () => deps.currentUser()

  // Which payment rail the server runs (PayPal, or the legacy Solana escrow).
  // Read once and remembered; if the config can't be read we assume the legacy
  // direct-fund path, which the server answers with a clear error on PayPal.
  let railPromise: Promise<'paypal' | 'solana'> | null = null
  const getRail = (): Promise<'paypal' | 'solana'> => {
    if (!railPromise) {
      railPromise = api
        .get<{ payment_rail?: string }>('/config/public')
        .then((cfg) => (cfg?.payment_rail === 'paypal' ? ('paypal' as const) : ('solana' as const)))
        .catch(() => 'solana' as const)
    }
    return railPromise
  }

  return [
    {
      name: 'get_auth_status',
      description:
        'Check whether the Gigr user is signed in and which WebMCP tools that unlocks. Call this first: if signed_in is false, ask the user to sign in (Google or email) before using account tools such as post_job, fund_escrow or release_escrow. Marketplace browsing (search_providers, get_provider_reputation) still works while signed out.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: () => {
        const u = me()
        const base: Record<string, unknown> = {
          signed_in: !!u,
          requires_sign_in: [...AUTHED_TOOL_NAMES],
          message: u
            ? 'Signed in. All Gigr tools are available.'
            : 'Not signed in. Only browsing tools are available. Ask the user to sign in before posting jobs or moving money.',
        }
        if (u) {
          base.user = {
            id: u.id,
            display_name: u.display_name ?? null,
            email: u.email ?? null,
            is_verified: !!u.is_verified,
            role: u.role ?? null,
          }
        }
        return base
      },
    },

    {
      name: 'get_user_location',
      description:
        'Automatically obtain the user\'s location WITHOUT asking them: returns their saved Gigr profile location when set, otherwise the browser GPS position. Call this before search_providers / post_job instead of requesting a city or address from the user. Returns { has_location, latitude, longitude, accuracy_m, source }.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => {
        // 1) The location the user saved in their Gigr profile (only when signed
        //    in) — fast, no permission prompt, and what the app already knows.
        let saved: { latitude: number; longitude: number } | null = null
        if (me()) {
          try {
            const u = await api.get<Record<string, unknown>>('/users/me')
            if (u?.location_lat != null && u?.location_lng != null) {
              saved = { latitude: Number(u.location_lat), longitude: Number(u.location_lng) }
            }
          } catch {
            saved = null
          }
        }
        if (saved) {
          return {
            ok: true,
            has_location: true,
            latitude: saved.latitude,
            longitude: saved.longitude,
            accuracy_m: null,
            source: 'saved_profile',
            message: `Location from the user's saved Gigr profile (${saved.latitude.toFixed(4)}, ${saved.longitude.toFixed(4)}).`,
          }
        }

        // 2) Fall back to the browser GPS when no saved location exists.
        const gps = await getBrowserPosition()
        if (gps) {
          return {
            ok: true,
            has_location: true,
            latitude: gps.latitude,
            longitude: gps.longitude,
            accuracy_m: gps.accuracy,
            source: 'browser_gps',
            message: `Live location from the browser GPS (${gps.latitude.toFixed(4)}, ${gps.longitude.toFixed(4)}).`,
          }
        }

        return {
          ok: true,
          has_location: false,
          latitude: null,
          longitude: null,
          source: null,
          message:
            'No location is available yet. The user needs to share their location once in the Gigr app (it saves to their profile) or grant browser location permission. Ask them to do that, then call get_user_location again.',
        }
      },
    },

    {
      name: 'search_providers',
      description:
        'Search Gigr for providers (and their service listings) to hire. Give a category ("Plumbing", "Cleaning", …) and/or free-text query. Call get_user_location first to fetch the user\'s coordinates automatically instead of asking for an address; with lat/lon the results are ranked by proximity (PostGIS). Returns each service listing plus its provider\'s name, verification and reputation snapshot. Prices are in Nigerian Naira (₦).',
      inputSchema: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Service category name, e.g. "Plumbing". Either this or query is recommended.' },
          query: { type: 'string', description: 'Free-text search across service titles/descriptions.' },
          latitude: { type: 'number', description: 'User latitude — enables proximity ranking.' },
          longitude: { type: 'number', description: 'User longitude — enables proximity ranking.' },
          radius_km: { type: 'number', description: 'Search radius in kilometres (default 10).' },
          limit: { type: 'number', description: 'Maximum results (default 10).' },
        },
      },
      annotations: { readOnlyHint: true },
      execute: async (input: any) => {
        let categoryId: string | undefined
        try {
          categoryId = await resolveCategoryId(api, input?.category)
        } catch (err) {
          return fail(detailOf(err))
        }

        let services: any[]
        try {
          if (input?.latitude != null && input?.longitude != null) {
            services = await api.get('/services/search/nearby', {
              lat: input.latitude,
              lon: input.longitude,
              radius: input.radius_km ?? 10,
              ...(categoryId ? { category_id: categoryId } : {}),
              limit: input.limit ?? 10,
            })
          } else {
            const q = input?.query || input?.category
            if (!q) {
              return fail('Provide latitude/longitude for a nearby search, or a category/query for a text search.')
            }
            services = await api.get('/services/search/text', { q, limit: input.limit ?? 10 })
          }
        } catch (err) {
          return fail(detailOf(err))
        }

        const results = await Promise.all(
          (services ?? []).slice(0, 10).map(async (svc) => {
            let provider: Record<string, unknown> | null = null
            try {
              provider = pickProviderProfile(await api.get(`/users/${svc.provider_id}`))
            } catch {
              provider = { id: String(svc.provider_id) }
            }
            return {
              service: {
                id: String(svc.id),
                provider_id: String(svc.provider_id),
                category_id: String(svc.category_id),
                title: svc.title,
                description: svc.description ?? null,
                price: svc.price,
                latitude: svc.latitude,
                longitude: svc.longitude,
                radius_km: svc.radius_km,
              },
              provider,
            }
          }),
        )
        return ok({ count: results.length, results })
      },
    },

    {
      name: 'get_provider_reputation',
      description:
        'Look up a provider\'s verifiable trust record before hiring: star-rating average/count plus the number of verified vouches (each tied to a completed, paid-out job — a PayPal payout, or a cNFT on the Solana rail) and the most recent ones with their proof ids. A strong verified-vouch count is more trustworthy than a star rating alone.',
      inputSchema: {
        type: 'object',
        properties: {
          provider_id: { type: 'string', description: 'Provider user UUID (from search_providers).' },
          max_vouches: { type: 'number', description: 'How many recent vouches to return (default 5).' },
        },
        required: ['provider_id'],
      },
      annotations: { readOnlyHint: true },
      execute: async (input: any) => {
        if (!input?.provider_id) return fail('provider_id is required (a user UUID from search_providers).')
        const pid = String(input.provider_id)
        let profile: any
        try {
          profile = await api.get(`/users/${pid}`)
        } catch (err) {
          return fail(detailOf(err))
        }
        let vouches: any[] = []
        try {
          vouches = await api.get(`/vouches/user/${pid}`)
        } catch {
          vouches = []
        }
        const recent = (Array.isArray(vouches) ? vouches : []).slice(0, Math.max(1, input?.max_vouches ?? 5)).map((v) => ({
          job_id: String(v.job_id),
          voucher_id: String(v.voucher_id),
          cnf_nft_id: v.cnf_nft_id ?? null,
          transaction_signature: v.transaction_signature ?? null,
          created_at: v.created_at ?? null,
        }))
        return ok({
          provider: pickProviderProfile(profile),
          recent_verified_vouches: recent,
          summary:
            `${profile.display_name} — ${profile.avg_rating != null ? profile.avg_rating + '/5 from ' + (profile.rating_count ?? 0) + ' rating(s)' : 'no star ratings yet'}, ` +
            `${profile.vouches_received_count ?? 0} verified vouch(es).`,
        })
      },
    },

    {
      name: 'post_job',
      description:
        'Create a new Gigr job listing on the user\'s behalf (status "open"): title, description, budget and optional category/location. Budget is in Nigerian Naira (₦). To fill in the location automatically, call get_user_location first and pass its latitude/longitude. After posting, providers near the job can find and apply to it. Returns the created job including its id — use get_job_status to follow it.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short job title, e.g. "Fix leaking kitchen sink".' },
          description: { type: 'string', description: 'What needs doing, in a sentence or two.' },
          price: { type: 'number', description: 'Budget in Nigerian Naira (₦), e.g. 15000.' },
          category: { type: 'string', description: 'Category name, e.g. "Plumbing". Optional but helps matching.' },
          min_price: { type: 'number', description: 'Optional lower end of a budget range (₦).' },
          max_price: { type: 'number', description: 'Optional upper end of a budget range (₦).' },
          latitude: { type: 'number', description: 'Optional job latitude.' },
          longitude: { type: 'number', description: 'Optional job longitude.' },
        },
        required: ['title', 'description', 'price'],
      },
      execute: async (input: any) => {
        const gate = requireUser(me())
        if (!gate.ok) return gate
        if (!input?.title || !input?.description) return fail('title and description are required.')
        if (input?.price == null || !Number.isFinite(Number(input.price)) || Number(input.price) <= 0) {
          return fail('price is required and must be a positive number (₦ Naira).')
        }
        let categoryId: string | undefined
        try {
          categoryId = await resolveCategoryId(api, input?.category)
        } catch (err) {
          return fail(detailOf(err))
        }
        const payload: Record<string, unknown> = {
          title: String(input.title),
          description: String(input.description),
          price: Number(input.price),
          ...(input.min_price != null && Number.isFinite(Number(input.min_price)) ? { min_price: Number(input.min_price) } : {}),
          ...(input.max_price != null && Number.isFinite(Number(input.max_price)) ? { max_price: Number(input.max_price) } : {}),
          ...(categoryId ? { category_id: categoryId } : {}),
          ...(input.latitude != null ? { latitude: Number(input.latitude) } : {}),
          ...(input.longitude != null ? { longitude: Number(input.longitude) } : {}),
        }
        try {
          const job = await api.post('/jobs/', payload)
          return {
            ...ok({ job: summarizeJob(job as any) }),
            note: 'Job is live and open. Nearby providers who match the category get notified.',
          }
        } catch (err) {
          return fail(detailOf(err))
        }
      },
    },

    {
      name: 'post_service',
      description:
        'Provider side — publish (or replace) a service the user OFFERS, so clients can find and hire them. This is the opposite of post_job: post_job hires someone, post_service says "hire me". Requires a title, a price in Nigerian Naira (₦), a category, and a location (call get_user_location first for coordinates). Use it when the user wants to be found for work, e.g. piano lessons.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Service title, e.g. "Piano lessons for beginners".' },
          description: { type: 'string', description: 'What the provider offers, in a sentence or two.' },
          price: { type: 'number', description: 'Price in Nigerian Naira (₦).' },
          category: { type: 'string', description: 'Category name, e.g. "Tutoring". Optional but recommended.' },
          min_price: { type: 'number', description: 'Optional lower end of a price range (₦).' },
          max_price: { type: 'number', description: 'Optional upper end of a price range (₦).' },
          latitude: { type: 'number', description: 'Service location latitude — call get_user_location to fill automatically.' },
          longitude: { type: 'number', description: 'Service location longitude — call get_user_location to fill automatically.' },
          radius_km: { type: 'number', description: 'How far the provider is willing to travel (default 5).' },
        },
        required: ['title', 'price'],
      },
      execute: async (input: any) => {
        const gate = requireUser(me())
        if (!gate.ok) return gate
        if (!input?.title) return fail('title is required.')
        if (input?.price == null || !Number.isFinite(Number(input.price)) || Number(input.price) <= 0) {
          return fail('price is required and must be a positive number (₦ Naira).')
        }
        if (input?.latitude == null || input?.longitude == null) {
          return fail('latitude and longitude are required for a provider listing — call get_user_location first to fetch the user\'s coordinates automatically.')
        }
        let categoryId: string | undefined
        try {
          categoryId = await resolveCategoryId(api, input?.category)
        } catch (err) {
          return fail(detailOf(err))
        }
        if (!categoryId) {
          return fail('A category is required for a provider listing (e.g. "Tutoring", "Music"). Pick one from get_categories.')
        }
        const payload: Record<string, unknown> = {
          category_id: categoryId,
          title: String(input.title),
          ...(input.description ? { description: String(input.description) } : {}),
          price: Number(input.price),
          ...(input.min_price != null && Number.isFinite(Number(input.min_price)) ? { min_price: Number(input.min_price) } : {}),
          ...(input.max_price != null && Number.isFinite(Number(input.max_price)) ? { max_price: Number(input.max_price) } : {}),
          latitude: Number(input.latitude),
          longitude: Number(input.longitude),
          radius_km: input.radius_km != null ? Number(input.radius_km) : 5,
        }
        try {
          const service = await api.post('/services/', payload)
          return {
            ...ok({
              service: {
                id: String((service as any).id),
                provider_id: String((service as any).provider_id),
                title: (service as any).title,
                price: (service as any).price,
                category_id: String((service as any).category_id),
              },
            }),
            note: 'Your service listing is live — clients searching this category near you can now find and hire you.',
          }
        } catch (err) {
          return fail(detailOf(err))
        }
      },
    },

    {
      name: 'get_job_status',
      description:
        'Get the current state of a job the user is involved in (posted, requested, assigned, funded, in_progress, completed, cancelled, disputed) plus what the next sensible action is. Use this to check the result of post_job, fund_escrow, accept_job or release_escrow, and to decide what to do next.',
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string', description: 'Job UUID.' } },
        required: ['job_id'],
      },
      annotations: { readOnlyHint: true },
      execute: async (input: any) => {
        const gate = requireUser(me())
        if (!gate.ok) return gate
        if (!input?.job_id) return fail('job_id is required.')
        try {
          const job = await api.get(`/jobs/${input.job_id}`)
          return ok(jobLifecycle(job as any))
        } catch (err) {
          return fail(detailOf(err))
        }
      },
    },

    {
      name: 'list_my_jobs',
      description:
        'List the user\'s own jobs — as the client who posted them or the provider who is doing them — optionally filtered by status (open, assigned, funded, in_progress, completed, cancelled). Call this before deciding which job to fund/release/message.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['client', 'provider'], description: 'Whether to list jobs the user posted (client) or is doing (provider).' },
          status: { type: 'string', description: 'Optional status filter, e.g. assigned, funded, in_progress.' },
        },
        required: ['role'],
      },
      annotations: { readOnlyHint: true },
      execute: async (input: any) => {
        const gate = requireUser(me())
        if (!gate.ok) return gate
        if (!input?.role || (input.role !== 'client' && input.role !== 'provider')) {
          return fail('role must be "client" or "provider".')
        }
        try {
          const jobs = await api.get('/jobs/', {
            my: input.role,
            ...(input.status ? { status: input.status } : {}),
            limit: 50,
          })
          return ok({ role: input.role, count: (jobs as any[]).length, jobs: (jobs as any[]).map(summarizeJob) })
        } catch (err) {
          return fail(detailOf(err))
        }
      },
    },

    {
      name: 'fund_escrow',
      description:
        'Fund a job\'s escrow (client side). A job must have a hired provider (status "assigned") first. On the PayPal rail this PREPARES the payment: it creates the PayPal checkout and returns an approval_url that the HUMAN must open to approve the charge — you can never move money without them. Show the user the amount and the link, then call get_payment_status / get_job_status after they approve. Idempotent: calling again reuses the same open checkout. For a job paid in stages, pass milestone_id to prepare the checkout for just that milestone (list them with get_payment_status) — each milestone is its own approval and its own payout.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Job UUID to fund. The user must be the client and the job must be assigned.' },
          milestone_id: { type: 'string', description: 'Optional. Fund only this milestone (staged payment) instead of the whole job.' },
        },
        required: ['job_id'],
      },
      execute: async (input: any) => {
        const gate = requireUser(me())
        if (!gate.ok) return gate
        if (!input?.job_id) return fail('job_id is required.')
        try {
          const job: any = await api.get(`/jobs/${input.job_id}`)
          if (!job.provider_id) {
            return fail(`Job "${job.title}" has no hired provider yet — a provider must be assigned before escrow can be funded.`)
          }
          const milestoneId = typeof input.milestone_id === 'string' && input.milestone_id ? input.milestone_id : null
          const fundable = milestoneId ? ['assigned', 'funded', 'in_progress'] : ['assigned', 'funded']
          if (!fundable.includes(job.status)) {
            return fail(`Job "${job.title}" is currently "${job.status}". Escrow can only be funded once a provider is hired (status "assigned").`)
          }

          if ((await getRail()) === 'paypal') {
            if (milestoneId) {
              const checkout: any = await api.post(`/jobs/${input.job_id}/milestones/${milestoneId}/paypal/checkout`)
              deps.openUrl?.(checkout.approval_url)
              return {
                ...ok({
                  job: summarizeJob(job),
                  milestone_id: milestoneId,
                  requires_human_approval: true,
                  approval_url: checkout.approval_url,
                  amount: checkout.amount,
                  currency: checkout.currency,
                  order_id: checkout.order_id,
                }),
                note:
                  `PayPal checkout ready for this milestone: ${checkout.amount} ${checkout.currency}. Nothing has been charged yet — ` +
                  'the user must open approval_url and approve it in PayPal. The money is then held for this milestone only; ' +
                  'the user releases it when that stage is done. Check with get_payment_status.',
              }
            }
            if (job.status === 'funded') {
              return ok({ job: summarizeJob(job), note: 'Escrow is already funded — the provider can work.' })
            }
            const checkout: any = await api.post(`/jobs/${input.job_id}/paypal/checkout`)
            deps.openUrl?.(checkout.approval_url)
            return {
              ...ok({
                job: summarizeJob(job),
                requires_human_approval: true,
                approval_url: checkout.approval_url,
                amount: checkout.amount,
                currency: checkout.currency,
                order_id: checkout.order_id,
              }),
              note:
                `PayPal checkout ready for ${checkout.amount} ${checkout.currency}. Nothing has been charged yet — ` +
                'the user must open approval_url and approve the payment in PayPal. Once they do, the money is held in escrow ' +
                'and the job becomes "funded". Check with get_payment_status.',
            }
          }

          const funded = await api.post(`/jobs/${input.job_id}/fund`)
          return {
            ...ok({ job: summarizeJob(funded as any) }),
            note: 'Escrow funded on Solana (USDC). The provider can now start work.',
          }
        } catch (err) {
          return fail(detailOf(err))
        }
      },
    },

    {
      name: 'get_payment_status',
      description:
        'Where the money for a job is right now (PayPal rail): unfunded, awaiting_approval (checkout created, human has not approved yet), escrowed (held), released (paid out to the provider) or refunded — with the PayPal transaction ids and a step-by-step ledger. Use after fund_escrow to confirm the human approved, and before release_escrow.',
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string', description: 'Job UUID. The user must be its client or provider.' } },
        required: ['job_id'],
      },
      annotations: { readOnlyHint: true },
      execute: async (input: any) => {
        const gate = requireUser(me())
        if (!gate.ok) return gate
        if (!input?.job_id) return fail('job_id is required.')
        try {
          const p: any = await api.get(`/jobs/${input.job_id}/payment`)
          const guide: Record<string, string> = {
            unfunded: 'Nothing is in escrow. If the job is assigned, call fund_escrow.',
            awaiting_approval: 'A PayPal checkout exists but the client has not approved it yet. Ask them to open the approval link.',
            escrowed: 'Funds are held safely in escrow. The client can release them when the work is done.',
            released: 'The escrow was paid out to the provider.',
            refunded: 'The escrow was refunded to the client.',
          }
          const staged: any[] = Array.isArray(p.milestones) ? p.milestones : []
          return ok({
            state: p.state,
            ...(staged.length
              ? { milestones: staged, staged_payment: true }
              : {}),
            amount: p.amount,
            currency: p.currency,
            payout_status: p.payout_status,
            paypal: { order_id: p.order_id, capture_id: p.capture_id, payout_batch_id: p.payout_batch_id },
            ledger: p.events,
            next_actions: staged.length
              ? 'This job is paid in stages. Each milestone has its own status (pending → funded → released). Fund the next pending one with fund_escrow + milestone_id; the client releases each stage when it is done.'
              : guide[p.state] ?? '',
          })
        } catch (err) {
          return fail(detailOf(err))
        }
      },
    },

    {
      name: 'release_escrow',
      description:
        'Release a funded job\'s escrow so the provider gets paid (client side). The job must be funded or have work submitted (status funded/in_progress); if it is already completed the payment was already released. Only the job\'s client can call this. This is the final step of the trust loop — funds leave the escrow and are paid to the provider (a PayPal payout on the PayPal rail). Irreversible: only call when the user has explicitly said the work is done and to pay.',
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string', description: 'Job UUID to release. The user must be the client.' } },
        required: ['job_id'],
      },
      execute: async (input: any) => {
        const gate = requireUser(me())
        if (!gate.ok) return gate
        if (!input?.job_id) return fail('job_id is required.')
        try {
          const job: any = await api.get(`/jobs/${input.job_id}`)
          if (job.status === 'completed') {
            return ok({ job: summarizeJob(job), note: 'This job is already completed — payment was released.' })
          }
          if (job.status !== 'funded' && job.status !== 'in_progress') {
            return fail(`Job "${job.title}" is "${job.status}". Release only makes sense once the escrow is funded (assigned work is underway or submitted).`)
          }
          const released = await api.post(`/jobs/${input.job_id}/release`)
          return {
            ...ok({ job: summarizeJob(released as any) }),
            note: 'Escrow released — the provider has been paid. Job marked completed.',
            payout_status: (released as any).paypal_payout_status ?? null,
          }
        } catch (err) {
          return fail(detailOf(err))
        }
      },
    },

    {
      name: 'accept_job',
      description:
        'Provider side: accept a job request. When a client requests one of the user\'s service listings the job is "requested"; this accepts it so the client can fund the escrow (status becomes "assigned"). Only the job\'s provider can accept. For open marketplace jobs the provider applies or waits to be assigned instead.',
      inputSchema: {
        type: 'object',
        properties: { job_id: { type: 'string', description: 'Job UUID to accept. The user must be the job\'s provider.' } },
        required: ['job_id'],
      },
      execute: async (input: any) => {
        const gate = requireUser(me())
        if (!gate.ok) return gate
        if (!input?.job_id) return fail('job_id is required.')
        try {
          const job: any = await api.get(`/jobs/${input.job_id}`)
          if (job.status !== 'requested') {
            return fail(`Job "${job.title}" is "${job.status}", not "requested" — only requested service requests can be accepted here.`)
          }
          const accepted = await api.post(`/jobs/${input.job_id}/accept-request`)
          return {
            ...ok({ job: summarizeJob(accepted as any) }),
            note: 'Accepted. The client is notified and can now fund the escrow.',
          }
        } catch (err) {
          return fail(detailOf(err))
        }
      },
    },

    {
      name: 'send_message',
      description:
        'Post a message into a job\'s Contract Room chat (the client ↔ provider thread). The user must be a participant in the job. Use it to confirm scope, send an update, or nudge the other side to fund/release.',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: { type: 'string', description: 'Job UUID whose chat room to post into.' },
          content: { type: 'string', description: 'Message text.' },
        },
        required: ['job_id', 'content'],
      },
      execute: async (input: any) => {
        const gate = requireUser(me())
        if (!gate.ok) return gate
        if (!input?.job_id) return fail('job_id is required.')
        if (!input?.content || !String(input.content).trim()) return fail('content is required.')
        try {
          const message = await api.post('/messages/', { job_id: input.job_id, content: String(input.content) })
          return ok({
            message_id: String((message as any).id),
            sent: true,
            note: 'Message posted to the job chat room.',
          })
        } catch (err) {
          return fail(detailOf(err))
        }
      },
    },

    {
      name: 'get_notifications',
      description:
        'Fetch the user\'s latest in-app notifications (escrow funded, work submitted, new message, job matched, etc.) with read state. Lets the agent report what has happened since the user last looked.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      execute: async () => {
        const gate = requireUser(me())
        if (!gate.ok) return gate
        try {
          const items = (await api.get('/notifications')) as any[]
          return ok({
            unread_count: items.filter((n) => !n.is_read).length,
            notifications: items.map((n) => ({
              id: String(n.id),
              title: n.title,
              message: n.message,
              type: n.type ?? 'system',
              link: n.link ?? null,
              is_read: !!n.is_read,
              created_at: n.created_at ?? null,
            })),
          })
        } catch (err) {
          return fail(detailOf(err))
        }
      },
    },

    {
      name: 'set_display_currency',
      description:
        'Change the currency Gigr DISPLAYS prices in for the signed-in user. This is a display-only setting (default NGN): every job is still priced, escrowed and settled in Nigerian Naira (₦) — only the on-screen formatting converts to the chosen currency. Call it with a supported code (USD, GBP, EUR). The app reloads with the new currency applied.',
      inputSchema: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            enum: CURRENCIES.map((c) => c.code),
            description: 'Display currency code to switch to.',
          },
        },
        required: ['code'],
      },
      execute: async (input: any) => {
        const gate = requireUser(me())
        if (!gate.ok) return gate
        const code = String(input?.code ?? '').trim().toUpperCase()
        if (!isCurrencyCode(code)) {
          return fail(`Unknown currency "${input?.code}". Supported: ${CURRENCIES.map((c) => c.code).join(', ')}.`)
        }
        if (!deps.setDisplayCurrency) {
          return fail('Changing the display currency is not available in this context.')
        }
        try {
          await deps.setDisplayCurrency(code)
          return ok({
            display_currency: code,
            note:
              code === 'NGN'
                ? 'Display currency set to Nigerian Naira (default).'
                : `Display currency set to ${code}. Prices are now shown converted from Naira; stored/settled amounts are unchanged.`,
          })
        } catch (err) {
          return fail(detailOf(err))
        }
      },
    },

    {
      name: 'navigate_to',
      description:
        'Navigate the app to a specific route without a full page reload. Use this to send the user to the right section (jobs, services, explore map, messages, profile, etc.) before or after completing another tool call.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              'App route path. Examples: "/dashboard", "/dashboard/explore", "/dashboard/jobs", "/dashboard/services", "/dashboard/messages", "/dashboard/profile".',
          },
        },
        required: ['path'],
      },
      execute: (inputParams: { path?: string }) => {
        const inputRoute = String(inputParams?.path ?? '').trim()
        if (!inputRoute) return fail('path is required.')
        if (!inputRoute.startsWith('/')) return fail('path must start with "/".')
        if (!deps.navigate) return fail('Navigation is not available in this context.')
        deps.navigate(inputRoute)
        return ok({ navigated: true, path: inputRoute })
      },
    },

    {
      name: 'scroll_into_view',
      description:
        'Scroll a DOM element into the visible viewport using a CSS selector. Useful for drawing attention to a specific UI section after navigating. Silently no-ops if the selector does not match.',
      inputSchema: {
        type: 'object',
        properties: {
          selector: {
            type: 'string',
            description:
              'CSS selector for the element to scroll to. Examples: "#job-card-123", "[data-agent-panel]", ".map-explorer".',
          },
          behavior: {
            type: 'string',
            enum: ['smooth', 'instant'],
            description: 'Scroll behaviour. Defaults to "smooth".',
          },
        },
        required: ['selector'],
      },
      annotations: { readOnlyHint: false },
      execute: (inputParams: { selector?: string; behavior?: 'smooth' | 'instant' }) => {
        const targetSelector = String(inputParams?.selector ?? '').trim()
        if (!targetSelector) return fail('selector is required.')
        if (typeof document === 'undefined') {
          return ok({ scrolled: false, note: 'DOM document is not available in this environment.' })
        }
        try {
          const selectedElement = document.querySelector(targetSelector)
          if (!selectedElement) return ok({ scrolled: false, note: `No element matched "${targetSelector}".` })
          selectedElement.scrollIntoView({
            behavior: inputParams?.behavior === 'instant' ? 'instant' : 'smooth',
            block: 'nearest',
          })
          return ok({ scrolled: true, selector: targetSelector })
        } catch (scrollErr) {
          return fail(scrollErr instanceof Error ? scrollErr.message : 'Scroll failed.')
        }
      },
    },
  ]
}
