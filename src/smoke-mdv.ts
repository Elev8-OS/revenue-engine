/** Token custody under concurrency. The failure mode being tested is
 *  destructive — a second refresh with a spent token revokes the whole grant —
 *  so the test uses two real connections and asserts the refresh count. */
import { Pool } from 'pg'
import { getAccessToken, storeInitialToken, GrantRevokedError } from './sources/mdv/auth.js'

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

// 3 · invalid_grant is terminal and is not retried
await setup.query(`update oauth_token set access_expires_at = now() - interval '1 hour'`)
let dead = 0
const badRefresh = async () => { dead++; throw new Error('invalid_grant: refresh token reuse detected') }
let threw = false
try { await getAccessToken(c1, badRefresh) } catch (e) { threw = e instanceof GrantRevokedError }
check('invalid_grant surfaces as GrantRevokedError', threw)
let threwAgain = false
try { await getAccessToken(c2, badRefresh) } catch (e) { threwAgain = e instanceof GrantRevokedError }
check('a revoked grant is NOT retried against the provider', threwAgain && dead === 1, `${dead} provider call(s)`)

// 4 · no token value is ever written to the audit trail
const leaked = await setup.query<{ n: number }>(
  `select count(*)::int n from oauth_event
    where detail like '%a0%' or detail like '%r0%' or detail like '%a1%' or detail like '%r1%'`)
check('the audit trail contains no token values', leaked.rows[0]!.n === 0)

setup.release(); c1.release(); c2.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
