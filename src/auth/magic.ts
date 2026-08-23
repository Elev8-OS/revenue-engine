/**
 * Magic-link authentication.
 *
 * No passwords, because two internal users do not need a credential store, and
 * the one we would build is the one that gets breached.
 *
 * Three properties this module is responsible for, each with a test:
 *   1. the raw token never reaches the database
 *   2. a link works exactly once, even if two requests race
 *   3. asking for a link tells you nothing about who is allowed to have one
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { PoolClient } from 'pg'

/** Long enough that guessing is pointless, short-lived enough that theft is too. */
const TOKEN_BYTES = 32
const TOKEN_TTL_MINUTES = 15
/** A tool that can move prices should not hold a month-long session. */
const SESSION_TTL_DAYS = 7
/** Per address, per window. Generous for a human, useless for a mail bomb. */
const THROTTLE_MAX = 3
const THROTTLE_WINDOW_MINUTES = 15

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export interface RequestOutcome {
  /** The link to deliver, or undefined when nothing should be sent. */
  link?: string
  /** Why nothing is being sent. For logs only — never for the response body. */
  suppressed?: 'not_allowed' | 'throttled'
}

/**
 * Issues a link for an allowlisted address.
 *
 * Returns the same shape whether or not the address is allowed; the caller must
 * answer the HTTP request identically in both cases. Anything else turns this
 * endpoint into a directory of who works here.
 */
export async function requestLink(
  client: PoolClient,
  email: string,
  allowed: string[],
  baseUrl: string,
): Promise<RequestOutcome> {
  const normalised = email.trim().toLowerCase()
  if (!allowed.includes(normalised)) return { suppressed: 'not_allowed' }

  const { rows } = await client.query<{ n: number }>(
    `select count(*)::int n from login_attempt
      where email = $1 and at > now() - ($2 || ' minutes')::interval`,
    [normalised, String(THROTTLE_WINDOW_MINUTES)],
  )
  if ((rows[0]?.n ?? 0) >= THROTTLE_MAX) return { suppressed: 'throttled' }
  await client.query('insert into login_attempt (email) values ($1)', [normalised])

  const token = randomBytes(TOKEN_BYTES).toString('base64url')
  await client.query(
    `insert into login_token (token_hash, email, expires_at)
     values ($1, $2, now() + ($3 || ' minutes')::interval)`,
    [sha256(token), normalised, String(TOKEN_TTL_MINUTES)],
  )
  return { link: `${baseUrl.replace(/\/$/, '')}/auth/callback?token=${token}` }
}

export interface Session { id: string, email: string }

/**
 * Redeems a token and opens a session, or returns undefined.
 *
 * The update is the lock: `where used_at is null` means the second redemption of
 * the same link changes no rows and gets nothing, which is what makes a
 * forwarded or replayed link harmless.
 */
export async function redeem(
  client: PoolClient, token: string,
): Promise<Session | undefined> {
  if (!token) return undefined
  const { rows } = await client.query<{ email: string }>(
    `update login_token
        set used_at = now()
      where token_hash = $1
        and used_at is null
        and expires_at > now()
      returning email`,
    [sha256(token)],
  )
  const email = rows[0]?.email
  if (!email) return undefined

  const id = randomBytes(TOKEN_BYTES).toString('base64url')
  await client.query(
    `insert into session (id, email, expires_at)
     values ($1, $2, now() + ($3 || ' days')::interval)`,
    [id, email, String(SESSION_TTL_DAYS)],
  )
  return { id, email }
}

/** Resolves a cookie value to a session, and touches last_seen. */
export async function sessionFor(
  client: PoolClient, id: string | undefined,
): Promise<Session | undefined> {
  if (!id) return undefined
  const { rows } = await client.query<{ id: string, email: string }>(
    `update session set last_seen = now()
      where id = $1 and expires_at > now()
      returning id, email`,
    [id],
  )
  return rows[0]
}

export async function destroy(client: PoolClient, id: string | undefined): Promise<void> {
  if (!id) return
  await client.query('delete from session where id = $1', [id])
}

/** Removes what has aged out. Cheap, and keeps the tables honest. */
export async function sweep(client: PoolClient): Promise<void> {
  await client.query(`delete from login_token where expires_at < now() - interval '1 day'`)
  await client.query('delete from session where expires_at < now()')
  await client.query(`delete from login_attempt where at < now() - interval '1 day'`)
}

/** Constant-time compare, for header secrets rather than session ids. */
export function secretMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected) return false
  const a = Buffer.from(sha256(given), 'hex')
  const b = Buffer.from(sha256(expected), 'hex')
  return timingSafeEqual(a, b)
}

export const cookieName = 're_session'
export const sessionMaxAgeSeconds = SESSION_TTL_DAYS * 24 * 3600
