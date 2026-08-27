/**
 * Units and beds from Elev8.
 *
 * WHAT THIS FILE GOT WRONG, AND WHY IT MATTERS MORE THAN THE FIX.
 *
 * It used to take the length of `/api/v1/listing/:id/room` and write it as a
 * BEDROOM band. Elev8's hierarchy is Tenant → Property → Room → Listing, and a
 * Room there is "a single bookable unit within a property" — the billing unit.
 * The array length is therefore the number of separately rentable units, and
 * calling it bedrooms turned The R Villa Merapi, five let-by-the-room units each
 * sleeping two, into a five-bedroom villa. "4 - 7 Studio" became 4BR against a
 * measured bedroom count of 1.
 *
 * The reasoning that produced it reads well and is still wrong: "the array
 * length needs no field name, so it is the most robust extraction available."
 * Robustly extracting the wrong quantity is not robustness. Nothing here had
 * ever established what an Elev8 room IS — and 016's header, in this same
 * repository, already said Merapi was one property with several rooms.
 *
 * So this file no longer claims bedrooms at all. It reports:
 *
 *   UNITS      the array length, named for what it counts. Not a band on its
 *              own: two units and four units say nothing about how comparable
 *              the objects are, only about how the building is let.
 *   SLEEPS     bed capacity, summed from the bed configuration where every bed
 *              type carries a number. A partial sum is withheld — an understated
 *              capacity puts an apartment in the wrong cohort rather than none.
 *   BAND       from capacity only, basis 'occupancy', and only where nothing has
 *              already banded the object by bedrooms. Bedrooms is the stronger
 *              basis and comes from PriceLabs `no_of_bedrooms`.
 *
 * AN EMPTY ROOM LIST IS STILL NOT A STUDIO. Zero units means the feature is
 * unused for that listing. Empty yields null, and null surfaces as
 * "not assessable" rather than as a manufactured cohort.
 */
import type { PoolClient } from 'pg'
import type { Elev8Client } from './client.js'
import { describe, pickField, recordShape, type ShapeEntry } from './shape.js'

/**
 * Candidate names, in no priority order — `pickField` decides by which one is
 * actually filled, not by which we listed first. Guessing an order would be a
 * silent preference; measuring is not.
 */
const BEDS_IN_ROOM = ['bed_configurations', 'bedConfigurations', 'beds', 'bed_config']
const QUANTITY = ['quantity', 'qty', 'count', 'amount', 'total']
const BED_CAPACITY = ['capacity', 'max_occupancy', 'maxOccupancy', 'occupancy',
                      'sleeps', 'person_count', 'people', 'max_person']

export type BandBasis = 'bedrooms' | 'occupancy'

export interface RoomsReading {
  /**
   * Separately bookable units under this listing, or null when the list came
   * back empty. NOT a bedroom count — see the header. Named `units` so the next
   * reader cannot make the mistake this field caused.
   */
  units: number | null
  /** Bed capacity, or null when the bed types carry no number to add up. */
  sleeps: number | null
  /** Always an occupancy band, or null. This reader cannot see bedrooms. */
  band: string | null
  basis: BandBasis | null
  /** Why sleeps is null, or which paths were used. Auditable, not folklore. */
  notes: string[]
}

/**
 * Bands from a BEDROOM count. The argument is bedrooms, not rooms, not units.
 *
 * The parameter name is load-bearing. This function was called with the length
 * of Elev8's room array — a count of bookable units — and produced "5BR" for a
 * villa let out room by room. Whatever is passed here must be a number of
 * bedrooms established by a source that measures bedrooms.
 *
 * `5BR+` collapses the tail on purpose: a cohort of one six-bedroom villa
 * compared against itself is not a comparison, and the whole point of the band
 * is to produce a group big enough to say something about.
 */
export function bandFromBedrooms(bedrooms: number | null): string | null {
  if (bedrooms === null || bedrooms < 1) return null
  return bedrooms >= 5 ? '5BR+' : `${bedrooms}BR`
}

/**
 * Bands from sleeping capacity — the documented fallback for when Elev8's room
 * feature turns out to be unused.
 *
 * Deliberately coarser than the bedroom band. Capacity is a weaker signal about
 * comparability (a sofa bed is not a bedroom), so pretending to the same
 * precision would be false confidence dressed as a fallback.
 */
export function bandFromSleeps(sleeps: number | null): string | null {
  if (sleeps === null || sleeps < 1) return null
  if (sleeps <= 2) return 'sleeps 1-2'
  if (sleeps <= 4) return 'sleeps 3-4'
  if (sleeps <= 6) return 'sleeps 5-6'
  return 'sleeps 7+'
}

/** Capacity per bed type id, where the source states a number. */
export type BedCapacities = { byId: Map<string, number>, field: string | null, note: string }

/**
 * Reads /api/v1/bed-type once and works out whether it carries a capacity at
 * all. Called once per import, not once per listing — the list is reference
 * data and re-reading it 55 times would spend the whole rate budget on it.
 */
export async function readBedTypes(
  db: PoolClient, api: Elev8Client,
): Promise<BedCapacities> {
  const res = await api.get<Record<string, unknown>[]>(db, '/api/v1/bed-type')
  const rows = Array.isArray(res.data) ? res.data : []
  const shape = await recordShape(db, 'elev8', 'GET /api/v1/bed-type', rows,
                                  `envelope: ${res.envelope}`)
  const cap = pickField(shape, BED_CAPACITY)
  const byId = new Map<string, number>()
  if (!cap) {
    return {
      byId, field: null,
      note: rows.length
        ? `bed types carry no capacity field (looked for ${BED_CAPACITY.join(', ')}); `
          + 'sleeps cannot be computed'
        : 'bed-type list is empty',
    }
  }
  for (const r of rows) {
    const id = r.id ?? r.bed_type_id
    const v = r[cap.path]
    if (typeof id === 'string' && typeof v === 'number' && v > 0) byId.set(id, v)
  }
  return {
    byId, field: cap.path,
    note: `capacity from '${cap.path}', filled ${cap.filled}/${cap.total}, `
      + `${byId.size} of ${rows.length} bed types usable`,
  }
}

