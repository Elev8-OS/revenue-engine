/**
 * The funnel adapter, against a stand-in provider that uses names we did NOT
 * anticipate.
 *
 * That is the whole point of the suite. Any test that fed the adapter the exact
 * keys its candidate lists already contain would prove only that a lookup table
 * works. The property worth protecting is what happens on the day the payload
 * says something else: does a figure still arrive, is the substitution written
 * down, and — the case that actually costs money — is a number we cannot defend
 * withheld rather than shown.
 *
 * So the Booking fixture below answers `search_appearances` where the list's
 * first candidate is `impressions`, and carries two keys nothing asks for. The
 * Airbnb fixture answers a rate with an unstated scale, a sentinel, and a row
 * for an id no room in the portfolio holds.
 */
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { MdvClient, seedRefreshToken } from './sources/mdv/client.js'
import { importFunnel, resolveFields, rateUnit, countOf,
         BOOKING_RANKING, AIRBNB_RANKING } from './sources/mdv/funnel.js'
import { RateBudget } from './scheduler/budget.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

/* ------------------------------------------------- 1 · the resolver, in isolation */

const resolved = resolveFields([
  { property_id: 7, search_appearances: 99_014, property_views: 743, conversions: 12,
    bubble_score: 8.6, secret_deal_active: true },
  { property_id: 8, search_appearances: 1_200, property_views: 30, conversions: 1,
    bubble_score: 8.1, secret_deal_active: false },
], BOOKING_RANKING)

check('a name lower down the candidate list still carries the figure',
      resolved.used.impressions === 'search_appearances', JSON.stringify(resolved.used))
check('and the substitution is written down, so a number can be traced to its field',
      Object.keys(resolved.used).includes('impressions'))
check('a concept nothing matched is NAMED, not silently zero',
      resolved.missing.includes('providerViewRate'), resolved.missing.join(','))
// The field this whole design exists for. Everything else reports what worked.
check('keys nobody asked for come back, which is how a wrong list gets fixed',
      resolved.unclaimed.join(',') === 'bubble_score,secret_deal_active',
      resolved.unclaimed.join(','))

const legacy = resolveFields([
  { listing_id: 'a', impressions: null, search_impressions: 40, views: 2 },
  { listing_id: 'b', impressions: null, search_impressions: 60, views: 3 },
], AIRBNB_RANKING)
check('a legacy field kept alive but empty does not win on being listed first',
      legacy.used.impressions === 'search_impressions', JSON.stringify(legacy.used))

const zeroes = resolveFields([{ listing_id: 'a', impressions: 0, views: 0 }], AIRBNB_RANKING)
check('zero is a measurement and must not read as absent',
      zeroes.used.impressions === 'impressions', JSON.stringify(zeroes.used))

/* --------------------------------------------------------- 2 · scale and sentinels */

check('a column reaching above 1 is percent', rateUnit([0.4, 3.4, 8.52]) === 'percent')
check('a column under 1 but above a hundredth is a fraction',
      rateUnit([0.0153, 0.0852]) === 'fraction')
// The refusal that matters: 0.004 is 0.4% or 0.004%, and nothing decides it.
check('a column of very small numbers is undecidable, and undecidable is an answer',
      rateUnit([0.004, 0.002]) === 'undecidable')
check('no values at all is undecidable rather than zero', rateUnit([]) === 'undecidable')
check('a negative count is a sentinel, not a number', countOf(-1) === null)
check('but zero survives', countOf(0) === 0)
check('a numeric string is a number', countOf('743') === 743)
check('and text is not', countOf('n/a') === null)

/* ------------------------------------------------------ 3 · end to end, with a DB */

const port = 4597
const BOOKING_ROWS = [
  // `search_appearances`, not `impressions`. 743 of 99'014 is 0.75% — the measured
  // figure from August, and the one that rounds to a misleading "1%".
  { property_id: 501, search_appearances: 99_014, property_views: 743, conversions: 12 },
  { property_id: 502, search_appearances: 1_000, property_views: -1, conversions: 0 },
]
const AIRBNB_ROWS = [
  { listing_id: 'L1', stay_date: '2026-09-01', impressions: 400, views: 34,
    bookings: 2, search_to_view_rate: 8.5 },
  { listing_id: 'L1', stay_date: '2026-09-02', impressions: 600, views: 6,
    bookings: 0, search_to_view_rate: 1.0 },
  // An id the portfolio does not hold. Must be reported, never invented.
  { listing_id: 'GHOST', stay_date: '2026-09-01', impressions: 10, views: 1, bookings: 0,
    search_to_view_rate: 10 },
  // No date it is about: unfilable forward, and guessing today would put next
  // month's impressions on tonight.
  { listing_id: 'L1', stay_date: null, impressions: 5, views: 1, bookings: 0 },
]
const srv = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]!
  const json = (o: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o))
  }
  if (path === '/oauth/token') {
    return json({ access_token: 'at', refresh_token: `r${Math.random()}`, expires_in: 3600 })
  }
  if (path === '/api/v1/booking/ranking/') return json({ results: BOOKING_ROWS })
  if (path === '/api/v1/airbnb/ranking/') return json({ results: AIRBNB_ROWS })
  // Demand is team-wide on this account: rows with no per-object id at all.
  if (path === '/api/v1/booking/demand/') {
    return json({ results: [{ date: '2026-09-01', searches: 9_000, reservations: 40 }] })
  }
  res.writeHead(404); res.end()
})
await new Promise<void>(r => srv.listen(port, r))

const c = await pool.connect()
await c.query('delete from snapshot')
await c.query('delete from entity_alias'); await c.query('delete from entity')
await c.query('delete from oauth_token'); await c.query('truncate oauth_event')
await seedRefreshToken(c, { clientId: 'cid', refreshToken: 'seed' })

