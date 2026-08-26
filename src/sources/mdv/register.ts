/**
 * Registering our own OAuth client, so this service owns its grant.
 *
 * THE PROBLEM THIS SOLVES, observed rather than anticipated. The engine adopted
 * the newly issued refresh token, ran an import, and rotated the chain. The next
 * call through the `mydatavalue-mcp` server answered `invalid_grant`: its copy
 * was a rotation behind. It works in both directions — whichever service
 * refreshes last leaves the other holding a spent token. Alternating breakage,
 * forever, with nothing wrong in either service.
 *
 * One grant cannot be shared. `auth.ts` said so in its header before any of this
 * happened, and named this as the resolution: RFC 7591 dynamic registration.
 * Two clients, two grants, neither able to spend the other's.
 *
 * MDV confirmed the route unprompted: "Register any client with any redirect URI
 * you like there, any time — no need to come to us." Which also retires two
 * standing problems: the redirect URI never needed their involvement, and the
 * self-registered client that expires on 9 September stops being a deadline
 * somebody has to remember.
 *
 * WHAT IS NEVER RETURNED FROM HERE: the client secret. It goes to the database
 * and nowhere else — not to a caller, not to a log line, not into the report.
 * The `client_id` is not a secret and is returned, because an operator needs to
 * be able to tell one registration from another.
 */
import type { PoolClient } from 'pg'
import { discover, DEFAULT_SCOPES } from './oauth.js'

export interface RegisteredClient {
  clientId: string
  redirectUri: string
  /** Whether a secret was issued, never what it is. */
  confidential: boolean
  secretExpiresAt: Date | null
  registeredAt: Date
}

export class RegistrationError extends Error {}

/**
 * RFC 7591. The request is deliberately minimal: one redirect URI, the
 * authorisation-code grant, and the scopes this service actually reads.
 *
 * `token_endpoint_auth_method` is not requested. The provider decides whether we
 * get a secret, and asking for a specific method is how a registration fails
 * with a message about something we did not need to have an opinion on.
 */
export async function registerClient(
  db: PoolClient,
  opts: {
    issuer: string
    redirectUri: string
    clientName: string
    scopes?: string
    provider?: string
    fetchImpl?: typeof fetch
  },
): Promise<RegisteredClient> {
  const provider = opts.provider ?? 'mdv'
  const fetchImpl = opts.fetchImpl ?? fetch
  const meta = await discover(opts.issuer)
  if (!meta.registration_endpoint) {
    throw new RegistrationError(
      'the provider advertises no registration_endpoint, so a client cannot be '
      + 'registered from here')
  }

  const res = await fetchImpl(meta.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: opts.clientName,
      redirect_uris: [opts.redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: opts.scopes ?? DEFAULT_SCOPES,
      application_type: 'web',
    }),
  })
  const body = await res.json().catch(() => null) as Record<string, unknown> | null
  if (!res.ok) {
    // The provider's own words, capped. Registration errors are usually about
    // the redirect URI or an unsupported grant, and both are actionable.
    const said = typeof body?.error_description === 'string' ? body.error_description
      : typeof body?.error === 'string' ? body.error : `http_${res.status}`
    throw new RegistrationError(`client registration refused: ${String(said).slice(0, 300)}`)
  }
  const clientId = typeof body?.client_id === 'string' ? body.client_id : ''
  if (!clientId) {
    throw new RegistrationError(
      `the registration response carried no client_id; keys seen: `
      + `${Object.keys(body ?? {}).join(', ') || 'none'}`)
  }
  const clientSecret = typeof body?.client_secret === 'string' ? body.client_secret : null

  /**
   * RFC 7591: `client_secret_expires_at` is seconds since the epoch, and ZERO
   * means "never expires". Stored as null rather than as 1970 — a date in the
   * past would read as an expired secret on every screen that shows it.
   */
  const rawExp = body?.client_secret_expires_at
  const secretExpiresAt = typeof rawExp === 'number' && rawExp > 0
    ? new Date(rawExp * 1000) : null

  const { rows } = await db.query<{ registered_at: Date }>(
    `insert into oauth_client
       (provider, client_id, client_secret, redirect_uri, secret_expires_at,
        registration_access_token, registration_client_uri, note)
     values ($1,$2,$3,$4,$5,$6,$7,$8)
     on conflict (provider) do update
       set client_id = excluded.client_id,
           client_secret = excluded.client_secret,
           redirect_uri = excluded.redirect_uri,
           registered_at = now(),
           secret_expires_at = excluded.secret_expires_at,
           registration_access_token = excluded.registration_access_token,
           registration_client_uri = excluded.registration_client_uri,
           note = excluded.note
     returning registered_at`,
    [provider, clientId, clientSecret, opts.redirectUri, secretExpiresAt,
     typeof body?.registration_access_token === 'string' ? body.registration_access_token : null,
     typeof body?.registration_client_uri === 'string' ? body.registration_client_uri : null,
     opts.clientName])

  return {
    clientId, redirectUri: opts.redirectUri,
    confidential: clientSecret !== null,
    secretExpiresAt,
    registeredAt: rows[0]!.registered_at,
  }
}

export interface ClientCredentials {
  clientId: string
  clientSecret: string | undefined
  redirectUri: string | null
  /** Which of the two this came from. The operationally important fact. */
  origin: 'own_registration' | 'configuration'
}

/**
 * The client this service should use, and where it came from.
 *
 * Our own registration WINS over the configured one, deliberately. The
 * configured client is shared with `mydatavalue-mcp` and every refresh on it
 * strands the other service; our own is ours alone. Once a registration exists,
 * continuing to prefer the variable would mean the fix existed and did nothing.
 *
 * Falling back to configuration rather than failing, because a registration can
 * be refused and a working shared client is better than no client — flaky beats
 * dead, as long as the page says which one is in use.
 */
export async function clientCredentials(
  db: PoolClient, provider = 'mdv', env = process.env,
): Promise<ClientCredentials | null> {
  const { rows } = await db.query<{
    client_id: string, client_secret: string | null, redirect_uri: string
  }>(`select client_id, client_secret, redirect_uri from oauth_client where provider = $1`,
     [provider])
  const own = rows[0]
  if (own) {
    return {
      clientId: own.client_id,
      clientSecret: own.client_secret ?? undefined,
      redirectUri: own.redirect_uri,
      origin: 'own_registration',
    }
  }
  const id = env.MDV_CLIENT_ID
  const secret = env.MDV_CLIENT_SECRET
  if (!id) return null
  return { clientId: id, clientSecret: secret, redirectUri: null, origin: 'configuration' }
}

/** For /status: what we hold, never the secret itself. */
export async function clientState(
  db: PoolClient, provider = 'mdv',
): Promise<{ clientId: string, confidential: boolean, registeredAt: Date,
             secretExpiresAt: Date | null, note: string | null } | null> {
  const { rows } = await db.query<{
    client_id: string, client_secret: string | null, registered_at: Date,
    secret_expires_at: Date | null, note: string | null
  }>(`select client_id, client_secret, registered_at, secret_expires_at, note
        from oauth_client where provider = $1`, [provider])
  const r = rows[0]
  return r ? {
    clientId: r.client_id, confidential: r.client_secret !== null,
    registeredAt: r.registered_at, secretExpiresAt: r.secret_expires_at, note: r.note,
  } : null
}
