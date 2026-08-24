/**
 * Elev8 authentication — deliberately two modes, because which one we get is an
 * open question and the answer changes who has to do what.
 *
 *   'apikey'  A single header, no expiry, nothing to store. Elev8 has an
 *             API-key mechanism (/api/v1/admin/mcp-api-key,
 *             /api/v1/tenant/claude-api-key) and the MCP path demonstrably
 *             works with one. Whether that key is accepted on /api/v1/* REST is
 *             unconfirmed. If it is, this is the whole file's job done in one
 *             header and nobody needs a service account.
 *
 *   'jwt'     POST /api/v1/auth/login with an address and a password. That is a
 *             service account: it expires, it can be locked out, and it is a
 *             password. The fallback, not the preference.
 *
 * The mode is chosen by which variables are set, and `/status` reports which one
 * is live — so "we are running on a password" is never a quiet state.
 *
 * The custody here is deliberately MUCH simpler than MDV's, and the difference
 * is the point. An MDV refresh token is single-use and a spent one revokes the
 * grant, so refreshing is mutually exclusive and a race loses the integration.
 * An Elev8 login is idempotent and free: logging in twice concurrently wastes
 * one request. So this still serialises — a hundred workers stampeding a login
 * endpoint is rude and looks like an attack — but a lost race here is a wasted
 * request, not an outage, and the code should not pretend otherwise.
 */
import type { PoolClient } from 'pg'

/** Re-login this long before expiry so an in-flight request never races it. */
const SKEW_SECONDS = 300

/**
 * Elev8 does not document the JWT lifetime. Used only when the login response
 * carries no expiry of its own: short enough that a stale token is corrected
 * quickly, long enough that we are not logging in every minute.
 */
const ASSUMED_TTL_SECONDS = 30 * 60

const LOCK_KEY = 918_273_642 // neighbour of MDV's, deliberately distinct

export class Elev8AuthError extends Error {
  constructor(message: string, readonly status?: number) {
    super(`elev8 login failed: ${message}`)
  }
}

export type Elev8Auth =
  | { mode: 'apikey', apiKey: string }
  | { mode: 'jwt', email: string, password: string }

/**
 * Resolves the mode from the environment. Never returns a partially configured
 * JWT mode: an address without a password is a misconfiguration, and silently
 * falling through to "unconfigured" would hide it.
 */
export function authFromEnv(env: NodeJS.ProcessEnv = process.env):
  { auth: Elev8Auth } | { auth: null, reason: string } {
  const key = env.ELEV8_API_TOKEN?.trim()
  if (key) return { auth: { mode: 'apikey', apiKey: key } }
  const email = env.ELEV8_LOGIN_EMAIL?.trim()
  const password = env.ELEV8_LOGIN_PASSWORD
  if (email && password) return { auth: { mode: 'jwt', email, password } }
  if (email || password) {
    return { auth: null, reason: 'ELEV8_LOGIN_EMAIL and ELEV8_LOGIN_PASSWORD must be set together' }
  }
  return { auth: null, reason: 'no ELEV8_API_TOKEN and no ELEV8_LOGIN_EMAIL/PASSWORD' }
}

export interface LoginResult {
  token: string
  /** Seconds, where the provider says. Absent is normal and handled. */
  expiresIn?: number
}

/** Injected so the lock and expiry logic are testable without a provider. */
export type LoginFn = (email: string, password: string) => Promise<LoginResult>

interface SessionRow { token: string, expires_at: Date }

async function read(client: PoolClient, provider: string): Promise<SessionRow | undefined> {
  const { rows } = await client.query<SessionRow>(
    'select token, expires_at from service_session where provider = $1', [provider],
  )
  return rows[0]
}

const stillValid = (row: SessionRow, now: Date) =>
  row.expires_at.getTime() - now.getTime() > SKEW_SECONDS * 1000

/**
 * Returns a usable bearer token, logging in only when the stored one is spent.
 *
 * Never logs the token or the password. A failure records the provider's message
 * and a counter, because "the Elev8 login has failed 14 times" is the sentence
 * an operator needs and neither half of it is a secret.
 */
export async function getServiceToken(
  client: PoolClient,
  login: LoginFn,
  credentials: { email: string, password: string },
  provider = 'elev8',
  now: () => Date = () => new Date(),
): Promise<string> {
  const before = await read(client, provider)
  if (before && stillValid(before, now())) return before.token

  await client.query('select pg_advisory_lock($1)', [LOCK_KEY])
  try {
    // Re-read inside the lock: whoever we waited for has very likely just
    // logged in, and using their token is the reason for waiting.
    const row = await read(client, provider)
    if (row && stillValid(row, now())) return row.token

    let result: LoginResult
    try {
      result = await login(credentials.email, credentials.password)
    } catch (err) {
      const message = (err as Error).message
      // Recorded, not swallowed. An unrecorded login failure looks identical to
      // "nobody has tried yet", and those need opposite responses.
      await client.query(
        `insert into service_session (provider, token, expires_at, last_error, failures)
         values ($1, '', now() - interval '1 minute', $2, 1)
         on conflict (provider) do update
           set last_error = excluded.last_error, failures = service_session.failures + 1`,
        [provider, message],
      )
      throw err
    }

    const ttl = result.expiresIn && result.expiresIn > 0 ? result.expiresIn : ASSUMED_TTL_SECONDS
    const expiresAt = new Date(now().getTime() + ttl * 1000)
    await client.query(
      `insert into service_session (provider, token, expires_at, obtained_at, last_error, failures)
       values ($1, $2, $3, now(), null, 0)
       on conflict (provider) do update
         set token = excluded.token, expires_at = excluded.expires_at,
             obtained_at = now(), last_error = null, failures = 0`,
      [provider, result.token, expiresAt],
    )
    return result.token
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY])
  }
}

/** For /status: the login state, with no token in it. */
export async function sessionState(
  client: PoolClient, provider = 'elev8',
): Promise<{ present: boolean, expiresAt?: Date, lastError?: string, failures: number }> {
  const { rows } = await client.query<{
    expires_at: Date, last_error: string | null, failures: number, token: string
  }>(`select expires_at, last_error, failures, token from service_session where provider = $1`,
     [provider])
  const row = rows[0]
  if (!row) return { present: false, failures: 0 }
  return {
    // A row written by a failed login holds an empty token. It exists to carry
    // the error, so it must not read as a session.
    present: row.token !== '',
    expiresAt: row.expires_at,
    lastError: row.last_error ?? undefined,
    failures: row.failures,
  }
}
