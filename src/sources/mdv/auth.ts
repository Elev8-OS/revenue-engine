/**
 * MDV token custody.
 *
 * The constraint that shapes this file: MDV's refresh tokens rotate, and
 * presenting a spent one revokes the WHOLE grant. That turns an ordinary
 * refresh into a mutually exclusive operation — two processes refreshing
 * concurrently is not a race that loses one request, it is a race that loses
 * the integration until a human re-authorises.
 *
 * So: one row holds the token, a Postgres advisory lock serialises refreshes,
 * and the row is re-read INSIDE the lock, because the process we waited for has
 * very likely already refreshed and left us a usable token.
 *
 * Note on custody rather than transport: using MDV's HTTP API instead of an MCP
 * wrapper is the right call for the data path, but it does not remove this
 * problem — it relocates it. If another service (mydatavalue-mcp) holds a grant
 * for the same client, this worker must not refresh it. The clean resolution is
 * a SECOND registered client via RFC 7591 dynamic registration: two clients,
 * two grants, neither able to revoke the other.
 */
import type { PoolClient } from 'pg'

/** Refresh this many seconds before actual expiry, so a request never races it. */
const SKEW_SECONDS = 120

export class GrantRevokedError extends Error {
  constructor(reason: string) {
    super(`MDV grant revoked: ${reason}. A human must re-authorise; no automatic retry.`)
  }
}

export interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in: number
}

/** Injected so the lock and rotation logic can be tested without the provider. */
export type RefreshFn = (refreshToken: string) => Promise<TokenResponse>

interface TokenRow {
  client_id: string
  access_token: string
  access_expires_at: Date
  refresh_token: string
  rotation: number
  revoked_at: Date | null
  revoked_reason: string | null
}

const LOCK_KEY = 918_273_641 // constant: one refresher for MDV, process-independent

async function log(
  client: PoolClient, provider: string, event: string,
  rotation: number | null, detail?: string,
): Promise<void> {
  await client.query(
    'insert into oauth_event (provider, event, rotation, detail) values ($1,$2,$3,$4)',
    [provider, event, rotation, detail ?? null],
  )
}

async function read(client: PoolClient, provider: string): Promise<TokenRow | undefined> {
  const { rows } = await client.query<TokenRow>(
    `select client_id, access_token, access_expires_at, refresh_token, rotation,
            revoked_at, revoked_reason
       from oauth_token where provider = $1`, [provider],
  )
  return rows[0]
}

function stillValid(row: TokenRow, now: Date): boolean {
  return row.access_expires_at.getTime() - now.getTime() > SKEW_SECONDS * 1000
}

/**
 * Returns a usable access token, refreshing only if necessary and only ever
 * from one process at a time.
 *
 * Never logs a token value; the audit trail records the rotation counter, which
 * is enough to reconstruct what happened and useless to anyone who steals it.
 */
export async function getAccessToken(
  client: PoolClient,
  refreshFn: RefreshFn,
  provider = 'mdv',
  now: () => Date = () => new Date(),
): Promise<string> {
  const before = await read(client, provider)
  if (!before) throw new Error(`no ${provider} token stored; run the authorisation flow once`)
  if (before.revoked_at) throw new GrantRevokedError(before.revoked_reason ?? 'unknown')
  if (stillValid(before, now())) return before.access_token

  // Serialise. pg_advisory_lock blocks rather than failing, which is what we
  // want: the loser should wait and then find a fresh token, not error out.
  await client.query('select pg_advisory_lock($1)', [LOCK_KEY])
  try {
    // Re-read inside the lock. Whoever held it probably refreshed already, and
    // using their result is the whole point of waiting.
    const row = await read(client, provider)
    if (!row) throw new Error(`no ${provider} token stored`)
    if (row.revoked_at) throw new GrantRevokedError(row.revoked_reason ?? 'unknown')
    if (stillValid(row, now())) {
      await log(client, provider, 'reused_from_cache', row.rotation)
      return row.access_token
    }

    let next: TokenResponse
    try {
      next = await refreshFn(row.refresh_token)
    } catch (err) {
      const message = (err as Error).message
      // invalid_grant is terminal. Marking it stops every later call from
      // presenting a token we already know is dead.
      if (/invalid_grant/i.test(message)) {
        await client.query(
          `update oauth_token set revoked_at = now(), revoked_reason = $2 where provider = $1`,
          [provider, message],
        )
        await log(client, provider, 'invalid_grant', row.rotation, message)
        throw new GrantRevokedError(message)
      }
      await log(client, provider, 'error', row.rotation, message)
      throw err
    }

    const expiresAt = new Date(now().getTime() + next.expires_in * 1000)
    // Guarded by rotation: if another process rotated while we were mid-flight,
    // this updates nothing and we fall back to their token rather than
    // overwriting it with a value derived from a token they already spent.
    const { rowCount } = await client.query(
      `update oauth_token
          set access_token = $2, refresh_token = $3, access_expires_at = $4,
              rotation = rotation + 1, refreshed_at = now()
        where provider = $1 and rotation = $5`,
      [provider, next.access_token, next.refresh_token, expiresAt, row.rotation],
    )
    if (!rowCount) {
      const current = await read(client, provider)
      await log(client, provider, 'reused_from_cache', current?.rotation ?? null,
                'rotation advanced concurrently')
      if (!current) throw new Error(`no ${provider} token stored`)
      return current.access_token
    }
    await log(client, provider, 'refreshed', row.rotation + 1)
    return next.access_token
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY])
  }
}

/** Stores the result of the one-time authorisation-code exchange. */
export async function storeInitialToken(
  client: PoolClient, provider: string, clientId: string,
  token: TokenResponse, now: () => Date = () => new Date(),
): Promise<void> {
  const expiresAt = new Date(now().getTime() + token.expires_in * 1000)
  await client.query(
    `insert into oauth_token
       (provider, client_id, access_token, refresh_token, access_expires_at, rotation)
     values ($1,$2,$3,$4,$5,0)
     on conflict (provider) do update
       set client_id = excluded.client_id,
           access_token = excluded.access_token,
           refresh_token = excluded.refresh_token,
           access_expires_at = excluded.access_expires_at,
           rotation = 0, refreshed_at = now(),
           revoked_at = null, revoked_reason = null`,
    [provider, clientId, token.access_token, token.refresh_token, expiresAt],
  )
  await log(client, provider, 'refreshed', 0, 'initial authorisation')
}
