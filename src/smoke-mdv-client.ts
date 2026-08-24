/**
 * The MDV transport, against a stand-in provider.
 *
 * What is actually being protected here: MDV rotates refresh tokens and treats a
 * spent one as stolen, revoking the whole grant. So the tests that matter are
 * not "does a GET work" but "can this code ever present a token twice", and
 * "does a restart with the seed variable still set re-seed a dead token".
 */
import { createServer, type IncomingMessage } from 'node:http'
import { Pool } from 'pg'
import {
  MdvClient, makeRefresh, seedRefreshToken, retryAfterMs, MdvError, GrantRevokedError,
} from './sources/mdv/client.js'
import { getAccessToken } from './sources/mdv/auth.js'
import { RateBudget } from './scheduler/budget.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

const CLIENT = 'mdv-test-client'
const SECRET = 'se+cret/with specials'      // deliberately not URL-safe
const port = 4591
const tokenUrl = `http://127.0.0.1:${port}/oauth/token`
const base = `http://127.0.0.1:${port}/api/v1`

// --- provider state
let seenAuth = ''
let presentedRefresh: string[] = []
let liveRefresh = 'seed-token-0'
let rotation = 0
let rejectRefreshWith: string | null = null
let getStatus = 200
let getRetryAfter: string | null = null
let getCalls = 0
let statusQueue: number[] = []

const body = async (req: IncomingMessage) => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  return new URLSearchParams(Buffer.concat(chunks).toString())
}

const srv = createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0]!
  const json = (o: unknown, status = 200, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers })
    res.end(JSON.stringify(o))
  }
  if (path === '/oauth/token') {
    seenAuth = String(req.headers.authorization ?? '')
    const p = await body(req)
    presentedRefresh.push(p.get('refresh_token') ?? '')
    if (rejectRefreshWith) return json({ error: rejectRefreshWith }, 400)
    // A spent token is a revoked grant, exactly as the provider describes.
    if (p.get('refresh_token') !== liveRefresh) return json({ error: 'invalid_grant' }, 400)
    rotation++
    liveRefresh = `rotated-${rotation}`
    return json({ access_token: `at-${rotation}`, refresh_token: liveRefresh, expires_in: 3600 })
  }
  if (path.startsWith('/api/v1/')) {
    getCalls++
    const status = statusQueue.shift() ?? getStatus
    if (status === 429) {
      return json({ error: 'rate_limited' }, 429,
                  getRetryAfter ? { 'retry-after': getRetryAfter } : {})
    }
    if (status !== 200) return json({ error: 'invalid_token' }, status)
    return json({ ok: true, path })
  }
  res.writeHead(404); res.end()
})
await new Promise<void>(r => srv.listen(port, r))

const c = await pool.connect()
const reset = async () => {
  await c.query('delete from oauth_token'); await c.query('truncate oauth_event')
  presentedRefresh = []; liveRefresh = 'seed-token-0'; rotation = 0
  rejectRefreshWith = null; getStatus = 200; getRetryAfter = null
  getCalls = 0; statusQueue = []
}

/* ------------------------------------------------------------ 1 · Retry-After */

check('Retry-After in seconds is parsed', retryAfterMs('30') === 30_000)
check('Retry-After as an HTTP date is parsed',
      retryAfterMs(new Date(Date.now() + 5_000).toUTCString(), () => Date.now()) !== null)
check('a missing Retry-After yields null', retryAfterMs(null) === null)
check('nonsense in Retry-After yields null rather than NaN', retryAfterMs('soon') === null)

/* ----------------------------------------------------------------- 2 · seeding */

await reset()
check('no seed configured is a no-op',
      await seedRefreshToken(c, { clientId: CLIENT, refreshToken: undefined }) === 'not_configured')
check('an empty grant gets seeded',
      await seedRefreshToken(c, { clientId: CLIENT, refreshToken: 'seed-token-0' }) === 'seeded')
// This is the one that protects the grant across a redeploy.
check('a restart with the variable still set does NOT re-seed',
      await seedRefreshToken(c, { clientId: CLIENT, refreshToken: 'seed-token-0' }) === 'kept_existing')
