/** Token custody under concurrency. The failure mode being tested is
 *  destructive — a second refresh with a spent token revokes the whole grant —
 *  so the test uses two real connections and asserts the refresh count. */
import { Pool } from 'pg'
import { getAccessToken, storeInitialToken, GrantRevokedError, StaleTokenError,
         type RefreshFn } from './sources/mdv/auth.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

const setup = await pool.connect()
// Reset, so the run is repeatable: several checks count audit rows, and those
// accumulate. A test that only passes on a virgin database is not a test.
await setup.query('truncate oauth_event')
await setup.query('delete from oauth_token')
await storeInitialToken(setup, 'mdv', 'client-a',
  { access_token: 'a0', refresh_token: 'r0', expires_in: 3600 })

// 1 · a valid token is reused without touching the provider
let calls = 0
const refresh = async (rt: string) => {
  calls++
  await new Promise(r => setTimeout(r, 300))       // slow on purpose
  return { access_token: `a${calls}`, refresh_token: `r${calls}`, expires_in: 3600 }
}
const t1 = await getAccessToken(setup, refresh)
check('valid token is reused, provider not called', t1 === 'a0' && calls === 0)

// 2 · expire it, then hit it from TWO connections at once
await setup.query(`update oauth_token set access_expires_at = now() - interval '1 hour'`)
const c1 = await pool.connect()
const c2 = await pool.connect()
const [r1, r2] = await Promise.all([
  getAccessToken(c1, refresh),
  getAccessToken(c2, refresh),
])
check('two concurrent callers cause exactly ONE refresh', calls === 1, `${calls} call(s)`)
check('both callers get the same token', r1 === r2, `${r1} / ${r2}`)
const rot = await setup.query<{ rotation: number }>(`select rotation from oauth_token`)
check('rotation advanced once', rot.rows[0]!.rotation === 1, `rotation ${rot.rows[0]!.rotation}`)
const cached = await setup.query<{ n: number }>(
  `select count(*)::int n from oauth_event where event = 'reused_from_cache'`)
check('the waiting caller reused rather than refreshed', cached.rows[0]!.n === 1)

/*
 * 3 · A SUCCESSFUL EXCHANGE IS NEVER DISCARDED.
 *
 * This is the case the provider described from their side: "something on your
 * side exchanged and didn't store the result." The old code guarded the write
 * with `where rotation = $n` and, on a mismatch, threw away the token it had
 * just been given. MDV rotates ON the exchange, so that token is the only one
 * left that works and the stored one is already spent — discarding it does not
 * protect the chain, it ends it.
 */
await setup.query(`update oauth_token set access_expires_at = now() - interval '1 hour'`)
const rotBefore = (await setup.query<{ rotation: number }>(
  `select rotation from oauth_token`)).rows[0]!.rotation
const jumper: RefreshFn = async () => {
  // A writer moves the row while we are mid-flight — which is exactly what an
  // unlocked seed used to do at boot.
  await setup.query(`update oauth_token set rotation = rotation + 5`)
  return { access_token: 'a9', refresh_token: 'r9', expires_in: 3600 }
}
const jumped = await getAccessToken(c1, jumper)
check('a mid-flight row move does not lose the exchange', jumped === 'a9')
const after = (await setup.query<{ rotation: number, refresh_token: string }>(
  `select rotation, refresh_token from oauth_token`)).rows[0]!
check('the freshly minted refresh token IS stored', after.refresh_token === 'r9',
      `rotation ${after.rotation}, was ${rotBefore}`)
const collided = await setup.query<{ n: number }>(
  `select count(*)::int n from oauth_event where event = 'collision_stored'`)
check('and the collision is logged rather than swallowed', collided.rows[0]!.n === 1)

/*
 * 4 · invalid_grant is a STALE token, not a revoked grant.
 *
 * The most expensive line this file ever had: `invalid_grant` was recorded as a
 * revocation, so the readiness page said "unrecoverable" about a grant the
 * provider confirmed was live — with a successful exchange on it while the
 * service was refusing to try.
 */
await setup.query(`update oauth_token set access_expires_at = now() - interval '1 hour'`)
let dead = 0
const badRefresh: RefreshFn = async () => {
  dead++; throw new Error('invalid_grant: refresh token reuse detected')
}
let stale: unknown = null
try { await getAccessToken(c1, badRefresh) } catch (e) { stale = e }
check('invalid_grant surfaces as StaleTokenError, not GrantRevokedError',
      stale instanceof StaleTokenError && !(stale instanceof GrantRevokedError),
      String(stale))
check('and the message names the remedy instead of blaming the provider',
      (stale as Error).message.includes('MDV_SEED_REFRESH_TOKEN')
      && (stale as Error).message.includes('not revoked'), (stale as Error).message)
const state = (await setup.query<{ revoked_at: Date | null, stale_since: Date | null }>(
  `select revoked_at, stale_since from oauth_token`)).rows[0]!
check('the grant is marked BEHIND, not dead',
      state.stale_since !== null && state.revoked_at === null, JSON.stringify(state))
let again: unknown = null
try { await getAccessToken(c2, badRefresh) } catch (e) { again = e }
check('a stale token is still not presented twice',
      again instanceof StaleTokenError && dead === 1, `${dead} provider call(s)`)

// 5 · a code that really does mean the grant is gone
await setup.query(
  `update oauth_token set stale_since = null, stale_reason = null,
          access_expires_at = now() - interval '1 hour'`)
let gone: unknown = null
try {
  await getAccessToken(c1, async () => { throw new Error('invalid_client: unknown client') })
} catch (e) { gone = e }
check('invalid_client IS a revocation', gone instanceof GrantRevokedError, String(gone))
const rev = (await setup.query<{ revoked_at: Date | null }>(
  `select revoked_at from oauth_token`)).rows[0]!
check('and it is recorded as one', rev.revoked_at !== null)

// 6 · anything unrecognised is an error, not a verdict about the provider
await setup.query(
  `update oauth_token set revoked_at = null, revoked_reason = null,
          access_expires_at = now() - interval '1 hour'`)
let boom: unknown = null
try {
  await getAccessToken(c1, async () => { throw new Error('502 bad gateway') })
} catch (e) { boom = e }
check('an unknown failure is neither stale nor revoked',
      boom instanceof Error && !(boom instanceof StaleTokenError)
      && !(boom instanceof GrantRevokedError), String(boom))
const clean = (await setup.query<{ revoked_at: Date | null, stale_since: Date | null }>(
  `select revoked_at, stale_since from oauth_token`)).rows[0]!
check('and it leaves the grant alone, because declaring a live integration dead '
      + 'costs more than one failed request',
      clean.revoked_at === null && clean.stale_since === null)

// 7 · no token value is ever written to the audit trail
const leaked = await setup.query<{ n: number }>(
  `select count(*)::int n from oauth_event
    where detail like '%a0%' or detail like '%r0%' or detail like '%a1%' or detail like '%r1%'`)
check('the audit trail contains no token values', leaked.rows[0]!.n === 0)

setup.release(); c1.release(); c2.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
