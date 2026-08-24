/**
 * The Elev8 transport.
 *
 * Three things here are honest unknowns rather than settled facts, and each is
 * handled as an unknown instead of guessed into a constant:
 *
 *   1. THE RATE LIMIT is undocumented. `LIMITS.elev8` is 30/min — the strictest
 *      assumption of the four sources, chosen because being slow is recoverable
 *      and being throttled out of a portfolio-wide pass is not. It stays a guess
 *      until something measures it.
 *
 *   2. THE ENVELOPE is documented for the Partner API as
 *      `{status, data, total, per_page, current_page, last_page}`. Whether the
 *      Internal API wraps the same way is unconfirmed, so `unwrap` accepts both
 *      a wrapped body and a bare array, and REPORTS which it found. A transport
 *      that silently coped with either shape would hide a real difference.
 *
 *   3. THE ERROR VOCABULARY is `{status: "FAILED", message}` in the Partner
 *      docs. HTTP status is trusted first, because a proxy or gateway failure
 *      never produces that body at all.
 *
 * What is NOT a guess: the auth headers. `X-Api-Key` for the Partner and Report
 * zones and `Authorization: Bearer` for the Internal zone are both stated.
 */
import type { PoolClient } from 'pg'
import { RateBudget, LIMITS } from '../../scheduler/budget.js'
import { getServiceToken, type Elev8Auth, type LoginFn, Elev8AuthError } from './auth.js'

export const DEFAULT_BASE = 'https://api.elev8-suite.com'

export class Elev8Error extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

/** The provider's own message is untrusted text; only its shape is read. */
function messageOf(body: unknown, status: number): string {
  if (body && typeof body === 'object' && 'message' in body) {
    const m = (body as { message?: unknown }).message
    if (typeof m === 'string' && m.length < 300) return m
  }
  return `http_${status}`
}

export interface Envelope<T> {
  data: T
  /** Which shape the body actually had. Recorded, never assumed. */
  envelope: 'wrapped' | 'bare'
  page?: { total?: number, perPage?: number, current?: number, last?: number }
}

/**
 * Separates the payload from the wrapper without deciding in advance that there
 * is one. Exported because the shape prober needs exactly this and must not
 * re-implement it differently.
 */
export function unwrap<T>(body: unknown): Envelope<T> {
  if (Array.isArray(body)) return { data: body as T, envelope: 'bare' }
  if (body && typeof body === 'object' && 'data' in body) {
    const o = body as Record<string, unknown>
    const num = (k: string) => typeof o[k] === 'number' ? o[k] as number : undefined
    return {
      data: o.data as T,
      envelope: 'wrapped',
      page: {
        total: num('total'), perPage: num('per_page'),
        current: num('current_page'), last: num('last_page'),
      },
    }
  }
  // An object with no `data` is the payload itself — a detail endpoint that
  // returns the object directly. Reported as bare so the difference is visible.
  return { data: body as T, envelope: 'bare' }
}

export interface Elev8ClientOptions {
  auth: Elev8Auth
  base?: string
  login?: LoginFn
  budget?: RateBudget
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
  fetchImpl?: typeof fetch
}

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)))

