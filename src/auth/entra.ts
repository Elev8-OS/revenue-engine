/**
 * Anmeldung mit Microsoft Entra ID — the identity service behind Microsoft 365.
 *
 * Why this replaces the magic link: a magic link needs a mail provider we do not
 * have, it grants access to whoever holds the mail, and it knows nothing about
 * whether the person still works here. Entra already knows all three. Access
 * follows the Microsoft 365 account, so MFA and conditional access come along
 * for free and revocation happens the day the account is disabled — not the day
 * somebody remembers to edit a variable.
 *
 * Four things this module refuses to be sloppy about:
 *
 *   1. TENANT-SPECIFIC DISCOVERY. The `organizations` and `common` endpoints
 *      publish `issuer` as the literal string ".../{tenantid}/v2.0" — a template,
 *      not a value. Against those, `iss` cannot be checked, and any Microsoft
 *      work account on earth can sign in. We discover per tenant so the issuer
 *      is concrete and comparable.
 *
 *   2. THE SIGNATURE IS VERIFIED. OIDC §3.1.3.7 permits skipping it when the
 *      token came over TLS straight from the token endpoint, which is our case.
 *      It is verified anyway: it is forty lines, and it means nobody later has
 *      to reconstruct that argument to know whether this is safe.
 *
 *   3. RS256 ONLY, kid REQUIRED. `alg` comes from the token, so an attacker
 *      picks it. "none" and the HMAC families are refused outright rather than
 *      handled.
 *
 *   4. THE NONCE IS CONSUMED, NOT COMPARED. It lives in the same single-use
 *      oauth_flow row as the PKCE verifier, so a replayed callback finds
 *      nothing to compare against instead of comparing successfully.
 */
import { createHash, createPublicKey, randomBytes, verify as verifySignature }
  from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import type { PoolClient } from 'pg'

/**
 * The Elev8-Suite tenant. Not a secret: anyone can resolve it from the domain
 * name, which is exactly how it was obtained. It is a default rather than a
 * constant so a second tenant needs a variable, not a deploy.
 */
export const ELEV8_TENANT_ID = '64016497-9666-4672-9a7d-82e3a198ad0f'

/** Everything we need about the person, and nothing we do not. */
export interface Identity {
  email: string
  name: string
  /** Stable per person per tenant; survives a rename, unlike the address. */
  subjectId: string
  tenantId: string
  /**
   * Entra group object IDs from the `groups` claim. Empty can mean two very
   * different things — not in any group, or the claim was never configured —
   * which is why `groupsEmitted` exists separately.
   */
  groups: string[]
  /** True when the token carried a `groups` claim at all, even an empty one. */
  groupsEmitted: boolean
  /**
   * True when the person is in more than 200 groups, so Entra replaced the
   * claim with a pointer to Graph instead of listing them.
   */
  groupsOverage: boolean
}

export interface OidcMetadata {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  jwks_uri: string
  end_session_endpoint?: string
  id_token_signing_alg_values_supported?: string[]
}

export interface EntraConfig {
  tenantId: string
  clientId: string
  clientSecret: string
  redirectUri: string
  /** Only tests set this; production derives it from tenantId. */
  discoveryUrl?: string
}

export class SsoError extends Error {}

/** openid for the id_token, profile for the name, email for the address. */
export const SCOPES = 'openid profile email'
const CLOCK_SKEW_SECONDS = 60
const META_CACHE_MS = 60 * 60 * 1000
const JWKS_CACHE_MS = 60 * 60 * 1000

const discoveryUrlFor = (tenantId: string) =>
  `https://login.microsoftonline.com/${encodeURIComponent(tenantId)}/v2.0/.well-known/openid-configuration`

const metaCache = new Map<string, { at: number, meta: OidcMetadata }>()

/**
 * Reads the provider metadata. Endpoints are never hardcoded — Microsoft has
 * moved them before — but the shape is checked, because a half-read document
 * fails later and in a way that looks like bad credentials.
 */
