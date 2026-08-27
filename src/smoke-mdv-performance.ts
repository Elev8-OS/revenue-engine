/**
 * Rank and the market environment, against the live payload shape.
 *
 * Four judgements, each of which would produce a confident wrong number if it
 * went the other way:
 *
 *   · THE COMPARISON IS NOT "LAST YEAR" unless the provider says so. This
 *     endpoint compares against the prior period by default, and labelling that
 *     year-on-year is the kind of mislabelling that survives for months because
 *     both figures look plausible.
 *   · COUNTS OR SHARES IS DERIVED, NOT ASSUMED. `"2-6 nights": 41` is forty-one
 *     reservations or forty-one percent. A set of shares sums to about 100; a set
 *     of counts sums to the reservation total. Where neither holds, the answer is
 *     undecidable and the figure is kept but not charted.
 *   · CURRENCIES ARE NEVER SUMMED. CHF, EUR and IDR arrive separately; adding
 *     them gives a number in no currency at all.
 *   · RANK IS LOWER-IS-BETTER, and the change since the account was first measured
 *     is a separate fact from the period-on-period change.
 */
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { MdvClient, seedRefreshToken } from './sources/mdv/client.js'
import { importPerformance, unitOfBreakdown } from './sources/mdv/performance.js'
import { RateBudget } from './scheduler/budget.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

/* ------------------------------------------------------- 1 · the unit rule */

check('a set summing to about 100 is shares', unitOfBreakdown([41, 38, 21], 480) === 'share')
check('rounding does not break it', unitOfBreakdown([41.2, 37.9, 20.5], 480) === 'share')
check('a set summing to the reservation total is counts',
      unitOfBreakdown([200, 180, 100], 480) === 'count')
// The refusal. Neither 100 nor the reservation count, so no unit can be claimed.
check('a set matching neither is undecidable, and undecidable is an answer',
      unitOfBreakdown([200, 180, 100], 4800) === 'undecidable')
check('with no reservation total to test against, counts cannot be confirmed',
      unitOfBreakdown([200, 180, 100], null) === 'undecidable')

/* ------------------------------------------------------------ 2 · end to end */

const port = 4601
const perf = (idKey: string, breakdown: string, countryKey: string, yoy: boolean) => ({
  period_info: { compare_yoy: yoy, current_start: '2025-08-27', current_end: '2026-08-26',
                 comparison_start: '2024-08-27', comparison_end: '2025-08-26', days: 365 },
  reservations: { current: 480, previous: 430, change: { absolute: 50, percentage: 11.6 } },
  nights: { current: 1600, previous: 1500, change: { absolute: 100, percentage: 6.7 } },
  insights: {
    current: {
      cancellation_rate: 7.4,
      duration_breakdown: { '1 night': 21, '2-6 nights': 41, '7-30 nights': 38 },
      group_size_breakdown: { '1': 90, '2': 240, '3': 100, '4': 50 },
      [countryKey]: [{ country: 'au', count: 140 }, { country: 'de', count: 96 }],
    },
    comparison: {
      cancellation_rate: 5.9,
      duration_breakdown: { '1 night': 25, '2-6 nights': 40, '7-30 nights': 35 },
      group_size_breakdown: { '1': 80, '2': 220, '3': 90, '4': 40 },
      [countryKey]: [{ country: 'au', count: 120 }],
    },
  },
  ranking_timeline: { date_range: { start: '2026-08-20', end: '2026-08-26' },
    daily_ranks: [{ date: '2026-08-25', rank_percentile: 62.5, sampling_basis: 'x' },
                  { date: '2026-08-26', rank_percentile: 58.1, sampling_basis: 'x' }] },
  mydata_summary: { before_reservations: 300, current_reservations: 480,
                    days_since_implementation: 120 },
  [breakdown]: [{
    [idKey]: idKey === 'property_id' ? 801 : 'L801',
    property_name: 'Basel Flat', listing_name: 'Basel Flat',
    rank: { current: 12, comparison: 19, change_pct: -36.8 },
    rank_change_since_first: -7,
    nights: { current: 41, comparison: 33, change_pct: 24.2 },
    reservations: { current: 14, comparison: 11, change_pct: 27.3 },
    avg_los: { current: 2.9, comparison: 3.0, change_pct: -3.3 },
    // Three currencies. Summing them would give a number in no currency at all.
    adr: [{ currency: 'CHF', current: 148, comparison: 139, change_pct: 6.5 },
          { currency: 'EUR', current: 152, comparison: 144, change_pct: 5.6 },
          { currency: 'IDR', current: 2_400_000, comparison: 2_250_000, change_pct: 6.7 }],
    revenue: [{ currency: 'CHF', current: 6068, comparison: 4587, change_pct: 32.3 }],
  }, { [idKey]: idKey === 'property_id' ? 909 : 'L909', rank: { current: 40 } }],
})
const srv = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]!
  const json = (o: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o))
  }
  if (path === '/oauth/token') {
    return json({ access_token: 'at', refresh_token: `r${Math.random()}`, expires_in: 3600 })
  }
  if (path === '/api/v1/booking/performance/') {
    return json(perf('property_id', 'property_breakdown', 'top_countries', true))
  }
  if (path === '/api/v1/airbnb/performance/') {
    // The default the endpoint actually uses: the PRIOR period, not last year.
    return json(perf('listing_id', 'listing_breakdown', 'top_guest_locations', false))
  }
  res.writeHead(404); res.end()
})
await new Promise<void>(r => srv.listen(port, r))