/** The default login, against the one documented auth endpoint. */
export function makeLogin(base = DEFAULT_BASE, fetchImpl: typeof fetch = fetch): LoginFn {
  return async (email, password) => {
    const res = await fetchImpl(`${base.replace(/\/$/, '')}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    })
    const body = await res.json().catch(() => null) as unknown
    if (!res.ok) throw new Elev8AuthError(messageOf(body, res.status), res.status)
    const { data } = unwrap<Record<string, unknown>>(body)
    // The login response field name is not documented. These are the candidates
    // an auth endpoint plausibly uses; the one that matched is not guessed at
    // read time, it is found once here and the failure is explicit.
    const src = (data ?? body) as Record<string, unknown>
    for (const k of ['token', 'access_token', 'accessToken', 'jwt']) {
      const v = src?.[k]
      if (typeof v === 'string' && v.length > 20) {
        const exp = src.expires_in ?? src.expiresIn
        return { token: v, expiresIn: typeof exp === 'number' ? exp : undefined }
      }
    }
    // Naming the keys we DID see is the difference between a five-minute fix and
    // an evening of guessing. Key names are not secrets; values are, and none
    // are included.
    throw new Elev8AuthError(
      `no token field in the login response; keys seen: ${Object.keys(src ?? {}).join(', ') || 'none'}`,
      res.status,
    )
  }
}

export class Elev8Client {
  private readonly budget: RateBudget
  private readonly base: string
  private readonly maxRetries: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly fetchImpl: typeof fetch
  private readonly login: LoginFn

  constructor(private readonly opts: Elev8ClientOptions) {
    this.budget = opts.budget ?? new RateBudget()
    this.base = (opts.base ?? DEFAULT_BASE).replace(/\/$/, '')
    this.maxRetries = opts.maxRetries ?? 2
    this.sleep = opts.sleep ?? wait
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.login = opts.login ?? makeLogin(this.base, this.fetchImpl)
  }

  /** Which mode is live, for /status. No credential in it. */
  get mode(): Elev8Auth['mode'] { return this.opts.auth.mode }

  private async headers(client: PoolClient): Promise<Record<string, string>> {
    if (this.opts.auth.mode === 'apikey') {
      return { 'X-Api-Key': this.opts.auth.apiKey }
    }
    const token = await getServiceToken(client, this.login, {
      email: this.opts.auth.email, password: this.opts.auth.password,
    })
    return { authorization: `Bearer ${token}` }
  }

  /**
   * One GET. Returns the envelope rather than the bare payload so callers can
   * see how the body was shaped and page when there is paging.
   */
  async get<T>(
    client: PoolClient, path: string, params: Record<string, string | number> = {},
  ): Promise<Envelope<T>> {
    const url = new URL(`${this.base}/${path.replace(/^\//, '')}`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))

    let forcedLogin = false
    for (let attempt = 0; ; attempt++) {
      await this.budget.take('elev8', LIMITS.elev8!.perMinute)
      const res = await this.fetchImpl(url, { headers: await this.headers(client) })

      if (res.ok) return unwrap<T>(await res.json())

      // 429 with no documented limit: the provider is telling us what the
      // documentation does not. Honour Retry-After, else back off linearly.
      if (res.status === 429 && attempt < this.maxRetries) {
        const ra = Number(res.headers.get('retry-after'))
        await this.sleep(Number.isFinite(ra) ? ra * 1000 : (attempt + 1) * 2_000)
        continue
      }

      // A 401 on a token we believed live: expire ours and log in exactly once.
      // Only meaningful in jwt mode — a rejected API key will not improve on a
      // retry, and retrying it would just be a second rejection.
      if (res.status === 401 && !forcedLogin && this.opts.auth.mode === 'jwt') {
        forcedLogin = true
        await client.query(
          `update service_session set expires_at = now() - interval '1 minute'
            where provider = 'elev8'`)
        continue
      }

      const body = await res.json().catch(() => null) as unknown
      throw new Elev8Error(`elev8 GET ${path} failed: ${messageOf(body, res.status)}`, res.status)
    }
  }

  /**
   * Walks a paged list to the end.
   *
   * Bounded by `maxPages` rather than trusting `last_page`: a provider that
   * reports paging inconsistently would otherwise loop, and an unbounded loop
   * against an undocumented rate limit is the worst combination available.
   */
  async getAll<T>(
    client: PoolClient, path: string,
    params: Record<string, string | number> = {},
    { perPage = 100, maxPages = 20 } = {},
  ): Promise<T[]> {
    const out: T[] = []
    for (let page = 1; page <= maxPages; page++) {
      const res = await this.get<T[]>(client, path, { ...params, page, per_page: perPage })
      const rows = Array.isArray(res.data) ? res.data : []
      out.push(...rows)
      // Stop on a short page as well as on last_page: the short page is true
      // whether or not the provider reports paging at all.
      if (rows.length < perPage) break
      if (res.page?.last && page >= res.page.last) break
    }
    return out
  }
}
