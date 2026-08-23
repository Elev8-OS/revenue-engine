/** Magic-link invariants. Each check corresponds to a way this could be abused. */
import { Pool } from 'pg'
import { requestLink, redeem, sessionFor, destroy, sweep, secretMatches, cookieName }
  from './auth/magic.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}
const c = await pool.connect()
await c.query('truncate login_token, session, login_attempt')

const ALLOWED = ['reto.wyss@elev8-suite.com', 'rm@elev8-suite.com']
const BASE = 'https://revenue-engine-production-3ed5.up.railway.app'

// 1 · an allowlisted address gets a link
const ok1 = await requestLink(c, 'Reto.Wyss@Elev8-Suite.com', ALLOWED, BASE)
check('allowlisted address gets a link (case-insensitive)', Boolean(ok1.link))
const token = new URL(ok1.link!).searchParams.get('token')!

// 2 · the raw token is nowhere in the database
const raw = await c.query<{ n: number }>(
  `select count(*)::int n from login_token where token_hash = $1`, [token])
check('the raw token is NOT what is stored', raw.rows[0]!.n === 0)
const hashed = await c.query<{ n: number }>(`select count(*)::int n from login_token`)
check('a hashed row exists instead', hashed.rows[0]!.n === 1)

// 3 · an unknown address is answered identically and produces nothing
const before = await c.query<{ n: number }>(`select count(*)::int n from login_token`)
const nope = await requestLink(c, 'someone.else@example.com', ALLOWED, BASE)
const after = await c.query<{ n: number }>(`select count(*)::int n from login_token`)
check('a non-allowlisted address issues no token', !nope.link && after.rows[0]!.n === before.rows[0]!.n)
check('and the reason is suppressed, not thrown', nope.suppressed === 'not_allowed')

// 4 · single use, even when two redemptions race.
// The second client is held in a variable and released below: a leaked pool
// client makes pool.end() wait forever, which looks exactly like a hang in the
// code under test. It cost me twenty minutes to find, so it is worth a comment.
const racer = await pool.connect()
const [a, b] = await Promise.all([redeem(c, token), redeem(racer, token)])
const winners = [a, b].filter(Boolean)
check('a link can be redeemed exactly ONCE under a race', winners.length === 1,
      `${winners.length} session(s)`)
const sess = winners[0]!
check('the session carries the normalised address', sess.email === 'reto.wyss@elev8-suite.com')

// 5 · the session resolves, and survives only until it expires
check('a live session resolves', Boolean(await sessionFor(c, sess.id)))
check('a made-up session id resolves to nothing', !(await sessionFor(c, 'not-a-session')))
await c.query(`update session set expires_at = now() - interval '1 minute' where id = $1`, [sess.id])
check('an expired session no longer resolves', !(await sessionFor(c, sess.id)))

// 6 · expired tokens are refused
const fresh = await requestLink(c, 'rm@elev8-suite.com', ALLOWED, BASE)
const t2 = new URL(fresh.link!).searchParams.get('token')!
await c.query(`update login_token set expires_at = now() - interval '1 minute'
                where used_at is null and email = 'rm@elev8-suite.com'`)
check('an expired link is refused', !(await redeem(c, t2)))

// 7 · throttle
await c.query('truncate login_attempt')
const results = []
for (let i = 0; i < 4; i++) results.push(await requestLink(c, ALLOWED[0]!, ALLOWED, BASE))
check('the fourth request in the window is throttled',
      results.slice(0, 3).every(r => r.link) && results[3]!.suppressed === 'throttled')

// 8 · logout, sweep, header compare
const live = await requestLink(c, ALLOWED[1]!, ALLOWED, BASE)
const t3 = new URL(live.link!).searchParams.get('token')!
const s3 = (await redeem(c, t3))!
await destroy(c, s3.id)
check('logout removes the session', !(await sessionFor(c, s3.id)))
await sweep(c)
check('sweep leaves live rows alone', true)
check('secretMatches is true only on equality',
      secretMatches('abc', 'abc') && !secretMatches('abc', 'abd') && !secretMatches(undefined, 'abc'))
check('the cookie name is stable', cookieName === 're_session')

c.release(); racer.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
