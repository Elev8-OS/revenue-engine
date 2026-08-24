/**
 * Elev8, against a stand-in provider.
 *
 * What is actually being protected here is not "does a GET work". It is the
 * three specific ways this adapter could produce a confident, tidy, wrong
 * answer:
 *
 *   1. An EMPTY room list banded as a studio. Three fields in this project have
 *      already turned out to exist and be empty, so the empty case is the
 *      likely case, not the edge case.
 *   2. The WRONG id picked for the OTA link. A channel payload plausibly carries
 *      both an Elev8 listing id and an OTA listing id, and choosing wrongly
 *      yields a complete mapping that is entirely false.
 *   3. A PARTIAL bed sum reported as a capacity. An understated capacity puts an
 *      apartment in the wrong cohort, which is worse than putting it in none.
 */
import { createServer, type IncomingMessage } from 'node:http'
import { Pool } from 'pg'
import { getServiceToken, sessionState, authFromEnv, Elev8AuthError } from './sources/elev8/auth.js'
import { Elev8Client, makeLogin, unwrap, Elev8Error } from './sources/elev8/client.js'
import { describe, recordShape, latestShape, knownShapes, pickField } from './sources/elev8/shape.js'
import { bandFromRooms, bandFromSleeps, readBedTypes, readRooms } from './sources/elev8/rooms.js'
import { idForm, formProfile, pickIdPaths, classify, readChannels, linkChannel }
  from './sources/elev8/channels.js'
import { keyOf, marketOf, labelOf, marketFromCountryName, importListings }
  from './sources/elev8/listings.js'
import { importElev8 } from './sources/elev8/import.js'
import { link } from './entity/resolve.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

const port = 4593
const base = `http://127.0.0.1:${port}`

// ---- provider state, all switchable per test
let loginCalls = 0
let loginResponse: unknown = { status: 'SUCCESS', data: { token: 'jwt-'.padEnd(30, 'x'), expires_in: 3600 } }
let loginStatus = 200
let seenAuthHeader = ''
let seenApiKey = ''
let listings: unknown[] = []
let bedTypes: unknown[] = []
let roomsByListing: Record<string, unknown[]> = {}
let channels: unknown[] = []
let channelListings: Record<string, unknown[]> = {}
let listingStatusQueue: number[] = []
let getCalls = 0

const body = async (req: IncomingMessage) => {
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
  seenAuthHeader = String(req.headers.authorization ?? '')
  seenApiKey = String(req.headers['x-api-key'] ?? '')

  if (p === '/api/v1/auth/login') { loginCalls++; await body(req); return json(loginResponse, loginStatus) }
  if (p === '/api/v1/listing') {
    getCalls++
    const s = listingStatusQueue.shift() ?? 200
    if (s !== 200) return json({ status: 'FAILED', message: 'nope' }, s)
    return json({ status: 'SUCCESS', data: listings, total: listings.length,
                  per_page: 100, current_page: 1, last_page: 1 })
  }
  if (p === '/api/v1/bed-type') return json({ status: 'SUCCESS', data: bedTypes })
  const room = /^\/api\/v1\/listing\/([^/]+)\/room$/.exec(p)
  if (room) return json({ status: 'SUCCESS', data: roomsByListing[decodeURIComponent(room[1]!)] ?? [] })
  if (p === '/api/v1/channex/channel') return json({ status: 'SUCCESS', data: channels })
  const cl = /^\/api\/v1\/channex\/channel\/([^/]+)\/listings$/.exec(p)
  if (cl) return json({ status: 'SUCCESS', data: channelListings[decodeURIComponent(cl[1]!)] ?? [] })
  res.writeHead(404); res.end('{}')
})
await new Promise<void>(r => srv.listen(port, r))

const c = await pool.connect()
const reset = async () => {
  await c.query('delete from entity_alias'); await c.query('delete from unresolved_alias')
  await c.query('delete from entity'); await c.query('delete from service_session')
  await c.query('delete from api_shape')
  loginCalls = 0; loginStatus = 200; getCalls = 0; listingStatusQueue = []
  loginResponse = { status: 'SUCCESS', data: { token: 'jwt-'.padEnd(30, 'x'), expires_in: 3600 } }
}
const jwtClient = () => new Elev8Client({
  auth: { mode: 'jwt', email: 'svc@example.com', password: 'pw' }, base,
  login: makeLogin(base),
})
const keyClient = () => new Elev8Client({ auth: { mode: 'apikey', apiKey: 'elv8_pk_test' }, base })