/**
 * Reads one listing's rooms and derives the band.
 *
 * Takes the bed capacities rather than fetching them, so the caller controls how
 * often the reference data is read.
 */
export async function readRooms(
  db: PoolClient, api: Elev8Client, listingId: string, beds: BedCapacities,
  { collect }: { collect?: unknown[] } = {},
): Promise<RoomsReading> {
  const res = await api.get<Record<string, unknown>[]>(
    db, `/api/v1/listing/${encodeURIComponent(listingId)}/room`)
  const rooms = Array.isArray(res.data) ? res.data : []
  const notes: string[] = [`envelope: ${res.envelope}`]

  // Rooms are appended to the caller's collection rather than recorded here, so
  // the stored shape is derived from the whole portfolio. Recording per listing
  // produced a shape from a sample of one, and the first listing had no rooms —
  // which reads identically to "the API never returns rooms" and is not the
  // same thing at all.
  if (collect) collect.push(...rooms)
  const shape: ShapeEntry[] = describe(rooms)

  if (!rooms.length) {
    notes.push('room list is empty — the feature is unused for this listing, '
      + 'which is not a room count of zero')
    return { units: null, sleeps: null, band: null, basis: null, notes }
  }

  const bedsPath = pickField(shape, BEDS_IN_ROOM)
  let sleeps: number | null = null

  if (!bedsPath) {
    notes.push(`no bed list on the rooms (looked for ${BEDS_IN_ROOM.join(', ')})`)
  } else if (!beds.field) {
    notes.push(`bed list at '${bedsPath.path}' but ${beds.note}`)
  } else {
    const qty = pickField(shape, QUANTITY.map(q => `${bedsPath.path}[].${q}`))
    let total = 0
    let unknown = 0
    for (const room of rooms) {
      const list = (room as Record<string, unknown>)[bedsPath.path]
      if (!Array.isArray(list)) continue
      for (const b of list as Record<string, unknown>[]) {
        const id = b.bed_type_id ?? b.bedTypeId ?? b.bed_type ?? b.id
        const capacity = typeof id === 'string' ? beds.byId.get(id) : undefined
        const n = qty ? b[qty.path.split('.').pop()!] : 1
        const count = typeof n === 'number' && n > 0 ? n : 1
        if (capacity === undefined) { unknown++; continue }
        total += capacity * count
      }
    }
    // A partial sum is worse than no sum: it looks like a capacity and
    // understates it, and an understated capacity puts an apartment in the
    // wrong cohort rather than in none.
    if (unknown > 0) {
      notes.push(`${unknown} bed(s) of an unrecognised type — sleeps withheld rather than undercounted`)
    } else if (total > 0) {
      sleeps = total
      notes.push(`sleeps from ${bedsPath.path} × ${beds.field}`)
    }
  }

  // The band comes from capacity, never from the unit count. `sleeps` is the
  // measured bed capacity; where the bed types carried no number it is null and
  // the caller falls back to Elev8's own `maximum_capacity`, which is filled on
  // every listing on this account.
  return {
    units: rooms.length,
    sleeps,
    band: bandFromSleeps(sleeps),
    basis: sleeps === null ? null : 'occupancy',
    notes,
  }
}

/**
 * Applies a reading to an entity.
 *
 * Writes the measured inputs alongside the band on purpose. Storing only
 * "sleeps 3-4" throws away the evidence: it cannot be re-derived, cannot be
 * audited, and when the banding rule changes there is nothing left to re-run it
 * over.
 *
 * `capacityFallback` is Elev8's own `maximum_capacity`, used when the bed
 * configuration carried no addable number. It is a weaker reading than a summed
 * bed list — a stated maximum can include a sofa — so it is only reached for,
 * never preferred, and the note says which one was used.
 */
export async function applyReading(
  db: PoolClient, entityId: string, r: RoomsReading,
  capacityFallback: number | null = null,
): Promise<{ band: string | null, basis: BandBasis | null, from: string }> {
  const measured = r.sleeps !== null && r.sleeps > 0
  const capacity = measured ? r.sleeps
    : capacityFallback && capacityFallback > 0 ? capacityFallback : null
  const band = bandFromSleeps(capacity)
  const from = measured ? 'bed configuration'
    : capacity === null ? 'no capacity available' : 'maximum_capacity'

  /**
   * THE BAND IS ONLY WRITTEN WHERE NOTHING STRONGER IS HELD.
   *
   * An occupancy band must never overwrite a bedroom band. Before the basis was
   * ranked, whichever import ran last decided the cohort — which is how a wrong
   * band survived: it won by arriving, not by being better. The rank is
   * explicit here so import order stops being a silent input.
   */
  await db.query(
    `update entity
        set units = $2, sleeps = $3,
            band = case when band_basis = 'bedrooms' then band
                        else $4 end,
            band_basis = case when band_basis = 'bedrooms' then band_basis
                              when $4::text is null then null
                              else 'occupancy' end,
            updated_at = now()
      where id = $1`,
    [entityId, r.units, capacity, band],
  )
  return { band, basis: band ? 'occupancy' : null, from }
}
