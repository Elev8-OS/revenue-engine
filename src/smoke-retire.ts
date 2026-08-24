/**
 * Removing objects that are not lettings.
 *
 * Every check here exists because the instruction "delete all of these" was
 * given twice on the strength of the objects' NAMES, and a name has already been
 * wrong once: "1 - 3 Plunge Pool" reads as junk in Elev8 and is a three-unit
 * listing priced in PriceLabs. So the property under test is that evidence beats
 * the name in every direction.
 */
import { Pool } from 'pg'
import { verdictFor, retire, candidates, type RetireCandidate } from './entity/retire.js'
import { link } from './entity/resolve.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}
const base = (over: Partial<RetireCandidate> = {}): RetireCandidate => ({
  entityId: 'e', label: 'X', roomIds: 0, otaLinks: 0,
  hasPmsProperty: false, snapshots: 0, findings: 0, ...over,
})

/* ------------------------------------------------------- 1 · the verdict */

check('with no evidence of being sellable, it is deleted',
      verdictFor(base()).action === 'delete')

// The three ways a name can be wrong.
check('a Channex room id keeps it, whatever it is called',
      verdictFor(base({ label: 'Lager Schaffhausen', roomIds: 1 })).action === 'keep')
check('an OTA link keeps it, whatever it is called',
      verdictFor(base({ label: 'Apartment Storage', otaLinks: 1 })).action === 'keep')
check('a PMS property id keeps it, whatever it is called',
      verdictFor(base({ label: 'Laundry', hasPmsProperty: true })).action === 'keep')
check('and the reason names the evidence, not the name',
      verdictFor(base({ roomIds: 3 })).reason.includes('3 bookable room'))

// Measured objects are hidden, never erased: numbers somebody may have acted on
// must remain reconstructable.
check('a measured object is deactivated instead of deleted',
      verdictFor(base({ snapshots: 12 })).action === 'deactivate')
check('so is one carrying findings',
      verdictFor(base({ findings: 1 })).action === 'deactivate')
check('and the reason says the record stays',
      verdictFor(base({ snapshots: 4 })).reason.includes('the record stays'))
// Evidence of being sellable outranks history — keep beats deactivate.
check('sellable AND measured is kept, not deactivated',
      verdictFor(base({ roomIds: 1, snapshots: 99 })).action === 'keep')

/* ------------------------------------------------- 2 · against a database */

const c = await pool.connect()
await c.query('delete from entity')

const mk = async (label: string, pms: string | null = null) => (await c.query<{ id: string }>(
  `insert into entity (label, market, pms_property_id) values ($1, 'ch', $2) returning id`,
  [label, pms])).rows[0]!.id

const junk = await mk('Laundry')
const office = await mk('Büro Hauptgasse 33')
const sellable = await mk('The R Loft')
const measured = await mk('Gebäude Neustadt 2')
const withPms = await mk('Martin Apartments', 'prop-9')

await link(c, { source: 'channex', kind: 'room', externalId: 'room-loft' }, sellable, 'explicit')
await c.query(
  `insert into snapshot (entity_id, as_of_date, metric, stay_date, value, source)
   values ($1, current_date, 'occupancy_on_books', current_date, 0.5, 'pricelabs')`, [measured])

const seen = await candidates(c)
check('the evidence is read per object', seen.length === 5, `${seen.length} candidates`)
check('and it finds the room id', seen.find(s => s.label === 'The R Loft')?.roomIds === 1)
check('and the snapshot', seen.find(s => s.label === 'Gebäude Neustadt 2')?.snapshots === 1)

// THE central guard: acting on named labels, not on "everything in that list".
const out = await retire(c, [
  'Laundry', 'Büro Hauptgasse 33', 'The R Loft', 'Gebäude Neustadt 2', 'Martin Apartments',
])
check('the two with no evidence are deleted',
      out.deleted.length === 2 && out.deleted.every(d => ['Laundry', 'Büro Hauptgasse 33'].includes(d.label)),
      JSON.stringify(out.deleted))
check('the measured one is deactivated, not deleted',
      out.deactivated.length === 1 && out.deactivated[0]!.label === 'Gebäude Neustadt 2',
      JSON.stringify(out.deactivated))
check('the sellable one and the one with a PMS id are KEPT despite being named',
      out.kept.length === 2, JSON.stringify(out.kept))
check('and each refusal says which evidence saved it',
      out.kept.every(k => k.reason.length > 10), JSON.stringify(out.kept))

const left = await c.query<{ label: string, active: boolean }>(
  `select label, active from entity order by label`)
check('the deleted rows are gone from the table', left.rows.length === 3, JSON.stringify(left.rows))
check('the deactivated row is still there, just inactive',
      left.rows.find(r => r.label === 'Gebäude Neustadt 2')?.active === false)
check('the kept rows are untouched and still active',
      left.rows.filter(r => r.active).length === 2)
// The snapshot must survive the deactivation — that is the whole point of it.
check('the measurements behind the deactivated object survive',
      (await c.query<{ n: number }>(`select count(*)::int n from snapshot`)).rows[0]!.n === 1)

/* ------------------------------------------------------- 3 · the blast radius */

const other = await mk('Innocent Apartment')
await retire(c, ['Laundry'])   // already gone
check('naming something that no longer exists does nothing',
      (await c.query<{ n: number }>(`select count(*)::int n from entity`)).rows[0]!.n === 4)
const none = await retire(c, [])
check('an empty list removes nothing at all',
      none.deleted.length === 0 && none.deactivated.length === 0
      && (await c.query<{ n: number }>(`select count(*)::int n from entity`)).rows[0]!.n === 4)
check('and an unrelated object was never touched',
      (await c.query<{ n: number }>(
        `select count(*)::int n from entity where id = $1 and active`, [other])).rows[0]!.n === 1)
// Whitespace differences must not turn a named object into a missed one.
await retire(c, ['  Innocent Apartment  '])
check('a label is matched after trimming, so a stray space does not silently skip it',
      (await c.query<{ n: number }>(
        `select count(*)::int n from entity where id = $1`, [other])).rows[0]!.n === 0)

c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
