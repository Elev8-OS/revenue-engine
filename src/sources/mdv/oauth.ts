/**
 * MDV authorisation, discovery-driven.
 *
 * No endpoint paths are hardcoded. MDV publishes RFC 8414 metadata at
 * /.well-known/oauth-authorization-server, so the authorise, token and
 * revocation endpoints are read from the provider rather than guessed — which
 * means a path change on their side does not silently break us, and I did not
 * have to invent three URLs and hope.
 *
 * Two deliberate choices worth keeping:
 *
 *   1. READ SCOPES ONLY by default. Every lever ships in dry_run, but a flag
 *      prevents intent while a scope prevents capability. Until a lever
 *      actually goes live, a token that cannot write is strictly better than a
 *      token that is merely asked not to. Widening costs one re-authorisation.
 *
 *   2. PKCE even though MDV is a confidential client. OAuth 2.1 requires it,
 *      their metadata offers only S256, and it costs nothing.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { PoolClient } from 'pg'
import type { TokenResponse } from './auth.js'

/** Read everything, write nothing. Widen only when a lever leaves dry run. */
export const DEFAULT_SCOPES = [
  'read:properties', 'read:properties-private', 'read:pricing', 'read:promotions',
  'read:ranking', 'read:reviews', 'read:demand', 'read:compset', 'read:performance',
  'read:jobs', 'read:tags', 'read:webhooks', 'read:changelog',
].join(' ')

export interface Metadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  revocation_endpoint?: string
  registration_endpoint?: string
  code_challenge_methods_supported?: string[]
  token_endpoint_auth_methods_supported?: string[]
  scopes_supported?: string[]
}

let cached: { at: number, meta: Metadata } | undefined
const CACHE_MS = 60 * 60 * 1000

/**
 * Fetches and validates the provider metadata. Refuses rather than falling back
 * to a guess: a wrong token endpoint is the kind of failure that looks like bad
 * credentials and wastes an afternoon.
 */
export async function discover(issuer: string, now = Date.now): Promise<Metadata> {
  if (cached && now() - cached.at < CACHE_MS) return cached.meta
  const url = `${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`oauth discovery failed: ${res.status} at ${url}`)
  const meta = await res.json() as Metadata
  for (const field of ['authorization_endpoint', 'token_endpoint'] as const) {
    if (!meta[field]) throw new Error(`oauth discovery incomplete: missing ${field}`)
  }
  if (meta.code_challenge_methods_supported
      && !meta.code_challenge_methods_supported.includes('S256')) {
    throw new Error('provider does not support S256; refusing to fall back to plain')
  }
  cached = { at: now(), meta }
  return meta
}

/** Only for tests — the cache is otherwise process-lifetime. */
export function resetDiscoveryCache(): void { cached = undefined }

const b64url = (b: Buffer) => b.toString('base64url')
const challengeFor = (verifier: string) => b64url(createHash('sha256').update(verifier).digest())

export interface Started { url: string, state: string }

export async function begin(
  client: PoolClient,
  opts: {
    issuer: string, clientId: string, redirectUri: string
    scopes?: string, startedBy?: string
  },
): Promise<Started> {
  const meta = await discover(opts.issuer)
  const state = b64url(randomBytes(32))
  const verifier = b64url(randomBytes(64))   // 86 chars, inside the 43-128 range

  await client.query(
    `insert into oauth_flow (state, provider, code_verifier, redirect_uri, started_by, expires_at)
     values ($1, 'mdv', $2, $3, $4, now() + interval '10 minutes')`,
    [state, verifier, opts.redirectUri, opts.startedBy ?? null],
  )

  const url = new URL(meta.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('client_id', opts.clientId)
  url.searchParams.set('redirect_uri', opts.redirectUri)
  url.searchParams.set('scope', opts.scopes ?? DEFAULT_SCOPES)
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', challengeFor(verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  return { url: url.toString(), state }
}

export class FlowError extends Error {}

/**
 * Consumes the flow row and exchanges the code.
 *
 * The `where used_at is null` makes the exchange single-use, so a replayed
 * callback gets nothing rather than a second token.
 */
export async function complete(
  client: PoolClient,
  opts: { issuer: string, clientId: string, clientSecret: string, code: string, state: string },
): Promise<TokenResponse> {
  if (!opts.state || !opts.code) throw new FlowError('missing code or state')
  const { rows } = await client.query<{ code_verifier: string, redirect_uri: string }>(
    `update oauth_flow set used_at = now()
      where state = $1 and provider = 'mdv' and used_at is null and expires_at > now()
      returning code_verifier, redirect_uri`,
    [opts.state],
  )
  const flow = rows[0]
  if (!flow) throw new FlowError('unknown, expired or already-used state')

  const meta = await discover(opts.issuer)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: flow.redirect_uri,
    client_id: opts.clientId,
    code_verifier: flow.code_verifier,
  })
  // client_secret_post rather than basic: both are offered, and one fewer
  // encoding step is one fewer thing to get wrong with a secret in it.
  body.set('client_secret', opts.clientSecret)

  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    // The provider's error code, never the request body — it holds the secret.
    const text = await res.text().catch(() => '')
    const code = /"error"\s*:\s*"([a-z_]+)"/.exec(text)?.[1] ?? `http_${res.status}`
    throw new FlowError(`token exchange rejected: ${code}`)
  }
  const token = await res.json() as TokenResponse
  for (const f of ['access_token', 'refresh_token', 'expires_in'] as const) {
    if (!token[f]) throw new FlowError(`token response incomplete: missing ${f}`)
  }
  return token
}

/** Housekeeping for abandoned flows. */
export async function sweepFlows(client: PoolClient): Promise<void> {
  await client.query(`delete from oauth_flow where expires_at < now() - interval '1 day'`)
}

/** Constant-time state compare, for callers that hold an expected value. */
export function stateMatches(a: string, b: string): boolean {
  const x = createHash('sha256').update(a).digest()
  const y = createHash('sha256').update(b).digest()
  return timingSafeEqual(x, y)
}