const c = await pool.connect()
await c.query('delete from snapshot'); await c.query('delete from channel_insight')
await c.query('delete from entity_alias'); await c.query('delete from entity')
await c.query('delete from oauth_token'); await c.query('truncate oauth_event')
await seedRefreshToken(c, { clientId: 'cid', refreshToken: 'seed' })
const mk = async (l: string) => (await c.query<{ id: string }>(
  `insert into entity (label, market, active) values ($1, 'ch', true) returning id::text`,
  [l])).rows[0]!.id
const eB = await mk('Basel Flat')
const eA = await mk('Basel Flat Airbnb')
await c.query(`insert into entity_alias (entity_id, source, kind, external_id, matched_by)
  values ($1, 'mdv_booking', 'property', '801', 'test')`, [eB])
await c.query(`insert into entity_alias (entity_id, source, kind, external_id, matched_by)
  values ($1, 'mdv_airbnb', 'listing', 'L801', 'test')`, [eA])

const mdv = new MdvClient({
  clientId: 'cid', clientSecret: 'sec', base: `http://127.0.0.1:${port}/api/v1`,
  tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
  budget: new RateBudget(), sleep: async () => {},
})
const report = await importPerformance(c, mdv)
const bk = report.endpoints[0]!
const ab = report.endpoints[1]!

/* ------------------------------------------------------------- 3 · the rank */

const m = await c.query<{ metric: string, value: string, currency: string | null }>(
  `select metric, value::text, currency from snapshot where entity_id = $1 order by metric`,
  [eB])
const by = new Map(m.rows.filter(r => !r.currency).map(r => [r.metric, Number(r.value)]))
// The figure I recorded as "not sent by this account".
check('search rank arrives per object, with its previous value',
      by.get('perf_booking_rank') === 12 && by.get('perf_booking_rank_prior') === 19,
      [...by.keys()].join(','))
check('and the move since the account was first measured, which is a separate fact',
      by.get('perf_booking_rank_change_since_first') === -7, '')
check('nights, reservations and average stay come with their comparison too',
      by.get('perf_booking_nights') === 41 && by.get('perf_booking_reservations') === 14
      && by.get('perf_booking_avg_los') === 2.9, '')
check('an id matching nothing is reported rather than invented',
      bk.unresolvedIds.includes('909'), bk.unresolvedIds.join(','))

/* ------------------------------------------------------- 4 · the currencies */

// The currency is in the METRIC NAME, and the test proves why: snapshot's key is
// (entity, metric, stay_date, as_of) with no currency column, so three currencies
// under one name are three rows with one key. Postgres refused the whole batch —
// which is the only reason this was caught before a live run rather than after.
const cur = await c.query<{ metric: string, currency: string, value: string }>(
  `select metric, currency, value::text from snapshot
    where entity_id = $1 and metric like 'perf_booking_adr%'
      and metric not like '%prior%' order by metric`, [eB])