/* ------------------------------------------------------- 1 · mode resolution */

check('an API key wins when both are set',
      authFromEnv({ ELEV8_API_TOKEN: 'k', ELEV8_LOGIN_EMAIL: 'a@b.c', ELEV8_LOGIN_PASSWORD: 'p' } as NodeJS.ProcessEnv)
        .auth?.mode === 'apikey')
check('email and password give jwt mode',
      authFromEnv({ ELEV8_LOGIN_EMAIL: 'a@b.c', ELEV8_LOGIN_PASSWORD: 'p' } as NodeJS.ProcessEnv)
        .auth?.mode === 'jwt')
// Half-configured must be an error, not a silent fall-through to "unconfigured":
// those two states need opposite responses from whoever set the variable.
const half = authFromEnv({ ELEV8_LOGIN_EMAIL: 'a@b.c' } as NodeJS.ProcessEnv)
check('an address without a password is refused loudly', half.auth === null
      && 'reason' in half && half.reason.includes('together'), 'reason' in half ? half.reason : '')
check('nothing configured says so', authFromEnv({} as NodeJS.ProcessEnv).auth === null)

/* ------------------------------------------------------------- 2 · the login */

await reset()
const t1 = await getServiceToken(c, makeLogin(base), { email: 'a@b.c', password: 'p' })
check('a token comes back', t1.startsWith('jwt-'))
check('the login was called once', loginCalls === 1)
const t2 = await getServiceToken(c, makeLogin(base), { email: 'a@b.c', password: 'p' })
check('a live token is reused, not re-fetched', t2 === t1 && loginCalls === 1)

await c.query(`update service_session set expires_at = now() + interval '10 seconds'`)
await getServiceToken(c, makeLogin(base), { email: 'a@b.c', password: 'p' })
check('a token inside the skew window IS refreshed', loginCalls === 2)

const st = await sessionState(c)
check('the session state reports presence and expiry', st.present && st.failures === 0)

// The token field name is undocumented. All four candidates must work, and a
// response with none of them must name the keys it DID see.
for (const [k, label] of [['access_token', 'access_token'], ['accessToken', 'accessToken'],
                          ['jwt', 'jwt']] as const) {
  await reset()
  loginResponse = { status: 'SUCCESS', data: { [k]: 'tok-'.padEnd(30, 'y') } }
  const tok = await getServiceToken(c, makeLogin(base), { email: 'a@b.c', password: 'p' })
  check(`a token under '${label}' is found`, tok.startsWith('tok-'))
}
await reset()
loginResponse = { status: 'SUCCESS', data: { session: 'something', user_id: 7 } }
let authErr = ''
try { await getServiceToken(c, makeLogin(base), { email: 'a@b.c', password: 'p' }) }
catch (e) { authErr = (e as Error).message }
check('an unrecognised login response names the keys it saw',
      authErr.includes('session') && authErr.includes('user_id'), authErr)
check('and the response value is NOT in the message', !authErr.includes('something'), authErr)
const failed = await sessionState(c)
check('a failed login is recorded but does not read as a session',
      !failed.present && failed.failures === 1 && Boolean(failed.lastError))

await reset()
loginStatus = 401
let unauth = false
try { await getServiceToken(c, makeLogin(base), { email: 'a@b.c', password: 'p' }) }
catch (e) { unauth = e instanceof Elev8AuthError }
check('a rejected login surfaces as an auth error', unauth)

/* ------------------------------------------------------ 3 · envelope and keys */

check('a wrapped body is unwrapped', unwrap<number[]>({ status: 'SUCCESS', data: [1, 2] }).data.length === 2)
check('and reports itself as wrapped', unwrap({ status: 'SUCCESS', data: [] }).envelope === 'wrapped')
check('a bare array is passed through', unwrap<number[]>([1, 2, 3]).data.length === 3)
check('and reports itself as bare', unwrap([1]).envelope === 'bare')
check('a bare object is the payload, not an empty wrapper',
      (unwrap<{ id: string }>({ id: 'x' }).data).id === 'x')
check('paging is read where present',
      unwrap({ data: [], total: 9, per_page: 5, current_page: 2, last_page: 2 }).page?.last === 2)

await reset()
await keyClient().get(c, '/api/v1/listing')
check('apikey mode sends X-Api-Key and no bearer', seenApiKey === 'elv8_pk_test' && !seenAuthHeader)
await reset()
await jwtClient().get(c, '/api/v1/listing')
check('jwt mode sends a bearer and no api key', seenAuthHeader.startsWith('Bearer ') && !seenApiKey)

