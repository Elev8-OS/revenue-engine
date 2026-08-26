/**
 * The object import, against a stand-in provider.
 *
 * REWRITTEN around the contract this importer now has. It used to create an
 * entity per channel object, and these tests asserted that — so they would have
 * watched a first live pass add roughly 58 Booking properties and 50 Airbnb
 * listings next to the 57 objects Elev8 had already placed, and called it green.
 *
 * Elev8 is the authority for what exists, and its `ota_channels[]` carries each
 * OTA's own listing id, so the join is the channel manager's own mapping. The
 * judgements worth testing are therefore: does a channel object find the room it
 * belongs to, does it find it even when the two systems disagree about the KIND
 * of thing the id names, and does a miss get reported rather than invented.
 */
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { MdvClient, seedRefreshToken } from './sources/mdv/client.js'
import { importObjects, marketFromCountry, marketFromCoordinates } from './sources/mdv/objects.js'
import { discoverMdv, rowsOf, CANDIDATES } from './sources/mdv/discover.js'
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
  // a1 is aliased below exactly as Elev8 writes it — same source, same kind.
  { listing_id: 'a1', listing_title: 'Vogelberg', nickname: '595153 - Vogelberg', active: true },
  { listing_id: 'a2', listing_title: 'Ubud Loft', nickname: null, active: true },
  // a3 is carried by no Elev8 listing: the miss case.
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

/* --------------------------------- 2 · the portfolio Elev8 already placed */

/**
 * The fixture is the real situation: rooms already exist, and their OTA ids were
 * written by Elev8 as `kind = 'listing'` — including for Booking, which MDV
 * addresses as a `property`. That kind mismatch is the defect these tests exist
 * to close; without the cross-kind lookup every Booking object would miss by
 * construction.
 */
const { rows: seeded } = await c.query<{ id: string, label: string }>(
  `insert into entity (label, market) values
     ('Basel Flat',      'ch'),
     ('Canggu Villa',    'bali'),
     ('Vogelberg',       'ch'),
     ('Untouched Room',  'ch')
   returning id, label`)
const byLabel = new Map(seeded.map(r => [r.label, r.id]))
await c.query(
  `insert into entity_alias (source, kind, external_id, entity_id, matched_by) values
     ('mdv_booking', 'listing', '1',  $1, 'elev8_ota_channels'),
     ('mdv_booking', 'listing', '2',  $2, 'elev8_ota_channels'),
     ('mdv_airbnb',  'listing', 'a1', $3, 'elev8_ota_channels')`,
  [byLabel.get('Basel Flat'), byLabel.get('Canggu Villa'), byLabel.get('Vogelberg')])

/* ------------------------------------------------------------- 3 · first pass */

const first = await importObjects(c, mdv, { pageSize: 2 })
check('every Booking row was seen', first.bookingSeen === 5, String(first.bookingSeen))
check('the two Booking objects Elev8 carries are ATTACHED, not created',
      first.bookingAttached === 2, String(first.bookingAttached))
check('and both needed the cross-kind lookup, because Elev8 calls them listings',
      first.crossKind === 2, String(first.crossKind))
check('every Airbnb row was seen across pages', first.airbnbSeen === 3, String(first.airbnbSeen))
check('the Airbnb id Elev8 carries attaches directly, same source and same kind',
      first.airbnbAttached === 1, String(first.airbnbAttached))

/**
 * The whole point. Five Booking objects and three Airbnb listings arrived; three
 * rooms carried a matching id. Nothing else may become an object, or the same
 * apartment appears twice and the cohort bands dilute.
 */
const total = await c.query<{ n: number }>('select count(*)::int n from entity')
check('NOTHING was created: the object count is exactly what Elev8 placed',
      total.rows[0]!.n === 4, String(total.rows[0]!.n))
check('the misses are reported instead', first.unresolved === 5, String(first.unresolved))

const unres = await c.query<{ external_id: string, reason: string }>(
  `select external_id, reason from unresolved_alias order by external_id`)
check('and each one says why, naming Elev8 as the authority',
      unres.rows.length === 5 && unres.rows.every(r => /Elev8 is the authority/.test(r.reason)),
      unres.rows.map(r => r.external_id).join(','))
check('the room nothing pointed at was left alone',
      (await c.query<{ n: number }>(
        `select count(*)::int n from entity_alias where entity_id = $1`,
        [byLabel.get('Untouched Room')])).rows[0]!.n === 0)

/* ---------------------------------------------------- 4 · aliases and freshness */

const aliases = await c.query<{ matched_by: string, kind: string, n: number }>(
  `select matched_by, kind::text, count(*)::int n from entity_alias
    group by matched_by, kind order by matched_by, kind`)
check('the cross-kind hit records the tuple MDV actually uses, so the next run is direct',
      aliases.rows.some(r => r.matched_by === 'ota_id_crosskind' && r.kind === 'property'
                             && r.n === 2), JSON.stringify(aliases.rows))
// Two of the three Elev8 aliases were matched CROSS-kind, so a new tuple was
// written beside them and they are untouched. The third was the exact tuple MDV
// uses, so nothing new could be written — the confirmation is appended instead,
// which keeps the provenance (the channel manager's own mapping) and still makes
// the next run a no-op.
check('a cross-kind match leaves the Elev8 alias alone',
      aliases.rows.some(r => r.matched_by === 'elev8_ota_channels' && r.n === 2),
      JSON.stringify(aliases.rows))
