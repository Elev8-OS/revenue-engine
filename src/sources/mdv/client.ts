/**
 * The concrete MDV transport: the refresh function `getAccessToken` expects, and
 * a rate-limited GET on top of it.
 *
 * `auth.ts` deliberately takes the refresh as an injected function so the
 * rotation and locking logic could be tested without a provider. This file is
 * the other half — the part that actually talks to MDV — and it is kept separate
 * so that custody logic and HTTP concerns cannot tangle.
 *
 * Three provider facts this encodes rather than assumes:
 *
 *   1. HTTP BASIC at the token endpoint. MDV's own instructions show
 *      `curl -u "client:secret"`. `client_secret_post` may well work too, but
 *      Basic is the one method we know they accept, so it is the one used.
 *
 *   2. 120 REQUESTS PER MINUTE, with Retry-After on 429. Stated by the
 *      provider — the only one of our four sources where the limit is a fact.
 *
 *   3. EVERY EXCHANGE ROTATES THE REFRESH TOKEN and a spent one is treated as
 *      stolen, revoking the whole grant. That is why nothing here refreshes
 *      outside `getAccessToken`, which holds an advisory lock while it does.
 */
import type { PoolClient } from 'pg'
import { getAccessToken, GrantRevokedError, type RefreshFn, type TokenResponse }
  from './auth.js'
import { RateBudget, LIMITS } from '../../scheduler/budget.js'

export const DEFAULT_BASE = 'https://app.mydatavalue.com/api/v1'
export const DEFAULT_TOKEN_URL = 'https://app.mydatavalue.com/oauth/token'

export class MdvError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

/**
 * RFC 6749 §2.3.1: the client id and secret are form-urlencoded BEFORE being
 * base64'd for Basic. Today's credentials are alphanumeric so it makes no
 * difference — which is exactly why it would be a mystery to debug on the day a
 * rotated secret contains a `+` or a `/`.
 */
const basic = (clientId: string, clientSecret: string) =>
  'Basic ' + Buffer.from(
    `${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`,
  ).toString('base64')

/** Extracts the provider's error code and nothing else — the body holds secrets. */
function errorCodeOf(text: string, status: number): string {
  return /"error"\s*:\s*"([a-z_]+)"/.exec(text)?.[1] ?? `http_${status}`
}

/**
 * Builds the refresh function for `getAccessToken`.
 *
 * The returned function is the only place a refresh token is ever sent, and it
 * returns the new one for the caller to persist under its lock. It deliberately
 * does not touch the database itself: one writer, in one file.
 */
export function makeRefresh(
  clientId: string, clientSecret: string, tokenUrl = DEFAULT_TOKEN_URL,
): RefreshFn {
  return async (refreshToken: string): Promise<TokenResponse> => {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        authorization: basic(clientId, clientSecret),
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refreshToken,
      }),
    })
    if (!res.ok) {
      const code = errorCodeOf(await res.text().catch(() => ''), res.status)
      // The message is matched on /invalid_grant/i by auth.ts, which marks the
      // grant revoked and stops retrying. Keep the code in the message.
      throw new MdvError(`mdv token refresh rejected: ${code}`, res.status)
    }
    const token = await res.json() as Partial<TokenResponse>
    for (const f of ['access_token', 'refresh_token', 'expires_in'] as const) {
      if (!token[f]) throw new MdvError(`mdv token response incomplete: missing ${f}`)
    }
    return token as TokenResponse
  }
}

/* ------------------------------------------------------------------ seeding */

export type SeedOutcome =
  /** There was no grant, and the configured token became rotation 0. */
  | 'seeded'
  /** A live grant already exists; the variable was ignored. */
  | 'kept_existing'
  /**
   * A revoked grant existed and the variable holds a DIFFERENT token, so a
   * human has clearly fetched a new one. The dead chain was replaced.
   */
  | 'reseeded'
  /**
   * A revoked grant exists and the variable still holds the very token that
   * died with it. Presenting it again would fail identically.
   */
  | 'kept_revoked'
  | 'not_configured'

/**
 * Stores a refresh token handed over out-of-band, ONCE per chain.
 *
 * The guard is the whole point. A seed variable stays set in the deployment
 * config, so every restart would re-run this — and by then the stored token has
 * rotated several times while the variable still holds the original. Presenting
 * that original is exactly what MDV treats as a stolen token, which revokes the
 * grant. So a LIVE grant is never touched, whatever the variable says.
 *
 * A REVOKED grant is the opposite case, and the first version of this function
 * got it wrong. It refused to re-seed on the reasoning that the seed value came
 * from the same dead chain — true, but only while the variable is unchanged.
 * The effect was a dead end: the grant died, and the one recovery route that
 * needs no registered redirect URI was closed by our own guard, so the operator
 * had nothing left to try.
 *
 * The distinction that actually matters is not live-versus-revoked but
 * SAME-VERSUS-DIFFERENT. A revoked grant holds nothing worth protecting, so a
 * token the operator has newly fetched replaces it. A token identical to the one
 * that died is refused — not because it is unsafe, but because it is futile,
 * and "kept_revoked" in the log says the variable was never updated.
 */