// A rejected API key will not improve on a retry. Retrying it would just be a
// second rejection and a second request against an undocumented rate limit.
await reset()
listingStatusQueue = [401, 200]
let keyRefused = false
try { await keyClient().get(c, '/api/v1/listing') } catch (e) { keyRefused = e instanceof Elev8Error }
check('a 401 in apikey mode is NOT retried', keyRefused && getCalls === 1, `${getCalls} call(s)`)

await reset()
listingStatusQueue = [401, 200]
await jwtClient().get(c, '/api/v1/listing')
check('a 401 in jwt mode forces one login and succeeds', getCalls === 2 && loginCalls === 2)

/* ------------------------------------------------------------- 4 · the shape */

const samples = [
  { id: 'a', name: 'One', rooms: [{ n: 1 }], meta: { x: 1 } },
  { id: 'b', name: '', rooms: [], meta: { x: null } },
  { id: 'c', rooms: [{ n: 2 }, { n: 3 }] },
]
const shape = describe(samples)
const at = (p: string) => shape.find(e => e.path === p)
check('every path is described', shape.length >= 5, shape.map(e => e.path).join(' '))
check('an empty string counts as absent', at('name')?.filled === 1, JSON.stringify(at('name')))
check('an empty array counts as absent', at('rooms')?.filled === 2)
// The trap this exists for: a nested path must report against the parents that
// exist, not against the sample count, or three rooms across three listings
// reads as "no rooms" instead of "three rooms".
check('a nested path reports against its own parents',
      at('rooms[].n')?.total === 3 && at('rooms[].n')?.filled === 3,
      JSON.stringify(at('rooms[].n')))
check('a null is a type but not a fill',
      Boolean(at('meta.x')?.types.includes('null')) && at('meta.x')?.filled === 1)

await reset()
await recordShape(c, 'elev8', 'GET /x', samples, 'note')
const back = await latestShape(c, 'elev8', 'GET /x')
check('a shape round-trips through the database', back?.sampleCount === 3
      && back.shape.some(e => e.path === 'rooms[].n'))
check('the note survives', back?.note === 'note')
check('known shapes are listable', (await knownShapes(c, 'elev8')).length === 1)
// A shape must be safe to store and safe to show. Values are neither.
check('NO value from the samples is stored',
      !JSON.stringify(back?.shape).includes('One'), JSON.stringify(back?.shape).slice(0, 120))

check('pickField prefers the better-filled candidate',
      pickField(shape, ['name', 'id'])?.path === 'id')
check('pickField ignores an empty field', pickField([
  { path: 'a', types: ['null'], filled: 0, total: 5 },
  { path: 'b', types: ['string'], filled: 5, total: 5 },
], ['a', 'b'])?.path === 'b')
check('pickField returns null when nothing is filled', pickField([
  { path: 'a', types: ['null'], filled: 0, total: 5 },
], ['a']) === null)

/* -------------------------------------------------------------- 5 · the band */

check('one room is 1BR', bandFromRooms(1) === '1BR')
check('four rooms is 4BR', bandFromRooms(4) === '4BR')
check('the tail collapses so a cohort can exist', bandFromRooms(9) === '5BR+')
// THE central guard of this file.
check('ZERO rooms is not a studio, it is unknown', bandFromRooms(0) === null)
check('and null stays null', bandFromRooms(null) === null)
check('capacity bands are deliberately coarser', bandFromSleeps(4) === 'sleeps 3-4')
check('zero capacity is unknown too', bandFromSleeps(0) === null)

/* ------------------------------------------------------- 6 · rooms in anger */

await reset()
bedTypes = [{ id: 'bt-double', name: 'Double', capacity: 2 },
            { id: 'bt-single', name: 'Single', capacity: 1 }]
const beds = await readBedTypes(c, keyClient())
check('bed capacities are read', beds.byId.get('bt-double') === 2 && beds.field === 'capacity')

roomsByListing['L1'] = [
  { id: 'r1', name: 'Master', bed_configurations: [{ bed_type_id: 'bt-double', quantity: 1 }] },
  { id: 'r2', name: 'Second', bed_configurations: [{ bed_type_id: 'bt-single', quantity: 2 }] },
]
const r1 = await readRooms(c, keyClient(), 'L1', beds)
check('two rooms band as 2BR', r1.rooms === 2 && r1.band === '2BR' && r1.basis === 'bedrooms')
check('and the capacity adds up', r1.sleeps === 4, String(r1.sleeps))