check('every currency gets its own metric name, so none can overwrite another',
      cur.rows.length === 3
      && cur.rows.map(r => r.metric).join(',')
         === 'perf_booking_adr_chf,perf_booking_adr_eur,perf_booking_adr_idr',
      cur.rows.map(r => r.metric).join(','))
check('and each keeps its own figure, never added together',
      Number(cur.rows.find(r => r.currency === 'CHF')!.value) === 148
      && Number(cur.rows.find(r => r.currency === 'IDR')!.value) === 2_400_000, '')
check('the currency column is still filled, because the page needs it to format',
      cur.rows.every(r => Boolean(r.currency)), '')
check('the pass says which currencies it kept apart',
      bk.currencies.join(',') === 'CHF,EUR,IDR' && /currencies kept apart/.test(bk.note),
      bk.note)

/* ------------------------------------------------- 5 · the market environment */

const ins = await c.query<{
  section: string, label: string, value: string, comparison: string | null,
  unit: string, compare_yoy: boolean | null
}>(`select section, label, value::text, comparison::text, unit, compare_yoy
      from channel_insight where source = 'mdv_booking' order by section, label`)
const dur = ins.rows.filter(r => r.section === 'duration')
check('the stay-length breakdown is stored with its comparison beside it',
      dur.length === 3 && dur.some(r => r.label === '2-6 nights'
        && Number(r.value) === 41 && Number(r.comparison) === 40),
      JSON.stringify(dur))
// 21 + 41 + 38 = 100 → shares. Derived, not assumed.
check('and its unit is derived: these sum to 100, so they are shares',
      dur.every(r => r.unit === 'share') && bk.units.duration === 'share', bk.units.duration)
// 90 + 240 + 100 + 50 = 480 = the reservation total → counts.
const grp = ins.rows.filter(r => r.section === 'group_size')
check('the group-size breakdown sums to the reservation total, so it is counts',
      grp.every(r => r.unit === 'count') && bk.units.group_size === 'count',
      bk.units.group_size)
const ctry = ins.rows.filter(r => r.section === 'country')
check('guest origin arrives ten deep, upper-cased, with the prior period',
      ctry.some(r => r.label === 'AU' && Number(r.value) === 140
        && Number(r.comparison) === 120), JSON.stringify(ctry))
check('a country with no prior figure gets null, not zero',
      ctry.find(r => r.label === 'DE')?.comparison === null,
      JSON.stringify(ctry.find(r => r.label === 'DE')))
check('the cancellation rate is stored with its change',
      ins.rows.some(r => r.section === 'rate' && Number(r.value) === 7.4
        && Number(r.comparison) === 5.9), '')
check('the daily rank percentile is kept per date, because a rank that moved is the finding',
      ins.rows.filter(r => r.section === 'rank_timeline').length === 2, '')

/* ------------------------------------------- 6 · what the comparison actually is */

check('a year-on-year comparison is recorded as one',
      bk.compareYoy === true && ins.rows.every(r => r.compare_yoy === true), '')
// The one that matters: this endpoint defaults to the prior period.
check('a PRIOR-PERIOD comparison is not passed off as last year',
      ab.compareYoy === false && /NOT last year/.test(ab.note), ab.note)
const abYoy = await c.query<{ n: number }>(
  `select count(*)::int n from channel_insight
    where source = 'mdv_airbnb' and compare_yoy is true`)
check('and nothing on that channel is stored as year-on-year',
      abYoy.rows[0]!.n === 0, String(abYoy.rows[0]!.n))

/* ------------------------------------------------- 7 · the vendor's own claim */

// Recorded, not displayed: a provider's before-and-after about its own product,
// with no control arm. The holdout design exists so effect claims can be made
// properly; until it runs, the honest place for this is a log line.
check('the provider’s claim about its own effect is reported, never stored',
      bk.vendorClaim !== null && /no control arm/.test(bk.vendorClaim ?? ''),
      bk.vendorClaim ?? '')
check('and it reaches no table',
      (await c.query<{ n: number }>(
        `select count(*)::int n from channel_insight where label ilike '%mydata%'`
      )).rows[0]!.n === 0)

check('no entity was created by a signal pass',
      (await c.query<{ n: number }>(`select count(*)::int n from entity`)).rows[0]!.n === 2)

srv.close(); c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
