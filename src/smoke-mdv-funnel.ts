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
// The names MDV actually sent, taken off the live report: `search_views` for the
// wide stage, `property_views` for the page, `booking_conversions` for the sale.
// The two rate field names are what prove that ordering — `search_to_view_rate`
// and `view_to_booking_rate` name their own endpoints, so the chain is the
// provider's own and not our reading of three nouns.
const BOOKING_ROWS: Array<Record<string, unknown>> = [
  { property_id: 501, search_views: 99_014, property_views: 743,
    booking_conversions: 12, data_as_of: '2026-08-26T04:00:00Z' },
  { property_id: 502, search_views: 1_000, property_views: -1, booking_conversions: 0 },
]
// Documented as forward per stay date; this account sends ONE ROW PER LISTING with
// no date at all. The axis must come from the payload, or all of it is unfilable.
const AIRBNB_ROWS: Array<Record<string, unknown>> = [
  { listing_id: 'L1', search_views: 1_000, property_views: 40,
    booking_conversions: 2, search_to_view_rate: 4.0, view_to_booking_rate: 5.0 },
  { listing_id: 'GHOST', search_views: 10, property_views: 1, booking_conversions: 0,
    search_to_view_rate: 10 },
]
// A DATED Airbnb payload, used to prove the axis flips on the data and not on a
// flag we set: the same adapter must file these per night.
const AIRBNB_DATED = [
  { listing_id: 'L1', stay_date: '2026-09-01', search_views: 400, property_views: 34,
    booking_conversions: 2, search_to_view_rate: 8.5 },
  { listing_id: 'L1', stay_date: '2026-09-02', search_views: 600, property_views: 6,
    booking_conversions: 0, search_to_view_rate: 1.0 },
]
// Demand came back long-form: section / category / value, no metric columns.
const DEMAND_ROWS = [
  { property_id: 501, date: '2026-09-01', section: 'Demand', category: 'Searches',
    value: 9_000, data_as_of: '2026-08-26T04:00:00Z' },
  { property_id: 501, date: '2026-09-01', section: 'Demand', category: 'Reservations',
    value: 40, data_as_of: '2026-08-26T04:00:00Z' },
]
let airbnbDated = false
const srv = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]!
  const json = (o: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o))
  }
  if (path === '/oauth/token') {
    return json({ access_token: 'at', refresh_token: `r${Math.random()}`, expires_in: 3600 })
  }
  if (path === '/api/v1/booking/ranking/') return json({ results: BOOKING_ROWS })
  if (path === '/api/v1/airbnb/ranking/') {
    return json({ results: airbnbDated ? AIRBNB_DATED : AIRBNB_ROWS })
  }
  if (path === '/api/v1/booking/demand/') return json({ results: DEMAND_ROWS })
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
/**
 * THE FIXTURE THAT WAS MISSING, and its absence let a real bug ship.
 *
 * The old suite gave each channel its own entity, so it proved that two rows with
 * two sources exist — and never once asked what happens when ONE apartment is
 * listed on BOTH OTAs. That is the normal case in this portfolio, and there the
 * two channels wrote the same metric name for the same object on the same day.
 * `snapshot`'s primary key has no source column, so the second pass overwrote the
 * first and every dual-listed room showed exactly one chain.
 *
 * A test that cannot fail on the portfolio's most common shape is not a test.
 */
const bothEntity = await mk('Listed on both')
await c.query(`insert into entity_alias (entity_id, source, kind, external_id, matched_by)
  values ($1, 'mdv_booking', 'property', '777', 'mdv_property_id')`, [bothEntity])
await c.query(`insert into entity_alias (entity_id, source, kind, external_id, matched_by)
  values ($1, 'mdv_airbnb', 'listing', 'B777', 'ota_id')`, [bothEntity])
BOOKING_ROWS.push({ property_id: 777, search_views: 5_000, property_views: 100,
                    booking_conversions: 4, data_as_of: '2026-08-26T04:00:00Z' })