// The empty case, which is the likely case.
roomsByListing['L2'] = []
const r2 = await readRooms(c, keyClient(), 'L2', beds)
check('an empty room list yields NO band', r2.band === null && r2.rooms === null)
check('and says the feature is unused rather than counting zero',
      r2.notes.some(n => n.includes('unused')), r2.notes.join(' | '))

// A partial sum is worse than none: it looks like a capacity and understates it.
roomsByListing['L3'] = [
  { id: 'r1', bed_configurations: [{ bed_type_id: 'bt-double', quantity: 1 },
                                   { bed_type_id: 'bt-mystery', quantity: 1 }] },
]
const r3 = await readRooms(c, keyClient(), 'L3', beds)
check('an unknown bed type withholds sleeps rather than undercounting', r3.sleeps === null)
check('and the band still stands on the room count', r3.band === '1BR')
check('the reason is recorded', r3.notes.some(n => n.includes('withheld')), r3.notes.join(' | '))

// Bed types with no capacity field at all: sleeps is unknowable, band is not.
await reset()
bedTypes = [{ id: 'bt-double', name: 'Double Bed' }]
const noCap = await readBedTypes(c, keyClient())
check('bed types without a capacity field are reported, not guessed',
      noCap.field === null && noCap.note.includes('no capacity field'), noCap.note)
roomsByListing['L4'] = [{ id: 'r1', bed_configurations: [{ bed_type_id: 'bt-double', quantity: 1 }] }]
const r4 = await readRooms(c, keyClient(), 'L4', noCap)
check('the band survives without capacities', r4.band === '1BR' && r4.sleeps === null)

/* ------------------------------------------------------- 7 · the id forms */

check('a dashed UUID is uuid', idForm('2FC503C2-7706-4646-8ECE-41DF32ADCD96') === 'uuid')
check('32-hex is uuid', idForm('2fc503c277064646'.padEnd(32, 'a')) === 'uuid')
check('an Airbnb-style number is numeric', idForm('595153') === 'numeric')
check('an integer is numeric', idForm(12554884) === 'numeric')
check('a slug is other', idForm('the-r-villa') === 'other')
check('empty is nothing at all', idForm('') === null && idForm(null) === null)

const chRows = [
  { listing_id: '2fc503c2770646468ece41df32adcd96', channel_listing_id: '595153' },
  { listing_id: '3fc503c2770646468ece41df32adcd97', channel_listing_id: '595154' },
]
const prof = formProfile(chRows)
check('the form profile separates the two id spaces',
      prof.get('listing_id')?.uuid === 2 && prof.get('channel_listing_id')?.numeric === 2)
const picked = pickIdPaths(chRows)
check('the Elev8 id is the UUID-shaped one and the OTA id the numeric one',
      picked.ok && picked.elev8Path === 'listing_id' && picked.otaPath === 'channel_listing_id',
      picked.ok ? picked.evidence : picked.reason)

// THE failure that would be invisible: two numeric candidates, no way to tell
// which is the OTA's. Refusing is the only correct answer.
const ambiguous = pickIdPaths([
  { listing_id: '2fc503c2770646468ece41df32adcd96', channel_listing_id: '595153', room_id: '99' },
])
check('two numeric id candidates REFUSE rather than pick',
      !ambiguous.ok && ambiguous.reason.includes('ambiguous'),
      ambiguous.ok ? '' : ambiguous.reason)
// Discovered by a typo in this very fixture, and worth keeping: a field that is
// half UUID and half something else is a field we do not understand, and the
// refusal must name what it saw so the next person looks instead of guessing.
const halfBad = pickIdPaths([
  { listing_id: '2fc503c2770646468ece41df32adcd96', channel_listing_id: '595153' },
  { listing_id: 'not-an-id', channel_listing_id: '595154' },
])
check('a half-recognisable id field refuses and names the forms it saw',
      !halfBad.ok && halfBad.reason.includes('listing_id(u1/n0/o1)'),
      halfBad.ok ? '' : halfBad.reason)

const noUuid = pickIdPaths([{ channel_listing_id: '595153' }])
check('no UUID-shaped path refuses too', !noUuid.ok)
check('an empty channel refuses with a reason of its own',
      !pickIdPaths([]).ok)

