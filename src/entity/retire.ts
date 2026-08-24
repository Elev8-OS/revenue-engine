/**
 * Removing objects that are not lettings.
 *
 * The reason this is a separate file with a guard in it, rather than one DELETE
 * statement: the request to remove these rows was made twice on the strength of
 * their NAMES, and a name has already been wrong once.
 *
 * "1 - 3 Plunge Pool" read as junk in the Elev8 list. The PriceLabs account
 * prices a listing called "1 - 3 Plunge Pool" with three units. And "The R Loft"
 * appears in Elev8 as one row while PriceLabs carries three of them — Bali
 * Single Room, Java&Sulawesi Double (2 units), Kalimantan Double. Those rows are
 * not rubbish, they are BUILDINGS whose units exist separately. Removing a
 * building from a portfolio of units is right; removing it because its name
 * sounded like storage would have been luck.
 *
 * So the test is never the name. It is whether anything in any connected system
 * treats the object as bookable:
 *
 *   a Channex room id   the channel manager gave it a sellable unit
 *   an OTA link         it is published for sale on Airbnb or Booking
 *   a PMS property id   it is a property in the channel manager at all
 *
 * With none of the three, nothing we can see sells it. With any of them, it is a
 * letting whatever it is called, and it is not removed — it is REPORTED, so the
 * caller finds out that their instruction did not fit one of its targets.
 *
 * And history is never destroyed. An object carrying snapshots or findings has
 * been measured and assessed; deleting it would erase the evidence behind
 * numbers somebody may have already acted on. Those are deactivated instead,
 * which takes them out of every view while keeping the record.
 */
import type { PoolClient } from 'pg'

export interface RetireCandidate {
  entityId: string
  label: string
  roomIds: number
  otaLinks: number
  hasPmsProperty: boolean
  snapshots: number
  findings: number
}

export type RetireVerdict =
  | { action: 'delete', reason: 'nothing treats it as bookable' }
  | { action: 'deactivate', reason: string }
  | { action: 'keep', reason: string }

/**
 * Decides what may happen to one candidate. Pure, so the decision is testable
 * without a database and readable without running anything.
 */
export function verdictFor(c: RetireCandidate): RetireVerdict {
  if (c.roomIds > 0) {
    return { action: 'keep', reason: `the channel manager gave it ${c.roomIds} bookable room(s)` }
  }
  if (c.otaLinks > 0) {
    return { action: 'keep', reason: `it is published on ${c.otaLinks} OTA listing(s)` }
  }
  if (c.hasPmsProperty) {
    return { action: 'keep', reason: 'it is a property in the channel manager' }
  }
  // Nothing sells it — but if it has been measured, the measurements are the
  // reason not to delete. Out of sight is enough; out of existence is not.
  if (c.snapshots > 0 || c.findings > 0) {
    return {
      action: 'deactivate',
      reason: `nothing treats it as bookable, but it carries ${c.snapshots} snapshot(s) `
        + `and ${c.findings} finding(s) — the record stays`,
    }
  }
  return { action: 'delete', reason: 'nothing treats it as bookable' }
}

/** The evidence for every active object, whether or not it is a candidate. */
export async function candidates(client: PoolClient): Promise<RetireCandidate[]> {
  const { rows } = await client.query<RetireCandidate>(
    `select e.id as "entityId", e.label,
            (select count(*)::int from entity_alias a
              where a.entity_id = e.id and a.source = 'channex' and a.kind = 'room') as "roomIds",
            (select count(*)::int from entity_alias a
              where a.entity_id = e.id and a.source in ('mdv_airbnb','mdv_booking')) as "otaLinks",
            (e.pms_property_id is not null) as "hasPmsProperty",
            (select count(*)::int from snapshot s where s.entity_id = e.id) as snapshots,
            (select count(*)::int from finding f where f.entity_id = e.id) as findings
       from entity e
      where e.active
      order by e.label`)
  return rows
}

export interface RetireOutcome {
  deleted: { label: string }[]
  deactivated: { label: string, reason: string }[]
  /** Named individually: an instruction that did not fit its target is news. */
  kept: { label: string, reason: string }[]
}

/**
 * Acts on the candidates whose labels are named, and only on those.
 *
 * Takes explicit labels rather than "everything with no band", because those are
 * different sets and conflating them is how a real letting gets deleted. An
 * object can lack a band simply because nobody set its rooms up in Elev8 — that
 * is a data gap, not a reason it is not a letting.
 */
export async function retire(
  client: PoolClient, labels: string[],
): Promise<RetireOutcome> {
  const wanted = new Set(labels.map(l => l.trim()).filter(Boolean))
  const out: RetireOutcome = { deleted: [], deactivated: [], kept: [] }
  if (!wanted.size) return out

  for (const c of await candidates(client)) {
    if (!wanted.has(c.label.trim())) continue
    const v = verdictFor(c)
    if (v.action === 'keep') { out.kept.push({ label: c.label, reason: v.reason }); continue }
    if (v.action === 'deactivate') {
      await client.query(`update entity set active = false, updated_at = now() where id = $1`,
                         [c.entityId])
      out.deactivated.push({ label: c.label, reason: v.reason })
      continue
    }
    // Aliases cascade; nothing else is attached, because having something
    // attached is exactly what routed this to 'deactivate' instead.
    await client.query(`delete from entity where id = $1`, [c.entityId])
    out.deleted.push({ label: c.label })
  }
  return out
}
