/** Functional smoke test against a throwaway Postgres. Not a substitute for
 *  real tests, but it proves the load-bearing logic does what the comments claim. */
import { getPool } from './db.js'
import { rateFor, convert, FxError } from './fx/index.js'
import { resolve, resolveByLabel, link, splitPriceLabsId, normaliseElev8Id } from './entity/resolve.js'
import { writeSnapshots, pickup, recordFreshness, staleDatasets } from './snapshot/write.js'
import { dedupeMarketPanels } from './scheduler/budget.js'
import * as q from './dashboard/query.js'

const pool = getPool(process.env.DATABASE_URL!)
let fails = 0
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`)
  if (!cond) fails++
}

const c = await pool.connect()

// ---- entities
const bali = (await c.query(
  `insert into entity (label, market, band, band_basis, contract)
   values ('The R Villa Masurai', 'bali', '2BR', 'bedrooms', 'guaranteed_rent') returning id`)).rows[0].id
const dupA = (await c.query(
  `insert into entity (label, market, band, band_basis) values ('The R Villa Merapi', 'bali', '1BR', 'bedrooms') returning id`)).rows[0].id
await c.query(`insert into entity (label, market, band, band_basis) values ('The R Villa Merapi', 'bali', '1BR', 'bedrooms')`)

// ---- pure helpers
check('PriceLabs composite splits', splitPriceLabsId('2fc503c2___5e786457')?.right === '5e786457')
check('PriceLabs non-composite rejected', splitPriceLabsId('plain-id') === null)
check('Elev8 dashed UUID normalises to hex', normaliseElev8Id('2FC503C2-7706-4646-8ECE-41DF32ADCD96')?.length === 32)
check('Elev8 empty id is not a key', normaliseElev8Id('') === null)

// ---- alias resolution
await link(c, { source: 'mdv_booking', kind: 'property', externalId: '12554884' }, bali, 'explicit')
const r1 = await resolve(c, { source: 'mdv_booking', kind: 'property', externalId: '12554884' })
check('direct alias resolves', r1.ok && r1.entityId === bali)

// MEASURED: all 62 PriceLabs listings are `<channex_property>___<channex_room>`
// with pms_name 'channex'. The right half is the unit, the left is the building.
await link(c, { source: 'channex', kind: 'room', externalId: '5e786457' }, bali, 'explicit')
const r2 = await resolve(c, { source: 'pricelabs', kind: 'room', externalId: '2fc503c2___5e786457' })
check('the ROOM half resolves, and says which half it was',
      r2.ok && r2.entityId === bali && r2.matchedBy === 'pricelabs_room_half',
      r2.ok ? r2.matchedBy : r2.reason)

// THE trap, and why the property half is not a fallback at all. "The R Villa
// Merapi" is ONE Channex property with TWO rooms, so matching on the building
// would price two units as one — and it would look like a successful match.
const unitA = (await c.query(
  `insert into entity (label, market, pms_property_id)
   values ('Merapi Room 1-4', 'bali', 'afa397b2') returning id`)).rows[0].id
const unitB = (await c.query(
  `insert into entity (label, market, pms_property_id)
   values ('Merapi Room 5', 'bali', 'afa397b2') returning id`)).rows[0].id
const shared = await resolve(c, { source: 'pricelabs', kind: 'room', externalId: 'afa397b2___unseen' })
check('an unknown room half REFUSES rather than matching the building',
      !shared.ok, shared.ok ? `matched ${shared.matchedBy}` : shared.reason)
const sharedWhy = (await c.query<{ reason: string }>(
  `select reason from unresolved_alias where external_id = 'afa397b2___unseen'`)).rows[0]?.reason
check('and the recorded reason says how many units would have collapsed',
      Boolean(sharedWhy?.includes('2 unit')), sharedWhy ?? '')

// The unique constraint on entity_alias exists so a second claim is loud. It was
// not: `on conflict do nothing` made an id already pointing elsewhere look like
// a successful write, which is how the property id recorded an arbitrary winner.
check('claiming the same id for a second object is reported as a conflict',
      await link(c, { source: 'channex', kind: 'room', externalId: 'shared-room' }, unitA, 'explicit')
        === 'linked')
check('the same claim again is recognised as ours, not a conflict',
      await link(c, { source: 'channex', kind: 'room', externalId: 'shared-room' }, unitA, 'explicit')
        === 'already_ours')
check('a DIFFERENT object claiming it conflicts, and is not silently dropped',
      await link(c, { source: 'channex', kind: 'room', externalId: 'shared-room' }, unitB, 'explicit')
        === 'conflict')
check('and the conflict is recorded where it can surface',
      (await c.query<{ n: number }>(
        `select count(*)::int n from unresolved_alias where external_id = 'shared-room'`))
        .rows[0]!.n === 1)
check('the original claim still stands — the loser did not overwrite it',
      (await c.query<{ entity_id: string }>(
        `select entity_id::text from entity_alias where external_id = 'shared-room'`))
        .rows[0]!.entity_id === unitA)
await c.query(`delete from unresolved_alias where external_id in ('shared-room','afa397b2___unseen')`)
await c.query(`delete from entity where id = any($1::uuid[])`, [[unitA, unitB]])

const r3 = await resolveByLabel(c, { source: 'elev8', kind: 'listing', externalId: 'x1', label: 'The R Villa Merapi' })
check('ambiguous label stays UNRESOLVED', !r3.ok, r3.ok ? '' : r3.reason)

const r4 = await resolveByLabel(c, { source: 'elev8', kind: 'listing', externalId: 'x2', label: 'The R Villa Masurai' })
check('unique label resolves and is recorded as such', r4.ok && r4.matchedBy === 'unique_label')

const unres = await c.query(`select count(*)::int n from unresolved_alias`)
check('unresolved aliases are recorded, not dropped', unres.rows[0].n >= 1, `${unres.rows[0].n} row(s)`)

// ---- fx
await c.query(`insert into fx_rate (day, base, quote, rate, source) values
  ('2026-08-21', 'USD', 'IDR', 17665, 'jisdor'),
  ('2026-08-20', 'CHF', 'IDR', 21900, 'snb')`)
const fr = await rateFor(c, '2026-08-23', 'USD', 'IDR')
check('fx falls back to the last fixing', fr.rate === 17665 && fr.stale === 2, `stale ${fr.stale}d`)
const conv = await convert(c, { amount: 100, currency: 'USD' }, 'IDR', '2026-08-21')
check('conversion uses the booking day', Math.round(conv.amount) === 1766500)
let refused = false
try { await rateFor(c, '2026-09-30', 'USD', 'IDR') } catch (e) { refused = e instanceof FxError }
check('stale beyond the cap is REFUSED, not guessed', refused)
check('identity conversion needs no rate', (await convert(c, { amount: 5, currency: 'IDR' }, 'IDR', '2026-08-23')).amount === 5)

// ---- snapshot + pickup
await writeSnapshots(c, '2026-08-20', [
  { entityId: bali, metric: 'occupancy_on_books', stayDate: '2026-09-15', value: 0.31, source: 'pricelabs' },
])
await writeSnapshots(c, '2026-08-23', [
  { entityId: bali, metric: 'occupancy_on_books', stayDate: '2026-09-15', value: 0.43, source: 'pricelabs' },
])
const pk = await pickup(c, bali, 'occupancy_on_books', '2026-09-15', '2026-08-20', '2026-08-23')
check('pickup is computable from the archive', pk !== null && Math.abs(pk - 0.12) < 1e-9, `+${pk?.toFixed(2)}`)

const before = await c.query(`select value from snapshot where as_of_date='2026-08-23'`)
await writeSnapshots(c, '2026-08-23', [
  { entityId: bali, metric: 'occupancy_on_books', stayDate: '2026-09-15', value: 0.44, source: 'pricelabs' },
])
const after = await c.query(`select count(*)::int n from snapshot where as_of_date='2026-08-23'`)
check('same-day re-run overwrites, never duplicates', after.rows[0].n === before.rowCount)

// ---- freshness gate
await recordFreshness(c, 'mdv_booking', 'pricing', bali, new Date(Date.now() - 20 * 60_000).toISOString())
await recordFreshness(c, 'mdv_booking', 'property_core', bali, new Date(Date.now() - 25 * 3600_000).toISOString())
const stale = await staleDatasets(c, bali, 24)
check('freshness gate catches property_core only', stale.length === 1 && stale[0]!.dataset === 'property_core',
      stale.map(s => `${s.dataset} ${s.ageHours.toFixed(0)}h`).join(', '))

// ---- not assessable: the structural case AND the check case, once each
// The tile read 0 on a portfolio with four unbanded rooms, because it only
// queried a table that nothing writes until the check runner exists.
const unbanded = (await c.query(
  `insert into entity (label, market) values ('No Band Villa', 'bali') returning id`)).rows[0].id
const naStructural = await q.notAssessable(c, 'en')
check('a room with no band is not assessable, before any check runs',
      naStructural.some(r => r.label === 'No Band Villa'), JSON.stringify(naStructural))
check('and a banded room is NOT on the list',
      !naStructural.some(r => r.label === 'The R Villa Masurai'))
await c.query(
  `insert into not_assessable (entity_id, as_of, reason) values ($1, current_date, 'stale pricing')`,
  [unbanded])
const naBoth = await q.notAssessable(c, 'en')
// One room, one row: the check's reason is the more specific of the two and the
// count must not double.
check('a room that is both unbanded and unreached appears exactly once',
      naBoth.filter(r => r.label === 'No Band Villa').length === 1, JSON.stringify(naBoth))
check("and it reports the check's reason, not the structural one",
      naBoth.find(r => r.label === 'No Band Villa')?.reason === 'stale pricing')
await c.query(`delete from not_assessable`)
await c.query(`delete from entity where id = $1`, [unbanded])

// ---- market panel dedupe
const { panels, saved } = dedupeMarketPanels([
  { market: 'bali', band: '2BR' }, { market: 'bali', band: '2BR' },
  { market: 'bali', band: '1BR' }, { market: 'ch', band: '2BR' },
  { market: 'bali', band: null },
])
check('panel dedupe collapses duplicates and skips unbanded', panels.length === 3 && saved === 2,
      `${panels.length} panels, ${saved} fetches avoided`)

// ---- write ordering guarantee
const f = (await c.query(
  `insert into finding (entity_id, check_key, check_version, severity, headline)
   values ($1,'restrictions.minstay_below_margin_floor',2,'high','Two-night stays are margin-negative')
   returning id`, [bali])).rows[0].id
let fkBlocked = false
try {
  await c.query(`insert into write_attempt (finding_id, snapshot_id, target, lever, idempotency_key, request)
                 values ($1, gen_random_uuid(), 'pricelabs', 'min_stay', 'k1', '{}'::jsonb)`, [f])
} catch { fkBlocked = true }
check('a write CANNOT be logged without a snapshot', fkBlocked)

const snap = (await c.query(
  `insert into write_snapshot (finding_id, entity_id, prior) values ($1,$2,'{"min_stay":2}'::jsonb) returning id`,
  [f, bali])).rows[0].id
await c.query(`insert into write_attempt (finding_id, snapshot_id, target, lever, idempotency_key, request)
               values ($1,$2,'pricelabs','min_stay','k1','{"min_stay":3}'::jsonb)`, [f, snap])
let dupKey = false
try {
  await c.query(`insert into write_attempt (finding_id, snapshot_id, target, lever, idempotency_key, request)
                 values ($1,$2,'pricelabs','min_stay','k1','{"min_stay":3}'::jsonb)`, [f, snap])
} catch { dupKey = true }
check('a retry cannot double-apply (idempotency key is unique)', dupKey)

const dr = await c.query(`insert into lever_policy (lever, market) values ('min_stay','bali') returning dry_run`)
check('every lever starts in dry run', dr.rows[0].dry_run === true)

c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