check('Airbnb is classified', classify('Airbnb (Official)') === 'mdv_airbnb')
check('Booking.com is classified', classify('Booking.com') === 'mdv_booking')
check('Vrbo is NOT guessed into the nearest match', classify('Vrbo') === null)

/* --------------------------------------------------- 8 · listings and market */

check('a dashed id normalises to a key', keyOf({ listing_id: '2FC503C2-7706-4646-8ECE-41DF32ADCD96' })?.length === 32)
check('an empty listing_id is not a key', keyOf({ listing_id: '' }) === null)
// The bug this suite found: Elev8 NAMES countries, MDV codes them, and the
// code matcher returns null for every name — which does not fail, it quietly
// produces a portfolio with no markets.
check('a country NAME resolves', marketFromCountryName('Indonesia') === 'bali')
check('a localised name resolves too', marketFromCountryName('Schweiz') === 'ch')
check('a two-letter value is still read as a code', marketFromCountryName('at') === 'at')
check('a country outside our three markets is correctly null',
      marketFromCountryName('Germany') === null)
check('country wins over coordinates', marketOf({ country: 'Switzerland', latitude: -8.6, longitude: 115.1 }) === 'ch')
check('coordinates are used where country is silent',
      marketOf({ latitude: '-8.649334', longitude: '115.123980' }) === 'bali')
check('neither yields null rather than a guess', marketOf({ listing_name: 'x' }) === null)
check('the label falls back to internal_name', labelOf({ internal_name: 'APT-1' }) === 'APT-1')

await reset()
listings = [
  { listing_id: '2fc503c2770646468ece41df32adcd96', listing_name: 'Villa One',
    country: 'Indonesia', maximum_capacity: 4 },
  { listing_id: '3fc503c2770646468ece41df32adcd97', listing_name: 'Chalet Two',
    latitude: '46.8', longitude: '8.2' },
  // A row with no listing_id: present in Elev8, not a rentable object.
  { id: '', internal_name: 'Apartment Storage', listing_name: '1 - 3 Plunge Pool' },
  { listing_id: '4fc503c2770646468ece41df32adcd98', listing_name: 'Nowhere' },
]
const li = await importListings(c, keyClient())
check('only rows with a listing_id become objects', li.created === 2, JSON.stringify(li))
check('the storage cupboard is counted, not imported', li.notRentable === 1)
check('and it is NOT on the not-assessable list',
      (await c.query(`select count(*)::int n from unresolved_alias where label like '%Plunge%'`))
        .rows[0]!.n === 0)
check('a row with no market IS recorded as unresolved', li.noMarket === 1
      && (await c.query(`select count(*)::int n from unresolved_alias`)).rows[0]!.n === 1)
const ents = await c.query<{ label: string, market: string, sleeps: number | null, band: string | null }>(
  `select label, market::text, sleeps, band from entity order by label`)
check('capacity lands as sleeps', ents.rows.find(r => r.label === 'Villa One')?.sleeps === 4)
// The weaker basis must not win by arriving first.
check('but capacity alone sets NO band', ents.rows.every(r => r.band === null),
      JSON.stringify(ents.rows))
const again = await importListings(c, keyClient())
check('a second pass creates nothing and knows it', again.created === 0 && again.alreadyKnown === 2)

/* ------------------------------------------------------- 9 · the OTA link */

await reset()
listings = [{ listing_id: '2fc503c2770646468ece41df32adcd96', listing_name: 'Villa One',
              country: 'Indonesia', maximum_capacity: 4 }]
await importListings(c, keyClient())
channels = [{ id: 'ch-air', title: 'Airbnb' }, { id: 'ch-book', title: 'Booking.com' },
            { id: 'ch-vrbo', title: 'Vrbo' }]
channelListings['ch-air'] = [
  { listing_id: '2fc503c2770646468ece41df32adcd96', channel_listing_id: '595153' },
  { listing_id: '9fc503c2770646468ece41df32adcd99', channel_listing_id: '595154' },
]
channelListings['ch-book'] = [
  { listing_id: '2fc503c2770646468ece41df32adcd96', channel_listing_id: '12554884' },
]
const found = await readChannels(c, keyClient())
check('three channels are seen, two classified',
      found.length === 3 && found.filter(x => x.source).length === 2)
const air = await linkChannel(c, keyClient(), { ...found[0]!, source: 'mdv_airbnb' })
check('the Airbnb id links to the entity behind the Elev8 listing', air.linked === 1,
      JSON.stringify(air))
