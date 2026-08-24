/**
 * The object import, against a stand-in provider.
 *
 * The tests that matter here are not "did rows appear" but the three judgements
 * the importer makes: which market a row belongs to, what happens when that
 * cannot be decided, and whether a second run is cheap and non-duplicating.
 */
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { MdvClient, seedRefreshToken } from './sources/mdv/client.js'
import { importObjects, marketFromCountry, marketFromCoordinates } from './sources/mdv/objects.js'
import { RateBudget } from './scheduler/budget.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

const port = 4593
const base = `http://127.0.0.1:${port}/api/v1`
let detailCalls = 0

const BOOKING = [
  { property_id: 1, name: 'Basel Flat', city: 'Basel', status: 'active' },
  { property_id: 2, name: 'Canggu Villa', city: 'Canggu', status: 'active' },
  { property_id: 3, name: 'Tauplitz Chalet', city: 'Tauplitz', status: 'active' },
  { property_id: 4, name: 'Delisted Flat', city: 'Olten', status: 'removed' },
  { property_id: 5, name: 'Nowhere', city: null, status: 'active' },
]
const BOOKING_DETAIL: Record<string, Record<string, unknown>> = {
  '1': { property_id: 1, latitude: 47.55, longitude: 7.58, country_code: 'ch',
         sync_state: { metrics: { pricing: '2026-08-23T07:00:00Z', ranking: null } } },
  '2': { property_id: 2, latitude: -8.65, longitude: 115.13, country_code: 'id',
         sync_state: { metrics: { pricing: '2026-08-23T07:00:00Z' } } },
  '3': { property_id: 3, latitude: 47.57, longitude: 13.96, country_code: 'at', sync_state: {} },
  '4': { property_id: 4, latitude: 47.35, longitude: 7.90, country_code: 'ch', sync_state: {} },
  // No country and no coordinates: undecidable on purpose.
  '5': { property_id: 5, latitude: null, longitude: null, country_code: null, sync_state: {} },
}
const AIRBNB = [
  { listing_id: 'a1', listing_title: 'Vogelberg', nickname: '595153 - Vogelberg', active: true },
  { listing_id: 'a2', listing_title: 'Ubud Loft', nickname: null, active: true },
  { listing_id: 'a3', listing_title: 'Lost Listing', nickname: null, active: false },
]
const AIRBNB_DETAIL: Record<string, Record<string, unknown>> = {
  a1: { listing_id: 'a1', lat: 47.31, lng: 7.69, data_as_of: '2026-08-23T05:00:00Z' },
  a2: { listing_id: 'a2', lat: -8.51, lng: 115.26, data_as_of: '2026-08-23T05:00:00Z' },
  a3: { listing_id: 'a3', lat: null, lng: null, data_as_of: null },
}

const srv = createServer((req, res) => {
  const [path, qs] = (req.url ?? '').split('?')
  const q = new URLSearchParams(qs ?? '')
  const json = (o: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o))
  }
  if (path === '/oauth/token') {
    return json({ access_token: 'at', refresh_token: `r${Math.random()}`, expires_in: 3600 })
  }
  if (path === '/api/v1/booking/properties/') return json({ properties: BOOKING })
  let mm = /^\/api\/v1\/booking\/properties\/(\d+)\/$/.exec(path ?? '')
  if (mm) { detailCalls++; return json(BOOKING_DETAIL[mm[1]!]) }
  if (path === '/api/v1/airbnb/listings/') {
    const limit = Number(q.get('limit') ?? 100), offset = Number(q.get('offset') ?? 0)
    return json({ count: AIRBNB.length, limit, offset,
                  results: AIRBNB.slice(offset, offset + limit) })
  }
  mm = /^\/api\/v1\/airbnb\/listings\/([^/]+)\/$/.exec(path ?? '')
  if (mm) { detailCalls++; return json(AIRBNB_DETAIL[decodeURIComponent(mm[1]!)]) }
  res.writeHead(404); res.end()
})
await new Promise<void>(r => srv.listen(port, r))

const c = await pool.connect()
await c.query('delete from oauth_token'); await c.query('truncate oauth_event')
await c.query('truncate unresolved_alias')
await c.query('delete from dataset_freshness')
await c.query(`delete from entity`)
await seedRefreshToken(c, { clientId: 'cid', refreshToken: 'seed' })
const mdv = new MdvClient({
  clientId: 'cid', clientSecret: 'sec', base,
  tokenUrl: `http://127.0.0.1:${port}/oauth/token`,
  budget: new RateBudget(), sleep: async () => {},
})

/* ------------------------------------------------------------- 1 · the market */