export async function seedRefreshToken(
  client: PoolClient,
  opts: { clientId: string, refreshToken: string | undefined, provider?: string },
): Promise<SeedOutcome> {
  const provider = opts.provider ?? 'mdv'
  if (!opts.refreshToken) return 'not_configured'
  const { rows } = await client.query<{ revoked_at: Date | null, refresh_token: string }>(
    'select revoked_at, refresh_token from oauth_token where provider = $1', [provider],
  )
  const existing = rows[0]
  if (existing) {
    if (!existing.revoked_at) return 'kept_existing'
    if (existing.refresh_token === opts.refreshToken) return 'kept_revoked'
    // Compared, never logged. Which token it is stays out of the audit trail;
    // that the operator supplied a new one is the whole entry.
    await client.query(
      `update oauth_token
          set client_id = $2, access_token = '', refresh_token = $3,
              access_expires_at = now() - interval '1 minute',
              rotation = 0, refreshed_at = now(),
              revoked_at = null, revoked_reason = null
        where provider = $1`,
      [provider, opts.clientId, opts.refreshToken],
    )
    await client.query(
      `insert into oauth_event (provider, event, rotation, detail)
       values ($1, 'refreshed', 0, 'reseeded from configuration after revocation')`,
      [provider],
    )
    return 'reseeded'
  }

  // access_expires_at in the past on purpose: we were given a refresh token and
  // no access token, so the first call must refresh. Writing a fake expiry in
  // the future would make the first API call fail with a 401 instead.
  await client.query(
    `insert into oauth_token
       (provider, client_id, access_token, refresh_token, access_expires_at, rotation)
     values ($1, $2, '', $3, now() - interval '1 minute', 0)`,
    [provider, opts.clientId, opts.refreshToken],
  )
  await client.query(
    `insert into oauth_event (provider, event, rotation, detail)
     values ($1, 'refreshed', 0, 'seeded from configuration')`, [provider],
  )
  return 'seeded'
}

/* -------------------------------------------------------------------- reads */

export interface MdvClientOptions {
  clientId: string
  clientSecret: string
  base?: string
  tokenUrl?: string
  budget?: RateBudget
  /** Bounded, because a provider that keeps saying 429 is telling us to stop. */
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
}

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)))

/** Retry-After is seconds or an HTTP date. Both appear in the wild. */
export function retryAfterMs(header: string | null, now = Date.now): number | null {
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(header)
  return Number.isNaN(at) ? null : Math.max(0, at - now())
}

export class MdvClient {
  private readonly budget: RateBudget
  private readonly base: string
  private readonly maxRetries: number
  private readonly sleep: (ms: number) => Promise<void>

  constructor(private readonly opts: MdvClientOptions) {
    this.budget = opts.budget ?? new RateBudget()
    this.base = (opts.base ?? DEFAULT_BASE).replace(/\/$/, '')
    this.maxRetries = opts.maxRetries ?? 3
    this.sleep = opts.sleep ?? wait
  }

  /**
   * One GET, with the access token, the rate budget, and the two failures worth
   * handling: a 429 we were told how long to wait for, and a 401 on a token we
   * believed was still valid.
   */
  async get<T>(
    client: PoolClient, path: string, params: Record<string, string | number> = {},
  ): Promise<T> {
    const url = new URL(`${this.base}/${path.replace(/^\//, '')}`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
    const refresh = makeRefresh(this.opts.clientId, this.opts.clientSecret, this.opts.tokenUrl)

    let forcedRefresh = false
    for (let attempt = 0; ; attempt++) {
      await this.budget.take('mdv', LIMITS.mdv!.perMinute)
      const token = await getAccessToken(client, refresh)
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })

      if (res.ok) return await res.json() as T

      if (res.status === 429 && attempt < this.maxRetries) {
        // Honour what they tell us; fall back to a linear back-off if they
        // tell us nothing. Never faster than the header asks.
        const ms = retryAfterMs(res.headers.get('retry-after')) ?? (attempt + 1) * 1_000
        await this.sleep(ms)
        continue
      }

      // A 401 on a token we thought was live: the server may have restarted or
      // revoked it. Expire our copy so the next pass refreshes under the lock,
      // and try exactly once. Twice would be a loop that spends refresh tokens.
      if (res.status === 401 && !forcedRefresh) {
        forcedRefresh = true
        await client.query(
          `update oauth_token set access_expires_at = now() - interval '1 minute'
            where provider = 'mdv'`)
        continue
      }

      const code = errorCodeOf(await res.text().catch(() => ''), res.status)
      throw new MdvError(`mdv GET ${path} failed: ${code}`, res.status)
    }
  }
}

export { GrantRevokedError }