check('an OTA listing whose Elev8 listing is not imported is recorded, not dropped',
      air.noEntity === 1)
const aliasRow = await c.query<{ matched_by: string }>(
  `select matched_by from entity_alias where source = 'mdv_airbnb' and external_id = '595153'`)
// The whole improvement over what came before: a key the channel manager
// maintains, not a name that is probably the same name.
check("and it is recorded as 'elev8_channel_map', not as a name match",
      aliasRow.rows[0]?.matched_by === 'elev8_channel_map', JSON.stringify(aliasRow.rows))
const bk = await linkChannel(c, keyClient(), { ...found[1]!, source: 'mdv_booking' })
check('the Booking id links to the SAME entity — one apartment, not three',
      bk.linked === 1)
const oneEntity = await c.query<{ n: number }>(
  `select count(distinct entity_id)::int n from entity_alias
    where source in ('elev8','mdv_airbnb','mdv_booking')`)
check('three aliases, one entity', oneEntity.rows[0]!.n === 1)
const twice = await linkChannel(c, keyClient(), { ...found[0]!, source: 'mdv_airbnb' })
check('a second pass links nothing and says it already knew', twice.linked === 0
      && twice.alreadyLinked === 1)

/* ----------------------------------------------------- 10 · the whole pass */

await reset()
listings = [{ listing_id: '2fc503c2770646468ece41df32adcd96', listing_name: 'Villa One',
              country: 'Indonesia', maximum_capacity: 6 },
            { listing_id: '3fc503c2770646468ece41df32adcd97', listing_name: 'Chalet Two',
              country: 'Switzerland', maximum_capacity: 4 }]
bedTypes = [{ id: 'bt-double', name: 'Double', capacity: 2 }]
roomsByListing['2fc503c2770646468ece41df32adcd96'] = [
  { id: 'r1', bed_configurations: [{ bed_type_id: 'bt-double', quantity: 1 }] },
  { id: 'r2', bed_configurations: [{ bed_type_id: 'bt-double', quantity: 1 }] },
]
// The second listing has no rooms — so the pass must fall back for it alone.
roomsByListing['3fc503c2770646468ece41df32adcd97'] = []
channels = [{ id: 'ch-air', title: 'Airbnb' }]
channelListings['ch-air'] = [
  { listing_id: '2fc503c2770646468ece41df32adcd96', channel_listing_id: '595153' },
]
const full = await importElev8(c, keyClient())
check('the pass imports, bands and links in one go',
      full.listings.created === 2 && full.rooms.banded === 1 && full.channels.links[0]?.linked === 1,
      JSON.stringify({ l: full.listings, r: full.rooms, c: full.channels.links }))
check('the listing with rooms is banded on bedrooms',
      (await c.query<{ band: string, band_basis: string }>(
        `select band, band_basis from entity where label = 'Villa One'`)).rows[0]?.band_basis === 'bedrooms')
// The fallback must be VISIBLE as a fallback, not silently equivalent.
const fb = (await c.query<{ band: string, band_basis: string }>(
  `select band, band_basis from entity where label = 'Chalet Two'`)).rows[0]
check('the listing without rooms falls back to capacity, and says so',
      fb?.band === 'sleeps 3-4' && fb.band_basis === 'occupancy', JSON.stringify(fb))
check('the fallback is counted', full.rooms.fellBackToOccupancy === 1)
check('no stage silently failed', full.stageErrors.length === 0, full.stageErrors.join(' | '))
check('the unusable channels are named rather than dropped',
      full.channels.seen === 1 && full.channels.ignored.length === 0)
check('the bed-type finding is carried in the report',
      full.bedTypes.includes('capacity'), full.bedTypes)
// Only the first listing's shape is stored: 55 identical shapes are 54 rows
// somebody has to read past.
const shapes = await knownShapes(c, 'elev8')
check('one shape row per endpoint, not one per listing',
      shapes.filter(s => s.endpoint.includes('/room')).length === 1,
      shapes.map(s => s.endpoint).join(' | '))

// A stage failing must not discard the stages that worked.
await reset()
listings = [{ listing_id: '2fc503c2770646468ece41df32adcd96', listing_name: 'Villa One',
              country: 'Indonesia' }]
channels = []
bedTypes = []
roomsByListing = {}
const partial = await importElev8(c, keyClient())
check('a pass with nothing to band still keeps its listings',
      partial.listings.created === 1 && partial.rooms.banded === 0)

srv.close(); c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
