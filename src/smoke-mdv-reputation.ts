/**
 * Reviews and promotions, against a provider that names things its own way.
 *
 * The judgements worth protecting here are not "does it parse". They are:
 *
 *   · a review count of ZERO survives, because a listing nobody has reviewed is
 *     the finding, while a review SCORE of zero is withheld — no channel scores a
 *     listing 0, so a zero there is an empty field wearing a number;
 *   · `null` and `false` on a promotion switch stay different facts, so the page
 *     can never report a programme as switched off on a field that never arrived;
 *   · a promotion row with no object id is kept as account-level rather than
 *     pinned to a listing, because the take-rate stack multiplies and a
 *     misattributed discount misstates a margin instead of rounding it;
 *   · nothing is ever created — the alias lookup is read-only.
 */
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { MdvClient, seedRefreshToken } from './sources/mdv/client.js'
import { importReputation, scoreOf, switchOf, REVIEWS } from './sources/mdv/reputation.js'
import { resolveFields } from './sources/mdv/fields.js'
import { RateBudget } from './scheduler/budget.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

/* --------------------------------------------------- 1 · the two value gates */

check('a score of zero is withheld: no channel rates a listing zero',
      scoreOf(0) === null)
check('a plausible score survives on either scale', scoreOf(8.6) === 8.6 && scoreOf(4.7) === 4.7)
check('a score above any review scale is refused', scoreOf(140) === null)
check('an explicit false is off', switchOf(false) === false && switchOf('expired') === false)
check('an explicit true is on', switchOf(true) === true && switchOf('active') === true)
// The distinction the page depends on. "Not stated" must never render as "off".
check('a missing switch is neither on nor off',
      switchOf(undefined) === null && switchOf(null) === null && switchOf('perhaps') === null)

const res = resolveFields([
  { property_id: 5, guest_rating: 8.9, total_reviews: 41, data_as_of: '2026-08-26' },
], REVIEWS)
check('a review payload using its own words still resolves',
      res.used.score === 'guest_rating' && res.used.count === 'total_reviews',
      JSON.stringify(res.used))
check('and nothing is left unclaimed', res.unclaimed.length === 0, res.unclaimed.join(','))

/* ------------------------------------------------------- 2 · end to end */

const port = 4598
const srv = createServer((req, res2) => {
  const path = (req.url ?? '').split('?')[0]!
  const json = (o: unknown) => {
    res2.writeHead(200, { 'content-type': 'application/json' }); res2.end(JSON.stringify(o))
  }
  if (path === '/oauth/token') {
    return json({ access_token: 'at', refresh_token: `r${Math.random()}`, expires_in: 3600 })
  }
  if (path === '/api/v1/booking/reviews/') {
    return json({ results: [
      { property_id: 601, review_score: 8.6, review_count: 41, data_as_of: '2026-08-26T04:00:00Z' },
      // The structural handicap: a perfect score on one review.
      { property_id: 602, review_score: 10, review_count: 1 },
      // Never reviewed. The count is the finding, so zero must survive.
      { property_id: 603, review_score: 0, review_count: 0 },
      { property_id: 999, review_score: 9, review_count: 12 },
    ] })
  }
  if (path === '/api/v1/airbnb/reviews/') {
    return json({ results: [{ listing_id: 'A1', review_score: 4.8, review_count: 63 }] })
  }
  if (path === '/api/v1/booking/promotions/') {
    return json({ results: [
      { property_id: 601, promotion_type: 'genius', active: true, discount_percentage: 10 },
      { property_id: 601, promotion_type: 'mobile_discount', active: false },
      // No switch at all: must land as null, not false.
      { property_id: 601, promotion_type: 'preferred' },
      // No object id: the report is team-wide, so this stays account-level.
      { promotion_type: 'visibility_booster', active: true, discount_percentage: 12,
        end_date: '2026-09-30' },
    ] })
  }
  res2.writeHead(404); res2.end()
})
await new Promise<void>(r => srv.listen(port, r))

const c = await pool.connect()
await c.query('delete from snapshot'); await c.query('delete from channel_promotion')
await c.query('delete from entity_alias'); await c.query('delete from entity')
await c.query('delete from oauth_token'); await c.query('truncate oauth_event')
await seedRefreshToken(c, { clientId: 'cid', refreshToken: 'seed' })

const mk = async (label: string) => (await c.query<{ id: string }>(
  `insert into entity (label, market, active) values ($1, 'ch', true) returning id::text`,
  [label])).rows[0]!.id