await c.query(`update oauth_token set revoked_at = now(), revoked_reason = 'test'
                where provider = 'mdv'`)
// Futile, not unsafe: the variable still holds the token that died with the
// grant, so presenting it would fail in exactly the same way.
check('a revoked grant is not re-seeded with the SAME token',
      await seedRefreshToken(c, { clientId: CLIENT, refreshToken: 'seed-token-0' }) === 'kept_revoked')
const seedStillDead = await c.query<{ revoked_at: Date | null }>(
  `select revoked_at from oauth_token where provider = 'mdv'`)
check('and the refusal leaves it revoked rather than half-reviving it',
      seedStillDead.rows[0]!.revoked_at !== null)

// The recovery path. Without it a revoked grant is a dead end whenever the
// authorisation-code route is unavailable — which is the normal case for a
// grant the provider issued directly, with no redirect URI registered.
check('a revoked grant IS re-seeded with a newly issued token',
      await seedRefreshToken(c, { clientId: CLIENT, refreshToken: 'fresh-token-x' }) === 'reseeded')
const seedRevived = await c.query<{
  revoked_at: Date | null, revoked_reason: string | null,
  rotation: number, refresh_token: string, access_token: string,
  access_expires_at: Date
}>(`select revoked_at, revoked_reason, rotation, refresh_token, access_token,
           access_expires_at from oauth_token where provider = 'mdv'`)
check('the revocation is lifted', seedRevived.rows[0]!.revoked_at === null
      && seedRevived.rows[0]!.revoked_reason === null)
check('the new chain starts at rotation 0', seedRevived.rows[0]!.rotation === 0)
check('the new token is the one stored', seedRevived.rows[0]!.refresh_token === 'fresh-token-x')
// A leftover access token from the dead chain would be presented once and 401.
check('the dead access token is discarded', seedRevived.rows[0]!.access_token === '')
check('and the row is expired, so the first call refreshes',
      seedRevived.rows[0]!.access_expires_at.getTime() < Date.now())
const reseedTrail = await c.query<{ detail: string | null }>(
  `select detail from oauth_event where provider = 'mdv' order by id`)
check('the re-seed is recorded WITHOUT the token value',
      reseedTrail.rows.some(r => (r.detail ?? '').includes('reseeded'))
      && !reseedTrail.rows.some(r => (r.detail ?? '').includes('fresh-token-x')))

// A live grant is still untouchable, even by a different value — this is the
// guard that stops a stale variable from destroying a working connection.
check('a LIVE grant is not replaced even by a different token',
      await seedRefreshToken(c, { clientId: CLIENT, refreshToken: 'another-token' }) === 'kept_existing')
const seededRow = await c.query<{ access_expires_at: Date, rotation: number, refresh_token: string }>(
  `select access_expires_at, rotation, refresh_token from oauth_token where provider = 'mdv'`)
check('the seeded row is already expired, so the first call refreshes',
      seededRow.rows[0]!.access_expires_at.getTime() < Date.now())
check('and it starts at rotation 0', seededRow.rows[0]!.rotation === 0)
check('the live token survived the ignored variable',
      seededRow.rows[0]!.refresh_token === 'fresh-token-x')

/* -------------------------------------------------- 3 · Basic, encoded properly */

await reset()
await seedRefreshToken(c, { clientId: CLIENT, refreshToken: 'seed-token-0' })
const refresh = makeRefresh(CLIENT, SECRET, tokenUrl)
const first = await getAccessToken(c, refresh)
check('the token endpoint is called with HTTP Basic', seenAuth.startsWith('Basic '))
const decoded = Buffer.from(seenAuth.slice(6), 'base64').toString()
check('the credentials are form-encoded before base64, per RFC 6749',
      decoded === `${encodeURIComponent(CLIENT)}:${encodeURIComponent(SECRET)}`, decoded)
check('the raw secret is NOT what went over the wire', !decoded.includes(SECRET))
check('an access token comes back', first === 'at-1')

/* ------------------------------------------------ 4 · rotation, and never twice */