AIRBNB_ROWS.push({ listing_id: 'B777', search_views: 800, property_views: 60,
                   booking_conversions: 3, search_to_view_rate: 7.5,
                   view_to_booking_rate: 5.0 })
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
check('booking resolved the wide stage to the name the payload actually used',
      booking.resolution.used.impressions === 'search_views',
      JSON.stringify(booking.resolution.used))
check('and the sale stage too',
      booking.resolution.used.conversions === 'booking_conversions')
check('nothing is left unclaimed once the list matches the payload',
      booking.resolution.unclaimed.length === 0, booking.resolution.unclaimed.join(','))
check('the id that matched no room is reported with its id, not invented',
      booking.unresolvedIds.includes('502'), booking.unresolvedIds.join(','))
check('a payload with no date field is filed as trailing, and says so',
      booking.axis === 'trailing' && /window is the provider/.test(booking.note),
      booking.note)

const trailing = await c.query<{ metric: string, value: string }>(
  `select metric, value::text from snapshot where entity_id = $1 order by metric`,
  [bookingEntity])
const byMetric = new Map(trailing.rows.map(r => [r.metric, Number(r.value)]))
check('every booking figure is stored as trailing',
      [...byMetric.keys()].every(m => m.endsWith('_trailing')),
      [...byMetric.keys()].join(','))
check('the whole chain arrives, not just the middle of it',
      byMetric.get('funnel_booking_impressions_trailing') === 99_014
      && byMetric.get('funnel_booking_views_trailing') === 743
      && byMetric.get('funnel_booking_conversions_trailing') === 12,
      [...byMetric.entries()].map(([k, v]) => `${k}=${v}`).join(' '))
// 743/99014 = 0.00750398..., computed here and never taken from the provider.
//
// The tolerance is the SCHEMA's, not a fudge: snapshot.value is numeric(18,6), so a
// fraction lands with six decimals. That is one part in a million on a rate — a
// single view out of a million impressions — and it is worth writing down that the
// storage decides the resolution here, because the same column also holds prices
// where six decimals is generous and occupancy where it is absurd.
const STORED = 1e-6
const vr = byMetric.get('funnel_booking_view_rate_trailing')
check('the view rate is computed from the two counts, as a fraction',
      vr !== undefined && Math.abs(vr - 743 / 99_014) < STORED, String(vr))
check('and the book rate too', Math.abs((byMetric.get('funnel_booking_book_rate_trailing') ?? 0)
      - 12 / 743) < STORED, String(byMetric.get('funnel_booking_book_rate_trailing')))

const airbnb = report.endpoints.find(e => e.path === '/airbnb/ranking/')!
// The defect this replaces: the axis was DECLARED forward because the provider
// documents it that way. This account sends no date, so every matched row was
// withheld and the run stored nothing while reporting the fields it had found.
check('an undated airbnb payload is filed as trailing rather than withheld whole',
      airbnb.axis === 'trailing' && airbnb.snapshotRows > 0,
      `${airbnb.axis} ${airbnb.snapshotRows}`)
check('the ghost id is reported rather than given a room',
      airbnb.unresolvedIds.includes('GHOST'), airbnb.unresolvedIds.join(','))
check('and no entity was created by a signal pass',
      (await c.query<{ n: number }>(`select count(*)::int n from entity`)).rows[0]!.n === 3)

// THE COLLAPSE THIS PREVENTS: both channels answer with the same field names and
// the same axis, so both write `funnel_impressions_trailing`. Keyed on the metric
// alone, one channel would vanish behind the other's max().
// THE ASSERTION THAT WOULD HAVE CAUGHT IT. One apartment, both OTAs, and both
// chains must survive the pass — not whichever ran last.
const dual = await c.query<{ metric: string, value: string }>(
  `select metric, value::text from snapshot where entity_id = $1 order by metric`,
  [bothEntity])
const dualBy = new Map(dual.rows.map(r => [r.metric, Number(r.value)]))
check('an apartment on both OTAs keeps BOTH funnels, not the one that wrote last',
      dualBy.get('funnel_booking_impressions_trailing') === 5_000
      && dualBy.get('funnel_airbnb_impressions_trailing') === 800,
      [...dualBy.keys()].join(','))