check('an exact match records the confirmation without losing where the link came from',
      aliases.rows.some(r => r.matched_by === 'elev8_ota_channels+mdv_confirmed' && r.n === 1),
      JSON.stringify(aliases.rows))

const fresh = await c.query<{ dataset: string, status: string }>(
  `select dataset, status from dataset_freshness order by dataset`)
check('one freshness row per reported dataset', fresh.rows.length === first.freshnessRows)
check('a dataset with no timestamp is recorded as unknown, not as fresh',
      fresh.rows.some(r => r.dataset === 'ranking' && r.status === 'unknown'),
      JSON.stringify(fresh.rows))

const bands = await c.query<{ n: number }>(
  `select count(*)::int n from entity where band is null`)
check('no bedroom band is invented by this importer', bands.rows[0]!.n === 4)

/* --------------------------------------------------------- 5 · the second pass */

const callsAfterFirst = detailCalls
const second = await importObjects(c, mdv, { pageSize: 2 })
check('a second run attaches nothing new',
      second.bookingAttached === 0 && second.airbnbAttached === 0,
      `${second.bookingAttached}/${second.airbnbAttached}`)
// Freshness is re-read every run, and that is the point of the detail call now.
// The first live pass reported `freshnessRows: 0` over 78 matched objects,
// because the stamp was only written when an object first attached — which makes
// the staleness gate read a number from whenever the room appeared.
check('and it re-reads the provider\u2019s freshness for everything it matched',
      second.freshnessRows === first.freshnessRows && second.freshnessRows > 0,
      `${second.freshnessRows} vs ${first.freshnessRows}`)
check('and needs no cross-kind detour, because the first run recorded the tuple',
      second.crossKind === 0, String(second.crossKind))
check('it recognises the three it already linked', second.alreadyKnown === 3,
      String(second.alreadyKnown))
// The misses are re-probed every run on purpose: an Elev8 pass may add the
// channel mapping later, and then the object attaches with no human involved.
check('the still-unmatched rows are re-probed', second.unresolved === 5,
      String(second.unresolved))
// Three matched objects, three detail calls — one per stamp. The misses cost
// nothing, because there is no room to hang a freshness row on.
check('one detail call per matched object, and none for the misses',
      detailCalls - callsAfterFirst === 3, `${detailCalls - callsAfterFirst} detail calls`)
const stillFour = await c.query<{ n: number }>('select count(*)::int n from entity')
check('so the object count is still unchanged', stillFour.rows[0]!.n === 4,
      String(stillFour.rows[0]!.n))


/* ----------------------------------------- 6 · discovery: look before mapping */

/**
 * The funnel signals are the last missing piece and their paths are not recorded
 * anywhere. Twice this project has paid for mapping against remembered field
 * names — the Elev8 room filter that never fired, the PriceLabs panel that read
 * nothing over 43 listings — and both cost a deploy and a live run to discover.
 * So this pass asks and writes down only the shape.
 */
await c.query(`delete from api_shape where source = 'mdv'`)
const found = await discoverMdv(c, mdv)
check('every candidate is probed', found.probed === CANDIDATES.length, String(found.probed))
check('the controls answered, so a miss elsewhere is about the path and not the grant',
      found.controlsOk, JSON.stringify(found.probes.filter(p => p.status !== 'ok')))
// The first version scraped the status out of the error MESSAGE with a
// word-boundary regex, and `http_404` has no boundary before the digits because
// an underscore is a word character — so every 404 was filed as a stage error.
// The status now comes off the typed field.
check('a path that does not exist is recorded as missing, not as an error',
      found.missing.length > 0 && found.stageErrors.length === 0,
      JSON.stringify({ missing: found.missing, errors: found.stageErrors }))
check('and every missing path carries its 404, so the report is auditable',
      found.probes.filter(p => found.missing.includes(p.path)).every(p => p.status === 404),
      JSON.stringify(found.probes.filter(p => p.status !== 'ok')))
check('and the envelope each answer arrived in is named',
      found.probes.some(p => p.envelope === 'properties')
      && found.probes.some(p => p.envelope === 'results'),
      JSON.stringify(found.probes.filter(p => p.status === 'ok').map(p => p.envelope)))

const shapes = await c.query<{ endpoint: string, sample_count: number }>(
  `select endpoint, sample_count from api_shape where source = 'mdv' order by endpoint`)
check('a shape is recorded per answering endpoint', shapes.rows.length === found.answered,
      JSON.stringify(shapes.rows.map(r => r.endpoint)))

// The one rule that makes this safe to run at any time.
const untouched = await c.query<{ n: number }>('select count(*)::int n from entity')
check('discovery writes NO objects: a pass that changed the portfolio would be a '
      + 'migration in disguise', untouched.rows[0]!.n === 4, String(untouched.rows[0]!.n))
const noSnaps = await c.query<{ n: number }>(
  `select count(*)::int n from snapshot where source in ('mdv_booking','mdv_airbnb')`)
check('and no measurements either', noSnaps.rows[0]!.n === 0)

check('a bare array is recognised', rowsOf([1, 2]).envelope === 'bare array')
check('a paginated envelope is recognised by its key', rowsOf({ results: [] }).envelope === 'results')
check('an unknown envelope names its keys instead of guessing',
      rowsOf({ total: 1, widgets: 2 }).envelope.includes('total'),
      rowsOf({ total: 1, widgets: 2 }).envelope)

srv.close(); c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