await c.query(`update oauth_token set access_expires_at = now() - interval '1 minute'
                where provider = 'mdv'`)
const second = await getAccessToken(c, refresh)
check('a second refresh presents the ROTATED token, not the original',
      presentedRefresh[1] === 'rotated-1', presentedRefresh.join(' , '))
check('and yields the next access token', second === 'at-2')
check('no refresh token was ever presented twice',
      new Set(presentedRefresh).size === presentedRefresh.length, presentedRefresh.join(' , '))
const stored = await c.query<{ rotation: number }>(
  `select rotation from oauth_token where provider = 'mdv'`)
check('the rotation counter tracks it', stored.rows[0]!.rotation === 2)

/* ------------------------------------------------------ 5 · nothing leaks to the log */

const events = await c.query<{ detail: string | null }>(
  `select detail from oauth_event where provider = 'mdv'`)
const details = events.rows.map(r => r.detail ?? '').join(' | ')
check('no token value appears in the audit trail',
      !details.includes('rotated-') && !details.includes('seed-token') && !details.includes(SECRET),
      details)

/* -------------------------------------------------------- 6 · a dead grant stops */

await reset()
await seedRefreshToken(c, { clientId: CLIENT, refreshToken: 'a-spent-token' })
let revoked = false
try { await getAccessToken(c, refresh) } catch (e) { revoked = e instanceof GrantRevokedError }
check('presenting a spent token surfaces as a revoked grant', revoked)
const row = await c.query<{ revoked_at: Date | null }>(
  `select revoked_at from oauth_token where provider = 'mdv'`)
check('and the row is marked, so nothing retries it', row.rows[0]!.revoked_at !== null)
let secondTry = false
try { await getAccessToken(c, refresh) } catch (e) { secondTry = e instanceof GrantRevokedError }
check('a later call fails fast instead of presenting it again', secondTry)

/* ------------------------------------------------------------- 7 · 429 and 401 */

await reset()
await seedRefreshToken(c, { clientId: CLIENT, refreshToken: 'seed-token-0' })
let slept: number[] = []
const client = new MdvClient({
  clientId: CLIENT, clientSecret: SECRET, base, tokenUrl,
  budget: new RateBudget(), sleep: async ms => { slept.push(ms) },
})
statusQueue = [429, 200]
getRetryAfter = '2'
const ok = await client.get<{ ok: boolean }>(c, '/booking/properties/')
check('a 429 is retried rather than thrown', ok.ok === true)
check('and the wait is what Retry-After asked for', slept[0] === 2_000, String(slept[0]))

slept = []; statusQueue = [429, 429, 429, 429]
let gaveUp = false
try { await client.get(c, '/booking/properties/') } catch (e) { gaveUp = e instanceof MdvError }
check('a provider that keeps saying 429 is eventually believed', gaveUp)
check('and it was not retried forever', slept.length === 3, `${slept.length} waits`)

// 401 on a token we believed live: expire ours, refresh once, try again.
await reset()
await seedRefreshToken(c, { clientId: CLIENT, refreshToken: 'seed-token-0' })
statusQueue = [401, 200]
const revived = await client.get<{ ok: boolean }>(c, '/booking/properties/')
check('a 401 forces one refresh and the call succeeds', revived.ok === true)
check('the refresh actually happened', presentedRefresh.length === 2, presentedRefresh.join(' , '))

await reset()
await seedRefreshToken(c, { clientId: CLIENT, refreshToken: 'seed-token-0' })
statusQueue = [401, 401]
let stillDead = false
try { await client.get(c, '/booking/properties/') } catch (e) { stillDead = e instanceof MdvError }
check('a second 401 is not retried again, so refresh tokens are not burned in a loop',
      stillDead)

/* --------------------------------------------------------- 8 · the path is right */

await reset()
await seedRefreshToken(c, { clientId: CLIENT, refreshToken: 'seed-token-0' })
const got = await client.get<{ path: string }>(c, 'booking/properties/', { limit: 5 })
check('a leading slash is optional and the base is applied once',
      got.path === '/api/v1/booking/properties/', got.path)

srv.close(); c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