const e601 = await mk('Well reviewed')
const e602 = await mk('One review')
const e603 = await mk('Never reviewed')
const eA1 = await mk('Airbnb side')
for (const [id, ext, src, kind] of [
  [e601, '601', 'mdv_booking', 'property'], [e602, '602', 'mdv_booking', 'property'],
  [e603, '603', 'mdv_booking', 'property'], [eA1, 'A1', 'mdv_airbnb', 'listing'],
] as const) {
  await c.query(`insert into entity_alias (entity_id, source, kind, external_id, matched_by)
    values ($1, $2, $3::alias_kind, $4, 'test')`, [id, src, kind, ext])
}

const mdv = new MdvClient({
  clientId: 'cid', clientSecret: 'sec',
  base: `http://127.0.0.1:${port}/api/v1`,
  tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
  budget: new RateBudget(), sleep: async () => {},
})
const report = await importReputation(c, mdv)

check('three endpoints, three outcomes', report.endpoints.length === 3,
      report.endpoints.map(e => e.path).join(','))
check('reviews were stored', report.reviewRows > 0, String(report.reviewRows))

const rv = await c.query<{ metric: string, value: string }>(
  `select metric, value::text from snapshot where entity_id = $1 order by metric`, [e601])
const by = new Map(rv.rows.map(r => [r.metric, Number(r.value)]))
check('the channel is in the metric name, as it must be for two channels',
      by.has('reviews_booking_score') && by.has('reviews_booking_count'),
      [...by.keys()].join(','))
check('score and count arrive verbatim',
      by.get('reviews_booking_score') === 8.6 && by.get('reviews_booking_count') === 41,
      JSON.stringify([...by.entries()]))

const never = await c.query<{ metric: string, value: string }>(
  `select metric, value::text from snapshot where entity_id = $1`, [e603])
const nby = new Map(never.rows.map(r => [r.metric, Number(r.value)]))
// The point of the whole pass: a listing nobody has reviewed must be visible AS
// that, so the count of zero is stored and the meaningless zero score is not.
check('a never-reviewed listing keeps its zero COUNT',
      nby.get('reviews_booking_count') === 0, JSON.stringify([...nby.entries()]))
check('and does not get a zero SCORE it never earned',
      !nby.has('reviews_booking_score'), [...nby.keys()].join(','))

const airbnb = await c.query<{ n: number }>(
  `select count(*)::int n from snapshot where metric like 'reviews_airbnb_%'`)
check('the other channel writes under its own names', airbnb.rows[0]!.n === 2,
      String(airbnb.rows[0]!.n))
const booking = report.endpoints[0]!
check('an id matching nothing is reported with its id',
      booking.unresolvedIds.includes('999'), booking.unresolvedIds.join(','))
check('and no entity was invented',
      (await c.query<{ n: number }>(`select count(*)::int n from entity`)).rows[0]!.n === 4)

/* --------------------------------------------------------- 3 · promotions */

const promo = report.endpoints[2]!
check('promotions were stored', promo.stored === 4, String(promo.stored))
check('the label vocabulary comes back, in the provider’s own words',
      promo.vocabulary.join(',') === 'genius,mobile_discount,preferred,visibility_booster',
      promo.vocabulary.join(','))

const mine = await c.query<{ kind: string, active: boolean | null, discount_pct: string | null }>(
  `select kind, active, discount_pct::text from channel_promotion
    where entity_id = $1 order by kind`, [e601])
check('an object keeps its own levers', mine.rows.length === 3,
      JSON.stringify(mine.rows))
check('on stays on, off stays off',
      mine.rows.find(r => r.kind === 'genius')?.active === true
      && mine.rows.find(r => r.kind === 'mobile_discount')?.active === false,
      JSON.stringify(mine.rows))
// The one that protects a margin statement.
check('a lever with no switch is NOT reported as switched off',
      mine.rows.find(r => r.kind === 'preferred')?.active === null,
      JSON.stringify(mine.rows.find(r => r.kind === 'preferred')))
check('a stated rate is kept as stated',
      Number(mine.rows.find(r => r.kind === 'genius')?.discount_pct) === 10)

const acct = await c.query<{ kind: string, ends_on: Date | null }>(
  `select kind, ends_on from channel_promotion where entity_id is null`)
check('a row with no object id stays account-level rather than pinned to a listing',
      acct.rows.length === 1 && acct.rows[0]!.kind === 'visibility_booster',
      JSON.stringify(acct.rows))
check('and its window survives',
      acct.rows[0]!.ends_on?.toISOString().slice(0, 10) === '2026-09-30')
check('the pass says how many rows it could not attribute',
      promo.unattributed === 1 && /team-wide/.test(promo.note), promo.note)

// Idempotence: pressing the button twice must not double the levers.
await importReputation(c, mdv)
const again = await c.query<{ n: number }>(`select count(*)::int n from channel_promotion`)
check('running twice on one day does not duplicate a lever', again.rows[0]!.n === 4,
      String(again.rows[0]!.n))

srv.close(); c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