const mk = async (label: string) => {
  const { rows } = await c.query<{ id: string }>(
    `insert into entity (label, market, active)
     values ($1, 'ch', true) returning id::text`, [label])
  return rows[0]!.id
}
const bookingEntity = await mk('Basel Flat')
const airbnbEntity = await mk('Canggu Villa')
// The alias kinds MDV addresses: a Booking object is a 'property', an Airbnb one
// a 'listing'. Written here as objects.ts would have written them.
await c.query(`insert into entity_alias (entity_id, source, kind, external_id, matched_by)
  values ($1, 'mdv_booking', 'property', '501', 'mdv_property_id')`, [bookingEntity])
await c.query(`insert into entity_alias (entity_id, source, kind, external_id, matched_by)
  values ($1, 'mdv_airbnb', 'listing', 'L1', 'ota_id')`, [airbnbEntity])
// 502 deliberately has no alias.

const mdv = new MdvClient({
  clientId: 'cid', clientSecret: 'sec',
  base: `http://127.0.0.1:${port}/api/v1`,
  tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
  budget: new RateBudget(), sleep: async () => {},
})
const report = await importFunnel(c, mdv)

check('the pass reports one outcome per endpoint, so one refusal cannot hide the rest',
      report.endpoints.length === 3, JSON.stringify(report.endpoints.map(e => e.path)))
check('and it stored something', report.anyStored && report.snapshotRows > 0,
      String(report.snapshotRows))

const booking = report.endpoints.find(e => e.path === '/booking/ranking/')!
check('booking resolved impressions to the name the payload actually used',
      booking.resolution.used.impressions === 'search_appearances',
      JSON.stringify(booking.resolution.used))
check('the id that matched no room is reported with its id, not invented',
      booking.unresolvedIds.includes('502'), booking.unresolvedIds.join(','))

const trailing = await c.query<{ metric: string, value: string, stay_date: Date }>(
  `select metric, value::text, stay_date from snapshot
    where entity_id = $1 order by metric`, [bookingEntity])
const byMetric = new Map(trailing.rows.map(r => [r.metric, Number(r.value)]))
check('booking figures are stored as trailing, because the provider never named a window',
      [...byMetric.keys()].every(m => m.endsWith('_trailing')),
      [...byMetric.keys()].join(','))
check('impressions survive verbatim',
      byMetric.get('funnel_impressions_trailing') === 99_014,
      String(byMetric.get('funnel_impressions_trailing')))
// 743/99014 = 0.00750398..., computed here and never taken from the provider.
//
// The tolerance is the SCHEMA's, not a fudge: snapshot.value is numeric(18,6), so a
// fraction lands with six decimals. That is one part in a million on a rate — a
// single view out of a million impressions — and it is worth writing down that the
// storage decides the resolution here, because the same column also holds prices
// where six decimals is generous and occupancy where it is absurd.
const STORED = 1e-6
const vr = byMetric.get('funnel_view_rate_trailing')
check('the view rate is computed from the two counts, as a fraction',
      vr !== undefined && Math.abs(vr - 743 / 99_014) < STORED, String(vr))
check('and the book rate too', Math.abs((byMetric.get('funnel_book_rate_trailing') ?? 0)
      - 12 / 743) < STORED, String(byMetric.get('funnel_book_rate_trailing')))

const airbnb = report.endpoints.find(e => e.path === '/airbnb/ranking/')!
check('airbnb rows are filed per stay date, not collapsed onto today',
      airbnb.rateUnit === 'percent', airbnb.rateUnit)
const fwd = await c.query<{ n: number }>(
  `select count(*)::int n from snapshot
    where entity_id = $1 and metric = 'funnel_impressions'`, [airbnbEntity])
check('two dated rows arrive and the undated one does not',
      fwd.rows[0]!.n === 2, String(fwd.rows[0]!.n))
const dates = await c.query<{ stay_date: Date }>(
  `select stay_date from snapshot where entity_id = $1 and metric = 'funnel_impressions'
    order by stay_date`, [airbnbEntity])
check('and they carry the date they are about',
      dates.rows[0]!.stay_date.toISOString().slice(0, 10) === '2026-09-01')
check('the ghost id is reported rather than given a room',
      airbnb.unresolvedIds.includes('GHOST'), airbnb.unresolvedIds.join(','))
const ghost = await c.query<{ n: number }>(`select count(*)::int n from entity`)
check('and no entity was created by a signal pass', ghost.rows[0]!.n === 2,
      String(ghost.rows[0]!.n))

// 8.5 and 1.0 and 10 — max above 1, so percent, so 8.5 becomes 0.085.
const provided = await c.query<{ value: string }>(
  `select value::text from snapshot
    where entity_id = $1 and metric = 'funnel_provider_view_rate'
    order by stay_date limit 1`, [airbnbEntity])
check('a provider rate is stored only once its scale is settled, normalised to a fraction',
      provided.rows.length === 1 && Math.abs(Number(provided.rows[0]!.value) - 0.085) < 1e-9,
      JSON.stringify(provided.rows))

const demand = report.endpoints.find(e => e.path === '/booking/demand/')!
check('a team-wide report says so instead of writing nothing and looking broken',
      demand.snapshotRows === 0 && /about the account and not about a listing/.test(demand.note),
      demand.note)

// The sentinel: -1 property_views on 502. That row resolves to no entity anyway,
// so the sentinel is proven on the shape recording instead of the snapshot.
const shapes = await c.query<{ n: number }>(
  `select count(*)::int n from api_shape where source = 'mdv' and endpoint like '%ranking%'`)
check('every pass records the shape it saw, whether or not it could map it',
      shapes.rows[0]!.n >= 2, String(shapes.rows[0]!.n))

srv.close(); c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