check('a stated country decides the market', marketFromCountry('CH') === 'ch'
  && marketFromCountry('at') === 'at' && marketFromCountry('id') === 'bali')
check('an unknown country is not guessed', marketFromCountry('de') === null
  && marketFromCountry(null) === null)
check('Bali coordinates resolve', marketFromCoordinates(-8.65, 115.13) === 'bali')
check('Swiss coordinates resolve', marketFromCoordinates(47.55, 7.58) === 'ch')
check('Austrian coordinates resolve', marketFromCoordinates(47.57, 13.96) === 'at')
// The one place the boxes genuinely overlap.
check('a point in the CH/AT overlap returns nothing rather than picking one',
      marketFromCoordinates(47.2, 9.9) === null)
check('a point in no market returns nothing', marketFromCoordinates(51.5, 0.1) === null)
check('missing coordinates return nothing', marketFromCoordinates(null, undefined) === null)

/* ------------------------------------------------------------- 2 · first pass */

const first = await importObjects(c, mdv, { pageSize: 2 })
check('every Booking row was seen', first.bookingSeen === 5, String(first.bookingSeen))
check('the four decidable Booking rows became entities', first.bookingCreated === 4,
      String(first.bookingCreated))
check('every Airbnb row was seen across pages', first.airbnbSeen === 3, String(first.airbnbSeen))
check('the two with coordinates became entities', first.airbnbCreated === 2,
      String(first.airbnbCreated))
check('the two undecidable rows are recorded, not dropped', first.unresolved === 2,
      String(first.unresolved))

const markets = await c.query<{ market: string, n: number }>(
  `select market::text, count(*)::int n from entity group by market order by market`)
check('markets come out right',
      JSON.stringify(markets.rows) === JSON.stringify(
        [{ market: 'at', n: 1 }, { market: 'bali', n: 2 }, { market: 'ch', n: 3 }]),
      JSON.stringify(markets.rows))

const delisted = await c.query<{ active: boolean }>(
  `select active from entity where label = 'Delisted Flat'`)
check('a delisted property is imported as inactive rather than dropped',
      delisted.rows[0]?.active === false)

const unres = await c.query<{ source: string, external_id: string, reason: string }>(
  `select source::text, external_id, reason from unresolved_alias order by external_id`)
check('the undecidable rows name why', unres.rows.length === 2
  && unres.rows.every(r => /no market/.test(r.reason)),
  unres.rows.map(r => `${r.external_id}: ${r.reason}`).join(' | '))

/* ---------------------------------------------------- 3 · aliases and freshness */

const aliases = await c.query<{ source: string, matched_by: string, n: number }>(
  `select source::text, matched_by, count(*)::int n from entity_alias
    group by source, matched_by order by source`)
check('aliases record which id matched',
      aliases.rows.some(r => r.source === 'mdv_booking' && r.matched_by === 'mdv_property_id')
      && aliases.rows.some(r => r.source === 'mdv_airbnb' && r.matched_by === 'mdv_listing_id'),
      JSON.stringify(aliases.rows))

const fresh = await c.query<{ dataset: string, status: string }>(
  `select dataset, status from dataset_freshness order by dataset`)
check('one freshness row per reported dataset', fresh.rows.length === first.freshnessRows)
check('a dataset with no timestamp is recorded as unknown, not as fresh',
      fresh.rows.some(r => r.dataset === 'ranking' && r.status === 'unknown'),
      JSON.stringify(fresh.rows))

const bands = await c.query<{ n: number }>(
  `select count(*)::int n from entity where bedroom_band is null`)
check('no bedroom band is invented, so the cohort stays honestly unresolved',
      bands.rows[0]!.n === 6, String(bands.rows[0]!.n))

/* --------------------------------------------------------- 4 · the second pass */

const callsAfterFirst = detailCalls
const second = await importObjects(c, mdv, { pageSize: 2 })
check('a second run creates nothing',
      second.bookingCreated === 0 && second.airbnbCreated === 0)
check('and recognises what it already knew', second.alreadyKnown === 6,
      String(second.alreadyKnown))
// Two, not zero: the rows that could not be placed are re-probed every run,
// because a missing coordinate may be filled in on the provider's side later.
// Everything already placed costs nothing.
check('only the still-undecidable rows are re-probed',
      detailCalls - callsAfterFirst === 2, `${detailCalls - callsAfterFirst} detail calls`)
const total = await c.query<{ n: number }>('select count(*)::int n from entity')
check('so the object count is unchanged', total.rows[0]!.n === 6, String(total.rows[0]!.n))

srv.close(); c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