export async function discover(cfg: EntraConfig, now = Date.now): Promise<OidcMetadata> {
  const url = cfg.discoveryUrl ?? discoveryUrlFor(cfg.tenantId)
  const hit = metaCache.get(url)
  if (hit && now() - hit.at < META_CACHE_MS) return hit.meta

  const res = await fetch(url)
  if (!res.ok) throw new SsoError(`oidc discovery failed: ${res.status}`)
  const meta = await res.json() as OidcMetadata
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint', 'jwks_uri'] as const) {
    if (!meta[field]) throw new SsoError(`oidc discovery incomplete: missing ${field}`)
  }
  // The multi-tenant giveaway. If the issuer is still a template, `iss` is not
  // checkable and the door is open to every Microsoft work account.
  if (meta.issuer.includes('{')) {
    throw new SsoError('issuer is a template, not a value — use a tenant-specific discovery URL')
  }
  const algs = meta.id_token_signing_alg_values_supported
  if (algs && !algs.includes('RS256')) {
    throw new SsoError('provider does not offer RS256; refusing to guess an algorithm')
  }
  metaCache.set(url, { at: now(), meta })
  return meta
}

/** Only for tests — otherwise the caches live as long as the process. */
export function resetCaches(): void { metaCache.clear(); jwksCache.clear() }

/* ------------------------------------------------------------------- keys */

interface Jwk { kid?: string, kty?: string, alg?: string, use?: string, n?: string, e?: string }
const jwksCache = new Map<string, { at: number, keys: Jwk[] }>()

async function fetchJwks(uri: string, now: () => number): Promise<Jwk[]> {
  const res = await fetch(uri)
  if (!res.ok) throw new SsoError(`jwks fetch failed: ${res.status}`)
  const body = await res.json() as { keys?: Jwk[] }
  const keys = body.keys ?? []
  if (!keys.length) throw new SsoError('jwks contained no keys')
  jwksCache.set(uri, { at: now(), keys })
  return keys
}

/**
 * Resolves a kid to a public key.
 *
 * A cache miss forces one refetch: Microsoft rotates signing keys on their own
 * schedule, and a cached key set is the standard way to be mysteriously unable
 * to log in for an hour.
 */
async function publicKeyFor(uri: string, kid: string, now: () => number): Promise<KeyObject> {
  const cached = jwksCache.get(uri)
  const fresh = cached && now() - cached.at < JWKS_CACHE_MS
  let keys = fresh ? cached!.keys : await fetchJwks(uri, now)
  let jwk = keys.find(k => k.kid === kid)
  if (!jwk && fresh) {
    keys = await fetchJwks(uri, now)          // probably a rotation, not an attack
    jwk = keys.find(k => k.kid === kid)
  }
  if (!jwk) throw new SsoError(`no signing key for kid ${kid}`)
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) throw new SsoError('signing key is not usable RSA')
  return createPublicKey({ key: jwk as unknown as Record<string, unknown>, format: 'jwk' })
}

/* ----------------------------------------------------------------- claims */

interface IdTokenClaims {
  iss?: string, aud?: string | string[], exp?: number, iat?: number, nbf?: number
  tid?: string, oid?: string, sub?: string, nonce?: string
  email?: string, preferred_username?: string, name?: string
  groups?: unknown
  /** Present instead of `groups` past 200 memberships; maps 'groups' to a source. */
  _claim_names?: Record<string, string>
  _claim_sources?: Record<string, unknown>
}

const decodePart = (part: string): unknown =>
  JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

/**
 * Verifies signature then claims, in that order — an unsigned token's claims are
 * not worth reading.
 */
