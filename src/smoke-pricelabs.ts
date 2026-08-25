/**
 * PriceLabs, against a stand-in provider.
 *
 * What is protected here is not "does a GET work". It is the specific ways this
 * adapter could produce a confident, tidy, wrong answer — and every one of them
 * is drawn from something measured on the live account rather than imagined:
 *
 *   1. A SENTINEL WRITTEN AS A NUMBER. `user_price: -1`, `ADR: -1`,
 *      `revpar['1']: -1`, `weekend_total_occupancy['1']: -4` all appear in real
 *      responses and all mean "no value". Written through, they become a
 *      dashboard reporting minus one franc.
 *   2. THE BUILDING MATCHED INSTEAD OF THE UNIT. The composite id's left half
 *      names a property that can hold several lettings. Matching on it produces
 *      a complete-looking mapping that prices two apartments as one.
 *   3. AN UNDOCUMENTED HORIZON CODE READ AS DAYS. '998' sits beside '30' in the
 *      same object with a plausible value. Read as days it is a confident claim
 *      about 2029.
 *   4. ZERO BEDROOMS READ AS A STUDIO. The value is ambiguous in this payload
 *      and one reading puts a flat in a cohort it does not belong to.
 *   5. A REFUSAL READ AS AN OUTAGE. `/v1/reservation_data` is documented to
 *      return 403 to a valid key; "your key may not read this" and "the
 *      integration is broken" need opposite responses.
 *   6. A CANCELLED BOOKING SUMMED AS REVENUE.
 */
import { createServer, type IncomingMessage } from 'node:http'
import { Pool } from 'pg'
import { PriceLabsClient, plain, PriceLabsBlockedError, PriceLabsError }
  from './sources/pricelabs/client.js'
import { coordsOf, bedroomsOf, importPriceLabsListings } from './sources/pricelabs/listings.js'
import { rowsFor, dayPlus, importPriceLabsPrices } from './sources/pricelabs/prices.js'
import { isDayOffset, gridRows, importPriceLabsMetrics } from './sources/pricelabs/metrics.js'
import { channelOf, nightsOf, importPriceLabsReservations }
  from './sources/pricelabs/reservations.js'
import { bedroomsFromBand, monthStart, cohortsToSample, importPriceLabsMarket }
  from './sources/pricelabs/estimator.js'
import { importPriceLabs } from './sources/pricelabs/import.js'
import { link, resolve } from './entity/resolve.js'
import { signals } from './dashboard/query.js'
import { isPriceLabsReport, isElev8Report, reportCounts } from './import/run.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

const port = 4597
const base = `http://127.0.0.1:${port}`
const ASOF = '2026-08-24'

// ---- provider state, switchable per test
let listingsBody: unknown = { listings: [] }
let pricesBody: unknown = []
let metricsBody: unknown = { data: {} }
let reservationsPages: unknown[] = []
let estimatorBody: unknown = { KPIsByBedroomCategory: {} }
let statusFor: Record<string, number> = {}
let seenKeys: string[] = []
let priceRequests: Array<Record<string, unknown>> = []
let reservationQueries: Array<Record<string, string>> = []
let estimatorQueries: Array<Record<string, string>> = []
let retryAfterOnce = false

const readBody = async (req: IncomingMessage) => {
  const c: Buffer[] = []
  for await (const x of req) c.push(x as Buffer)
  return c.length ? JSON.parse(Buffer.concat(c).toString()) as Record<string, unknown> : {}
}

