/**
 * Rooms and beds from Elev8, turned into the cohort band.
 *
 * This is the field the whole diagnosis waited on. Without a band there is no
 * cohort, without a cohort there is no comparison, and every finding reads
 * "not assessable" — which is correct behaviour and useless output.
 *
 * MDV cannot supply it: Airbnb `bedrooms` is null on all 50 listings and Booking
 * carries no room count. Channex carries occupancy, not rooms. Elev8 carries the
 * room LIST, each room with its bed configuration — which is strictly more than
 * a number, because it yields the count and the capacity from one read.
 *
 * Two decisions in here matter more than the code:
 *
 *   THE ROOM COUNT IS THE ARRAY LENGTH, not a field. No field name to guess, no
 *   name to be renamed under us. `data.length` is the most robust extraction
 *   available and it happens to be the one that answers the question.
 *
 *   AN EMPTY ROOM LIST IS NOT A STUDIO. Zero rooms means the feature is unused
 *   for that listing, and banding it as `0BR` would manufacture a cohort out of
 *   absent data — exactly the failure this project keeps finding in other
 *   people's fields. Empty yields null, and null surfaces as "not assessable".
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
  /** Count of rooms, or null when the list came back empty. */
  rooms: number | null
  /** Bed capacity, or null when the bed types carry no number to add up. */
  sleeps: number | null
  band: string | null
  basis: BandBasis | null
  /** Why sleeps is null, or which paths were used. Auditable, not folklore. */
  notes: string[]
}

/**
 * Bands from a room count.
 *
 * `5BR+` collapses the tail on purpose: a cohort of one six-bedroom villa
 * compared against itself is not a comparison, and the whole point of the band
 * is to produce a group big enough to say something about.
 */
export function bandFromRooms(rooms: number | null): string | null {
  if (rooms === null || rooms < 1) return null
  return rooms >= 5 ? '5BR+' : `${rooms}BR`
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
    return { rooms: null, sleeps: null, band: null, basis: null, notes }
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

  return {
    rooms: rooms.length,
    sleeps,
    band: bandFromRooms(rooms.length),
    basis: 'bedrooms',
    notes,
  }
}

/**
 * Applies a reading to an entity.
 *
 * Writes the measured inputs alongside the band on purpose. Storing only "2BR"
 * throws away the evidence: it cannot be re-derived, cannot be audited, and when
 * the banding rule changes there is nothing left to re-run it over.
 */
export async function applyReading(
  db: PoolClient, entityId: string, r: RoomsReading,
): Promise<void> {
  await db.query(
    `update entity
        set rooms = $2, sleeps = $3, band = $4, band_basis = $5, updated_at = now()
      where id = $1`,
    [entityId, r.rooms, r.sleeps, r.band, r.band ? r.basis : null],
  )
}

/** The occupancy fallback, for when the room feature turns out to be unused. */
export async function applyOccupancyBand(
  db: PoolClient, entityId: string, capacity: number | null,
): Promise<string | null> {
  const band = bandFromSleeps(capacity)
  await db.query(
    `update entity
        set sleeps = $2, band = $3, band_basis = $4, updated_at = now()
      where id = $1`,
    [entityId, capacity && capacity > 0 ? capacity : null, band, band ? 'occupancy' : null],
  )
  return band
}