export async function verifyIdToken(
  idToken: string,
  opts: { meta: OidcMetadata, clientId: string, tenantId: string, nonce: string },
  now = Date.now,
): Promise<Identity> {
  const parts = idToken.split('.')
  if (parts.length !== 3) throw new SsoError('id_token is not a JWS')
  const [rawHeader, rawPayload, rawSig] = parts as [string, string, string]

  const header = decodePart(rawHeader) as { alg?: string, kid?: string }
  // `alg` is attacker-controlled, so it is matched against what we accept rather
  // than used to choose a verifier.
  if (header.alg !== 'RS256') throw new SsoError(`refusing id_token alg ${header.alg ?? 'missing'}`)
  if (!header.kid) throw new SsoError('id_token has no kid')

  const key = await publicKeyFor(opts.meta.jwks_uri, header.kid, now)
  const signed = Buffer.from(`${rawHeader}.${rawPayload}`, 'utf8')
  const ok = verifySignature('RSA-SHA256', signed, key, Buffer.from(rawSig, 'base64url'))
  if (!ok) throw new SsoError('id_token signature did not verify')

  const c = decodePart(rawPayload) as IdTokenClaims
  const seconds = Math.floor(now() / 1000)

  if (c.iss !== opts.meta.issuer) throw new SsoError('id_token issuer mismatch')
  const audiences = Array.isArray(c.aud) ? c.aud : [c.aud]
  if (!audiences.includes(opts.clientId)) throw new SsoError('id_token audience mismatch')
  // Belt and braces behind the issuer check: a single-tenant app registration
  // should never see a token from another directory.
  if (c.tid !== opts.tenantId) throw new SsoError('id_token came from another tenant')
  if (c.nonce !== opts.nonce) throw new SsoError('id_token nonce mismatch')
  if (typeof c.exp !== 'number' || c.exp + CLOCK_SKEW_SECONDS < seconds) {
    throw new SsoError('id_token has expired')
  }
  if (typeof c.iat === 'number' && c.iat - CLOCK_SKEW_SECONDS > seconds) {
    throw new SsoError('id_token was issued in the future')
  }
  if (typeof c.nbf === 'number' && c.nbf - CLOCK_SKEW_SECONDS > seconds) {
    throw new SsoError('id_token is not valid yet')
  }

  // `email` needs an optional claim configured; preferred_username is the UPN
  // and is always there. Either is an address; neither is a licence to skip the
  // allowlist.
  const email = (c.email ?? c.preferred_username ?? '').trim().toLowerCase()
  if (!email) throw new SsoError('id_token carried no address')
  const subjectId = c.oid ?? c.sub
  if (!subjectId) throw new SsoError('id_token carried no subject')

  // Group membership is read, never trusted to be present: the claim only
  // appears once somebody has configured it, and it disappears again past 200
  // memberships. Both cases are reported rather than collapsed into "no groups".
  const groupsEmitted = Object.prototype.hasOwnProperty.call(c, 'groups')
  const groups = Array.isArray(c.groups)
    ? c.groups.filter((g): g is string => typeof g === 'string')
    : []
  const groupsOverage = Boolean(c._claim_names?.groups)

  return {
    email, name: c.name ?? email, subjectId, tenantId: c.tid,
    groups, groupsEmitted, groupsOverage,
  }
}

/* ------------------------------------------------------------------- flow */

const b64url = (b: Buffer) => b.toString('base64url')
const challengeFor = (verifier: string) =>
  b64url(createHash('sha256').update(verifier).digest())

export interface Started { url: string, state: string }

/**
 * Starts a login.
 *
 * PKCE is sent even though this is a confidential client and Entra does not
 * advertise `code_challenge_methods_supported`. It supports S256, OAuth 2.1
 * requires it, and it costs one hash.
 */
export async function beginLogin(
  client: PoolClient, cfg: EntraConfig,
): Promise<Started> {
  const meta = await discover(cfg)
  const state = b64url(randomBytes(32))
  const verifier = b64url(randomBytes(64))
  const nonce = b64url(randomBytes(32))

  await client.query(
    `insert into oauth_flow
       (state, provider, code_verifier, redirect_uri, nonce, expires_at)
     values ($1, 'entra', $2, $3, $4, now() + interval '10 minutes')`,
    [state, verifier, cfg.redirectUri, nonce],
  )

  const url = new URL(meta.authorization_endpoint)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('response_mode', 'query')
  url.searchParams.set('client_id', cfg.clientId)
  url.searchParams.set('redirect_uri', cfg.redirectUri)
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('state', state)
  url.searchParams.set('nonce', nonce)
  url.searchParams.set('code_challenge', challengeFor(verifier))
  url.searchParams.set('code_challenge_method', 'S256')
  // Two of us have more than one Microsoft account in the browser; without this
  // the silent one wins and the failure looks like "you are not allowed".
  url.searchParams.set('prompt', 'select_account')
  return { url: url.toString(), state }
}

/**
 * Consumes the flow row, exchanges the code, and returns the verified identity.
 *
 * Only the id_token is used. The access token would let us call Graph, and we
 * have no business doing that to answer "who is this".
 */