const srv = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', base)
  const p = url.pathname
  const json = (o: unknown, status = 200, h: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...h }); res.end(JSON.stringify(o))
  }
  seenKeys.push(String(req.headers['x-api-key'] ?? ''))
  const forced = statusFor[p]
  if (forced) { delete statusFor[p]; return json({ error: 'refused' }, forced) }

  if (p === '/v1/listings') return json(listingsBody)
  if (p === '/v1/listing_prices') {
    const body = await readBody(req)
    priceRequests.push(body)
    return json(pricesBody)
  }
  if (p === '/v1/listing_metrics') return json(metricsBody)
  if (p === '/v1/reservation_data') {
    reservationQueries.push(Object.fromEntries(url.searchParams))
    if (retryAfterOnce) {
      retryAfterOnce = false
      return json({ error: 'slow down' }, 429, { 'retry-after': '0' })
    }
    const offset = Number(url.searchParams.get('offset') ?? 0)
    const page = reservationsPages[offset / 200] ?? { data: [], next_page: false }
    return json(page)
  }
  if (p === '/v2/revenue/estimator') {
    estimatorQueries.push(Object.fromEntries(url.searchParams))
    return json(estimatorBody)
  }
  return json({ error: 'not found' }, 404)
})

const client = () => new PriceLabsClient({
  apiKey: 'customer-key', base, sleep: async () => {},
})