check('and every stage of both, so neither chain is half a chain',
      dualBy.get('funnel_booking_views_trailing') === 100
      && dualBy.get('funnel_booking_conversions_trailing') === 4
      && dualBy.get('funnel_airbnb_views_trailing') === 60
      && dualBy.get('funnel_airbnb_conversions_trailing') === 3,
      JSON.stringify([...dualBy.entries()]))
// The mechanism, stated: the primary key cannot separate them, so the name must.
check('no metric name is shared between the two channels',
      [...dualBy.keys()].every(m => m.startsWith('funnel_booking_')
                                 || m.startsWith('funnel_airbnb_')),
      [...dualBy.keys()].join(','))

// Named, not pattern-matched. The two channels no longer share a metric name at
// all — which is the fix — so asking for both names by hand is the honest check.
const both = await c.query<{ source: string, metric: string, value: string }>(
  `select source, metric, value::text from snapshot
    where metric in ('funnel_booking_impressions_trailing',
                     'funnel_airbnb_impressions_trailing')
      and entity_id in ($1, $2)`, [bookingEntity, airbnbEntity])
check('each channel stored its own figure under its own name',
      both.rows.length === 2
      && both.rows.map(r => r.source).sort().join(',') === 'mdv_airbnb,mdv_booking',
      JSON.stringify(both.rows))
check('and each keeps its own number',
      Number(both.rows.find(r => r.source === 'mdv_booking')!.value) === 99_014
      && Number(both.rows.find(r => r.source === 'mdv_airbnb')!.value) === 1_000,
      JSON.stringify(both.rows))

const demand = report.endpoints.find(e => e.path === '/booking/demand/')!
check('a long-form report is recognised as one and stores nothing',
      demand.snapshotRows === 0 && /long-form report/.test(demand.note), demand.note)
check('and its label vocabulary comes back, so the mapping can be written against it',
      demand.vocabulary.join(',') === 'Demand / Reservations,Demand / Searches',
      demand.vocabulary.join(','))

const shapes = await c.query<{ n: number }>(
  `select count(*)::int n from api_shape where source = 'mdv' and endpoint like '%ranking%'`)
check('every pass records the shape it saw, whether or not it could map it',
      shapes.rows[0]!.n >= 2, String(shapes.rows[0]!.n))

/* ------------------------------- 4 · the same adapter, a dated payload */

airbnbDated = true
await c.query(`delete from snapshot where source = 'mdv_airbnb'`)
const second = await importFunnel(c, mdv)
const dated = second.endpoints.find(e => e.path === '/airbnb/ranking/')!
check('the axis follows the data: dates appear, and the same pass files per night',
      dated.axis === 'forward' && /filed per stay date/.test(dated.note), dated.note)
const perNight = await c.query<{ n: number, d: string }>(
  `select count(*)::int n, min(stay_date)::text d from snapshot
    where entity_id = $1 and metric = 'funnel_airbnb_impressions'`, [airbnbEntity])
check('two nights arrive, each carrying the date it is about',
      perNight.rows[0]!.n === 2 && perNight.rows[0]!.d === '2026-09-01',
      JSON.stringify(perNight.rows))
check('and nothing is filed under the trailing name any more',
      (await c.query<{ n: number }>(`select count(*)::int n from snapshot
        where source = 'mdv_airbnb' and metric like '%\\_trailing'`)).rows[0]!.n === 0)
// 8.5, 1.0 — max above 1, so percent, so 8.5 becomes 0.085.
const provided = await c.query<{ value: string }>(
  `select value::text from snapshot
    where entity_id = $1 and metric = 'funnel_airbnb_provider_view_rate'
    order by stay_date limit 1`, [airbnbEntity])
check('a provider rate is stored only once its scale is settled, normalised to a fraction',
      provided.rows.length === 1 && Math.abs(Number(provided.rows[0]!.value) - 0.085) < STORED,
      JSON.stringify(provided.rows))

srv.close(); c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