export async function completeLogin(
  client: PoolClient, cfg: EntraConfig,
  params: { code: string, state: string },
  now = Date.now,
): Promise<Identity> {
  if (!params.code || !params.state) throw new SsoError('missing code or state')
  const { rows } = await client.query<{ code_verifier: string, redirect_uri: string, nonce: string | null }>(
    `update oauth_flow set used_at = now()
      where state = $1 and provider = 'entra' and used_at is null and expires_at > now()
      returning code_verifier, redirect_uri, nonce`,
    [params.state],
  )
  const flow = rows[0]
  if (!flow) throw new SsoError('unknown, expired or already-used state')
  if (!flow.nonce) throw new SsoError('flow row carried no nonce')

  const meta = await discover(cfg, now)
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: flow.redirect_uri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code_verifier: flow.code_verifier,
    scope: SCOPES,
  })
  const res = await fetch(meta.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    // The provider's error code only. The request body holds the client secret,
    // and Microsoft's error descriptions are long enough to be tempting to log.
    const text = await res.text().catch(() => '')
    const code = /"error"\s*:\s*"([a-z_]+)"/.exec(text)?.[1] ?? `http_${res.status}`
    throw new SsoError(`token exchange rejected: ${code}`)
  }
  const token = await res.json() as { id_token?: string }
  if (!token.id_token) throw new SsoError('token response carried no id_token')

  return verifyIdToken(token.id_token, {
    meta, clientId: cfg.clientId, tenantId: cfg.tenantId, nonce: flow.nonce,
  }, now)
}

/** Why somebody who proved their identity still did not get in. */
export type Refusal =
  /** A token from a different directory. Should be impossible; checked anyway. */
  | 'foreign_tenant'
  /** Groups are the gate, but the app registration never emits the claim. */
  | 'groups_not_emitted'
  /** More than 200 memberships, so Entra sent a pointer instead of a list. */
  | 'groups_overage'
  | 'not_in_group'
  | 'not_allowlisted'

/**
 * A discriminated union rather than `{ ok, reason? }`: the compiler then knows a
 * refusal always carries a reason, so no caller can log an undefined one.
 */
export type Admission = { ok: true } | { ok: false, reason: Refusal }

export interface Policy {
  tenantId: string
  /** Entra group object IDs. Empty means group membership is not a gate. */
  groups: string[]
  /** Exact addresses. Empty means the address list is not a gate. */
  emails: string[]
}

/**
 * Decides admission after Entra has decided identity.
 *
 * Entra proves the person is who they say and still works here. This decides
 * whether this particular tool is theirs to open.
 *
 * EVERY CONFIGURED GATE MUST PASS. That is the whole design rule: adding a line
 * of configuration can then only ever narrow access, never widen it. If groups
 * and addresses are both set, both apply — which is unusual, and deliberate,
 * because the alternative (a group list silently replacing an address list) is a
 * config change that quietly lets more people in.
 *
 * With nothing configured, admission is "anyone in the tenant": a closed door,
 * but a wide one, so the status page says which of the two it currently is.
 *
 * Group membership resolves to a REFUSAL WITH A REASON rather than a boolean.
 * A missing groups claim and an empty groups claim look identical from the
 * outside and mean opposite things — "you forgot the token configuration" and
 * "this person is in no permitted group" — and somebody locked out at 22:00
 * needs to be able to tell which.
 */
export function admits(identity: Identity, policy: Policy): Admission {
  if (identity.tenantId !== policy.tenantId) return { ok: false, reason: 'foreign_tenant' }

  if (policy.groups.length) {
    if (identity.groupsOverage) return { ok: false, reason: 'groups_overage' }
    if (!identity.groupsEmitted) return { ok: false, reason: 'groups_not_emitted' }
    // Case-insensitive because a GUID is written either way and an
    // AD-synced group arrives as a name. Object IDs are what should be
    // configured: a display name is mutable and reusable.
    const want = new Set(policy.groups.map(g => g.trim().toLowerCase()))
    if (!identity.groups.some(g => want.has(g.trim().toLowerCase()))) {
      return { ok: false, reason: 'not_in_group' }
    }
  }

  if (policy.emails.length && !policy.emails.includes(identity.email)) {
    return { ok: false, reason: 'not_allowlisted' }
  }
  return { ok: true }
}