async function main() {
  await new Promise<void>(r => srv.listen(port, '127.0.0.1', r))
  const c = await pool.connect()
  await c.query(`truncate entity, entity_alias, unresolved_alias, snapshot, snapshot_market,
                 booking_economics, api_shape, raw_payload, dataset_freshness cascade`)

  /* ------------------------------------------- 1 · sentinels are not numbers */

  check('plain reads a number', plain(42) === 42)
  check('plain reads a numeric string', plain('12.5') === 12.5)
  check('plain refuses -1, the provider\'s word for "no value"', plain(-1) === null)
  check('plain refuses -4, its other one', plain(-4) === null)
  check('plain keeps zero, which is a real answer', plain(0) === 0)
  check('plain refuses an empty string', plain('') === null)
  check('plain refuses a non-number', plain('Fully Blocked') === null)
  check('plain admits a negative only when asked', plain(-1, { allowNegative: true }) === -1)

  /* ------------------------------------------------- 2 · coordinates */

  check('a string coordinate pair is read', coordsOf({ latitude: '-8.65', longitude: '115.13' })
    ?.lat === -8.65)
  check('null island is refused, because it is what two empty strings parse to',
        coordsOf({ latitude: '0', longitude: '0' }) === null)
  check('a coordinate off the earth is refused',
        coordsOf({ latitude: '91', longitude: '10' }) === null)
  check('a half pair is refused', coordsOf({ latitude: '47.1' }) === null)

  /* ------------------------------------------------- 3 · bedrooms and bands */

  check('two bedrooms is two', bedroomsOf({ no_of_bedrooms: 2 }) === 2)
  check('zero bedrooms is NOT read as a studio', bedroomsOf({ no_of_bedrooms: 0 }) === null)
  check('an absent count is nothing', bedroomsOf({}) === null)
  check('a bedroom band yields a number to ask the estimator with',
        bedroomsFromBand('2BR') === 2)
  check('the open-ended band asks at its floor', bedroomsFromBand('5BR+') === 5)
  check('an occupancy band yields NO bedroom number', bedroomsFromBand('sleeps 3-4') === null)

  /* ------------------------------------------------- 4 · the room-half join */

  const { rows: made } = await c.query<{ id: string }>(
    `insert into entity (label, market, band, band_basis, pms_property_id)
     values ('Merapi Room 1-4', 'bali', '2BR', 'bedrooms', 'building-1'),
            ('Merapi Room 5',   'bali', '1BR', 'bedrooms', 'building-1'),
            ('Solo Flat',       'ch',   null,  null,       'building-2')
     returning id`)
  const [room14, room5, solo] = made.map(r => r.id) as [string, string, string]
  for (const [entityId, roomId] of [[room14, 'room-a'], [room5, 'room-b'], [solo, 'room-c']]) {
    await link(c, { source: 'channex', kind: 'room', externalId: roomId! }, entityId!, 'test')
  }

  const good = await resolve(c, { source: 'pricelabs', kind: 'listing',
                                 externalId: 'building-1___room-b' })
  check('a composite id resolves through its ROOM half',
        good.ok && good.entityId === room5, JSON.stringify(good))

  const bad = await resolve(c, { source: 'pricelabs', kind: 'listing',
                                 externalId: 'building-1___room-unknown',
                                 label: 'Merapi Room 6' })
  check('an unknown room half does NOT fall back to the building', !bad.ok)
  const why = await c.query<{ reason: string }>(
    `select reason from unresolved_alias where external_id = 'building-1___room-unknown'`)
  check('and the refusal says why matching the building would be wrong',
        Boolean(why.rows[0]?.reason.includes('price them as one')), why.rows[0]?.reason ?? '')
  check('and it names how many units share that building',
        Boolean(why.rows[0]?.reason.includes('2 unit')), why.rows[0]?.reason ?? '')

  /* ------------------------------------------------- 5 · the listings stage */

  listingsBody = { listings: [
    { id: 'building-1___room-a', pms: 'channex', name: 'Merapi Room 1-4',
      latitude: '-8.6500', longitude: '115.1300', currency: 'chf',
      no_of_bedrooms: 3, cleaning_fees: 25, min: 30, max: 90, base: 45,
      channel_listing_details: [{ channel_name: 'Airbnb', channel_listing_id: 'abnb-1' }] },
    { id: 'building-2___room-c', pms: 'channex', name: 'Solo Flat',
      latitude: '0', longitude: '0', currency: 'CHF', no_of_bedrooms: 2, isHidden: true },
    { id: 'building-9___room-zz', pms: 'channex', name: 'Somebody Else\'s Flat' },
    { id: 'plain-id-no-separator', pms: 'guesty', name: 'Other PMS' },
  ] }
  const stage1 = await importPriceLabsListings(c, client())
  check('every listing row is seen', stage1.report.seen === 4)
  check('two resolve, two do not', stage1.report.resolved === 2 && stage1.report.unresolved === 2,
        JSON.stringify(stage1.report))
  check('a foreign PMS is named rather than assumed to share the id form',
        stage1.report.foreignPms.join(',') === 'guesty', JSON.stringify(stage1.report.foreignPms))
  check('a real coordinate is written', stage1.report.coordsWritten === 1)
  check('null island is counted as rejected, not stored',
        stage1.report.coordsRejected === 1)
  const geo = await c.query<{ latitude: string | null }>(
    `select latitude from entity where id = $1`, [solo])
  check('and the entity keeps no coordinate for it', geo.rows[0]?.latitude === null)
  check('a band that disagrees with the one we hold is reported, not overwritten',
        stage1.report.bandDisagreements.length === 1
        && stage1.report.bandDisagreements[0]?.elev8 === '2BR'
        && stage1.report.bandDisagreements[0]?.pricelabs === '3BR',
        JSON.stringify(stage1.report.bandDisagreements))
  const kept = await c.query<{ band: string }>(`select band from entity where id = $1`, [room14])
  check('and the held band survives the disagreement', kept.rows[0]?.band === '2BR')
  const filled = await c.query<{ band: string, basis: string }>(
    `select band, band_basis as basis from entity where id = $1`, [solo])
  check('a band is written where we had none', filled.rows[0]?.band === '2BR'
    && filled.rows[0]?.basis === 'bedrooms', JSON.stringify(filled.rows[0]))
  check('the currency is normalised and reported',
        stage1.report.currencies.join(',') === 'CHF', JSON.stringify(stage1.report.currencies))
  check('a hidden listing is counted', stage1.report.hidden === 1)
  check('a channel listing id present in the payload is counted',
        stage1.report.channelDetailsWithId === 1)
  check('the guest cleaning fee is counted, and NOT written as a cost',
        stage1.report.cleaningFeesSeen === 1)
  const noCost = await c.query(`select 1 from cost_basis`)
  check('nothing entered the cost table from a guest-facing fee', noCost.rowCount === 0)
  const shape1 = await c.query<{ n: number }>(
    `select count(*)::int n from api_shape where source = 'pricelabs'
      and endpoint = 'GET /v1/listings'`)
  check('the response shape is recorded', shape1.rows[0]?.n === 1)

  /* ------------------------------------------------- 6 · the price calendar */

  check('the horizon is computed in calendar days', dayPlus('2026-08-24', 90) === '2026-11-22')
  const nightRows = rowsFor('e', {
    date: '2026-08-25', price: 40, uncustomized_price: 38, user_price: -1,
    min_stay: 2, ADR: -1, unbookable: 0,
  }, 'CHF')
  const names = nightRows.map(r => r.metric).sort()
  check('a recommended price is written', names.includes('price_recommended'))
  check('a -1 live price is WITHHELD, not written as minus one franc',
        !names.includes('price_current'), names.join(','))
  check('a -1 ADR is withheld too', !names.includes('adr_booked'))
  check('min_stay carries no currency, because it is a night count',
        nightRows.find(r => r.metric === 'min_stay')?.currency === undefined)
  check('a price carries the currency',
        nightRows.find(r => r.metric === 'price_recommended')?.currency === 'CHF')
  check('unbookable survives at zero, because zero is an answer',
        names.includes('unbookable'))
  check('a row with no date produces nothing', rowsFor('e', { price: 40 }, 'CHF').length === 0)

  priceRequests = []
  pricesBody = [
    { id: 'building-1___room-a', pms: 'channex', currency: 'CHF',
      last_refreshed_at: '2026-08-24T08:32:18+00:00',
      data: [
        { date: '2026-08-25', price: 40, user_price: -1, uncustomized_price: 40,
          min_stay: 1, ADR: -1, unbookable: 0, booking_status: '', demand_desc: 'Unavailable',
          occupancy: 1 },
        { date: '2026-08-26', price: 43, user_price: 41, uncustomized_price: 43,
          min_stay: 2, ADR: 39, unbookable: 0, booking_status: 'booked', demand_desc: 'Low' },
      ] },
    { id: 'building-2___room-c', pms: 'channex', error_status: 'listing_not_synced',
      error: 'not synced' },
  ]
  const prices = await importPriceLabsPrices(c, client(), stage1.resolved, ASOF)
  check('both resolved listings were asked for', prices.requested === 2)
  check('a listing-level error inside a 200 is NOT counted as answered',
        prices.answered === 1 && prices.listingErrors.length === 1,
        JSON.stringify(prices.listingErrors))
  check('the batch asks by id and pms', priceRequests.length === 1
    && Array.isArray((priceRequests[0] as { listings?: unknown[] }).listings)
    && (priceRequests[0] as { listings: unknown[] }).listings.length === 2)
  check('nights are counted', prices.nights === 2)
  check('the nights with no live price are counted', prices.noLivePrice === 1)
  check('the booking_status vocabulary is reported rather than assumed',
        prices.bookingStatuses.join('|') === '|booked', prices.bookingStatuses.join('|'))
  check('the demand labels are reported too',
        prices.demandLabels.join(',') === 'Low,Unavailable')
  check('the undocumented occupancy field is counted, never mapped',
        prices.occupancyFieldSeen === 1)
  const written = await c.query<{ metric: string, value: string, observed: Date | null }>(
    `select metric, value, observed_at as observed from snapshot
      where entity_id = $1 and stay_date = '2026-08-25' order by metric`, [room14])
  check('nothing negative reached the archive',
        written.rows.every(r => Number(r.value) >= 0), JSON.stringify(written.rows))
  check('the provider\'s own freshness is stored beside the value',
        written.rows[0]?.observed !== null)
  const fresh = await c.query<{ status: string }>(
    `select status from dataset_freshness where dataset = 'prices' and entity_id = $1`, [solo])
  check('the failed listing is recorded as stale, not silently skipped',
        fresh.rows[0]?.status === 'error')

  /* ------------------------------------------------- 7 · horizons and sentinel keys */

  check('a day offset is a day offset', isDayOffset('30') && isDayOffset('-90'))
  check('998 is NOT a horizon', !isDayOffset('998'))
  check('-999 is not either', !isDayOffset('-999'))
  check('zero is not a horizon', !isDayOffset('0'))
  check('a non-number is not a horizon', !isDayOffset('true'))

  const seen = { sentinelKeys: new Set<string>(), missing: new Set<string>(), sentinelValues: 0 }
  const grid = gridRows('e', {
    occupancy: { '7': 100, '30': 63.3, '60': 31.7, '90': 21.1, '-7': 0, '-30': 0, '-90': 0,
                 '998': 36.7, '-999': 0.4 },
    adr: { '7': -1, '30': 0, '60': 0, '90': 0, '-7': 0, '-30': 0, '-90': 0 },
  }, ASOF, 'CHF', [
    { key: 'occupancy', name: 'occupancy', money: false },
    { key: 'adr', name: 'adr', money: true },
  ], seen)
  const gnames = grid.map(r => r.metric)
  check('a forward horizon becomes a named metric', gnames.includes('occupancy_next_30d'))
  check('a trailing horizon says so in its name', gnames.includes('occupancy_last_90d'))
  check('no metric is named after an undocumented code',
        !gnames.some(n => n.includes('998') || n.includes('999')), gnames.join(','))
  check('and those codes are reported by name so somebody can ask',
        [...seen.sentinelKeys].sort().join(',') === '-999,998',
        [...seen.sentinelKeys].join(','))
  check('a -1 inside the grid is withheld and counted',
        !gnames.includes('adr_next_7d') && seen.sentinelValues === 1)
  check('a money metric carries the currency',
        grid.find(r => r.metric === 'adr_next_30d')?.currency === 'CHF')
  check('an occupancy does not',
        grid.find(r => r.metric === 'occupancy_next_30d')?.currency === undefined)
  check('every window row is dated to the run, because it describes a window',
        grid.every(r => r.stayDate === ASOF))

  /* ------------------------------------------------- 8 · listing against market */

  metricsBody = { data: {
    listing_level: {
      occupancy: { '7': 100, '30': 63.3, '60': 31.7, '90': 21.1, '-7': 0, '-30': 0, '-90': 0 },
      adr: { '7': -1, '30': 120, '60': 118, '90': 110, '-7': 0, '-30': 0, '-90': 0 },
      mpi: { '7': 2.24, '30': 2.08, '60': 1.43, '90': 1.24, '-7': 0, '-30': 0, '-90': 0 },
      bp_ratio: 1.04, currency: 'CHF',
    },
    market_level: {
      occupancy: { '7': 44.6, '30': 30.4, '60': 22.2, '90': 17, '-7': 54.3, '-30': 52.9,
                   '-90': 52 },
      adr: { '7': 80, '30': 78, '60': 76, '90': 74, '-7': 70, '-30': 71, '-90': 72 },
    },
  } }
  const metrics = await importPriceLabsMetrics(c, client(), stage1.resolved, ASOF)
  check('every resolved listing is asked', metrics.attempted === 2 && metrics.ok === 2,
        JSON.stringify(metrics))
  check('the market side is recorded as present', metrics.withMarket === 2)
  const pair = await c.query<{ ours: string | null, theirs: string | null }>(
    `select (select value::text from snapshot where entity_id = $1
              and metric = 'occupancy_next_30d' and as_of_date = $2::date) as ours,
            (select value::text from snapshot where entity_id = $1
              and metric = 'market_occupancy_next_30d' and as_of_date = $2::date) as theirs`,
    [room14, ASOF])
  check('a comparison is now answerable from stored evidence',
        Number(pair.rows[0]?.ours) === 63.3 && Number(pair.rows[0]?.theirs) === 30.4,
        JSON.stringify(pair.rows[0]))
  const scalar = await c.query<{ value: string }>(
    `select value::text from snapshot where entity_id = $1 and metric = 'bp_ratio'`, [room14])
  check('a scalar lands without a horizon', Number(scalar.rows[0]?.value) === 1.04)

  statusFor['/v1/listing_metrics'] = 403
  const refused = await importPriceLabsMetrics(c, client(), stage1.resolved, ASOF)
  check('a 403 stops the stage instead of asking 61 more times',
        refused.attempted === 1 && Boolean(refused.blocked?.startsWith('insufficient_role')),
        JSON.stringify(refused.blocked))

  /* ------------------------- 8b · the measurements reach the dashboard */

  // The complaint this answers: two imports ran, 22'047 rows landed, and the
  // dashboard looked exactly as it had before. It was not wrong — every column
  // that carries meaning reads from `finding`, and no check exists — but a page
  // that cannot tell a successful import from no import at all is a page that
  // cannot report either.
  const sig = await signals(c)
  const mine = sig.get(room14)
  check('a room with an import shows its own occupancy', mine?.occupancy === 63.3,
        JSON.stringify(mine))
  check('and the market beside it, from the same call',
        mine?.marketOccupancy === 30.4)
  check('and the price index that explains the gap', mine?.mpi === 2.08)
  check('the archived calendar is a median, not an average',
        mine?.priceRecommended === 41.5, String(mine?.priceRecommended))
  check('the night count is shown, because a median over two nights is not one over ninety',
        mine?.nights === 2)
  check('the currency comes from the provider', mine?.currency === 'CHF')
  check('the day WE looked is what dates the row', mine?.asOf === ASOF)
  // Solo Flat answered LISTING_TOGGLE_OFF for PRICES and answered normally for
  // metrics, which is the interesting case: partial data must render partially.
  // The occupancy pair is shown because it was measured; the calendar reads as
  // absent rather than as a median of nothing, and the night count says zero so
  // nobody mistakes the empty half for a cheap listing.
  const theirs = sig.get(solo)
  check('a half-answered listing keeps the half that was answered',
        theirs?.occupancy === 63.3 && theirs?.marketOccupancy === 30.4,
        JSON.stringify(theirs))
  check('and its missing calendar is absent, not nought',
        theirs?.priceRecommended === null && theirs?.priceLive === null
        && theirs?.nights === 0, JSON.stringify(theirs))
  check('an entity PriceLabs never mentioned has no row of numbers at all',
        (() => { const g = sig.get(room5); return g?.occupancy === null && g?.nights === 0 })(),
        JSON.stringify(sig.get(room5)))

  /* ------------------------------------------------- 9 · realised bookings */

  check('a channel is mapped by substring', channelOf('Booking.com').channel === 'booking')
  check('and by another spelling', channelOf('BookingCom').channel === 'booking')
  // Measured on the live account, and it had already gone wrong once: this is
  // what PriceLabs sends for Booking.com here, and substring matching on
  // 'booking' filed the portfolio's largest OTA as 'other'.
  check('bcom is Booking.com, which the first live pass proved', channelOf('bcom').channel === 'booking')
  check('and it counts as recognised, so it leaves the unmapped list',
        channelOf('bcom').known === true)
  check('agoda stays other, because the enum has no room for it',
        channelOf('agoda').channel === 'other' && channelOf('agoda').known === false)
  check('airbnb too', channelOf('Airbnb').channel === 'airbnb')
  check('an unknown channel becomes other AND says it was not recognised',
        channelOf('Agoda').channel === 'other' && channelOf('Agoda').known === false)
  check('nights come from the stated count', nightsOf({ no_of_days: 3 }) === 3)
  check('and from the dates where there is none',
        nightsOf({ check_in: '2026-08-25', check_out: '2026-08-28' }) === 3)
  check('a zero-night stay is not a stay',
        nightsOf({ check_in: '2026-08-25', check_out: '2026-08-25' }) === null)

  reservationsPages = [{ next_page: false, pms_name: 'channex', data: [
    { listing_id: 'building-1___room-a', reservation_id: 'r-1', check_in: '2026-08-25',
      check_out: '2026-08-28', no_of_days: 3, rental_revenue: 360, ota_commission: 54,
      currency: 'CHF', booking_channel: 'Booking.com', booked_date: '2026-07-01',
      booking_status: 'confirmed', total_cost: 400 },
    { listing_id: 'building-1___room-a', reservation_id: 'r-2', check_in: '2026-09-01',
      check_out: '2026-09-03', no_of_days: 2, rental_revenue: 200, currency: 'CHF',
      booking_channel: 'Agoda', booked_date: '-1', booking_status: 'cancelled',
      cancelled_on: '2026-08-01' },
    { listing_id: 'nobody___knows', reservation_id: 'r-3', rental_revenue: 100,
      currency: 'CHF', no_of_days: 1, check_in: '2026-08-25', check_out: '2026-08-26' },
    { listing_id: 'building-1___room-a', reservation_id: 'r-4', check_in: '2026-08-25',
      check_out: '2026-08-26', no_of_days: 1, currency: 'CHF' },
  ] }]
  retryAfterOnce = true
  const bookings = await importPriceLabsReservations(c, client(), 'channex', ASOF)
  check('a 429 with Retry-After is honoured rather than failing the stage',
        bookings.pages === 1 && bookings.seen === 4, JSON.stringify(bookings))
  check('two bookings are written', bookings.written === 2)
  check('a reservation for a listing we do not hold is named, not written',
        bookings.unknownListing === 1)
  check('a booking with no revenue figure is kept out rather than written as zero',
        bookings.noRevenue === 1)
  check('the cancellation is counted', bookings.cancelled === 1)
  check('an unmapped channel is reported by name',
        bookings.unmappedChannels.join(',') === 'Agoda')
  check('total_cost is counted and deliberately not mapped', bookings.totalCostSeen === 1)
  const econ = await c.query<{ id: string, status: string | null, cancelled: Date | null,
                              gross: string, comm: string | null, booked: Date | null }>(
    `select reservation_id id, status, cancelled_on cancelled, gross_amount::text gross,
            ota_commission::text comm, booked_at booked
       from booking_economics order by reservation_id`)
  check('the confirmed booking carries its commission',
        econ.rows[0]?.id === 'r-1' && Number(econ.rows[0]?.comm) === 54)
  check('the cancelled booking is KEPT and labelled, so the rate stays measurable',
        econ.rows[1]?.status === 'cancelled' && econ.rows[1]?.cancelled !== null,
        JSON.stringify(econ.rows[1]))
  check('a booked_date of "-1" does not become a date',
        econ.rows[1]?.booked === null)
  check('summing only the uncancelled gives the honest number',
        (await c.query<{ sum: string | null }>(
          `select sum(gross_amount)::text sum from booking_economics where cancelled_on is null`
        )).rows[0]?.sum === '360.00')

  statusFor['/v1/reservation_data'] = 403
  const closed = await importPriceLabsReservations(c, client(), 'channex', ASOF)
  check('a 403 here is a NAMED state, not a failure',
        Boolean(closed.blocked?.startsWith('insufficient_role')) && closed.firstError === null,
        JSON.stringify(closed))
  const named = await c.query<{ status: string }>(
    `select status from dataset_freshness where dataset = 'reservations'`)
  check('and the freshness row says which state it was',
        named.rows[0]?.status === 'insufficient_role', JSON.stringify(named.rows))

  /* ------------------------------------------------- 10 · the cohort benchmark */

  check('a month key becomes the first of that month', monthStart('2026-09') === '2026-09-01')
  check('a full date narrows to its month', monthStart('2026-09-15') === '2026-09-01')
  check('a month name is refused rather than guessed into a year',
        monthStart('Sep 2026') === null)
  check('month 13 is not a month', monthStart('2026-13') === null)

  const cohorts = await cohortsToSample(c)
  check('only cohorts with a coordinate are sampled',
        cohorts.cohorts.length === 1 && cohorts.cohorts[0]?.band === '2BR',
        JSON.stringify(cohorts.cohorts))
  check('and the ones without one are counted', cohorts.noCoordinate >= 1)

  estimatorBody = { KPIsByBedroomCategory: { '2': {
    Revenue50PercentileSum: 24_000, ADR50PercentileAvg: 95, AvgAdjustedOccupancy: 52.8,
    NoOfListings: 214,
    MonthlyBreakup: {
      Revenue50Percentile: { '2026-09': 2000, 'Oct 2026': 2100 },
      AvgOccupancy: { '2026-09': 51.2 },
      NoListingUsed: { '2026-09': 210 },
    },
  } } }
  estimatorQueries = []
  const market = await importPriceLabsMarket(
    c, new PriceLabsClient({ apiKey: 'estimator-key', base, sleep: async () => {} }), 'CHF', ASOF)
  check('the cohort is fetched', market.fetched === 1, JSON.stringify(market))
  check('it is asked by coordinate and bedroom count',
        estimatorQueries[0]?.bedroom_category === '2' && estimatorQueries[0]?.lat === '-8.65',
        JSON.stringify(estimatorQueries[0]))
  check('the estimator is asked with its OWN key',
        seenKeys[seenKeys.length - 1] === 'estimator-key')
  check('an unreadable month key is reported rather than dropped in silence',
        market.unreadableMonthKeys.join(',') === 'Oct 2026',
        JSON.stringify(market.unreadableMonthKeys))
  const panel = await c.query<{ metric: string, stay: string, value: string,
                                sampled: string | null }>(
    `select metric, stay_date::text stay, value::text value, sampled_entity_id::text sampled
       from snapshot_market order by metric, stay_date`)
  check('the yearly total and the monthly value cannot collide on one key',
        panel.rows.some(r => r.metric === 'market_revenue_p50_total' && r.stay === ASOF)
        && panel.rows.some(r => r.metric === 'market_revenue_p50' && r.stay === '2026-09-01'),
        JSON.stringify(panel.rows.map(r => `${r.metric}@${r.stay}`)))
  check('every panel row names the listing whose coordinate it was measured from',
        panel.rows.every(r => r.sampled !== null))

  estimatorBody = { KPIsByBedroomCategory: { '3': { NoOfListings: 9 }, '4': { NoOfListings: 8 } } }
  const wrongCat = await importPriceLabsMarket(
    c, new PriceLabsClient({ apiKey: 'estimator-key', base, sleep: async () => {} }), 'CHF', ASOF)
  check('a response carrying only OTHER bedroom categories is not read as ours',
        wrongCat.fetched === 0 && wrongCat.failed === 1, JSON.stringify(wrongCat))

  /* ------------------------------------------------- 11 · the whole pass */

  statusFor = {}
  pricesBody = []
  metricsBody = { data: {} }
  reservationsPages = [{ next_page: false, data: [] }]
  estimatorBody = { KPIsByBedroomCategory: {} }
  const full = await importPriceLabs(c, client(), { today: ASOF })
  check('the pass reports itself as PriceLabs', isPriceLabsReport(full))
  check('and is NOT mistaken for the Elev8 shape, which also has `listings`',
        !isElev8Report(full))
  check('a missing estimator key is a stage that did not run, not one that failed',
        full.market === null && full.skipped.some(s => s.includes('PRICELABS_ESTIMATOR_API_KEY')),
        JSON.stringify(full.skipped))
  check('the import page reads the right three numbers out of it',
        reportCounts(full).created === 0 && reportCounts(full).known === 2,
        JSON.stringify(reportCounts(full)))
  check('created stays zero, because PriceLabs never invents an object',
        reportCounts(full).created === 0)

  listingsBody = { listings: [] }
  const empty = await importPriceLabs(c, client(), { today: ASOF })
  check('a pass that placed nothing says so instead of running four empty stages',
        empty.prices === null && empty.skipped.some(s => s.includes('no PriceLabs listing')),
        JSON.stringify(empty.skipped))

  /* ------------------------------------------------- 12 · transport failures */

  statusFor['/v1/listings'] = 401
  let unauth: unknown = null
  try { await client().get('/v1/listings') } catch (e) { unauth = e }
  check('a 401 names the variable that was rejected',
        unauth instanceof PriceLabsBlockedError && unauth.blocked === 'unauthorised'
        && unauth.message.includes('PRICELABS_API_KEY'), String(unauth))
  statusFor['/v1/listings'] = 500
  let broke: unknown = null
  try { await client().get('/v1/listings') } catch (e) { broke = e }
  check('a 500 is an error, not a named state',
        broke instanceof PriceLabsError && !(broke instanceof PriceLabsBlockedError))

  c.release()
  await pool.end()
  srv.close()
  console.log(fails ? `\n${fails} FAILED` : '\nall green')
  process.exit(fails ? 1 : 0)
}

main().catch(e => { console.error(e); process.exit(1) })
