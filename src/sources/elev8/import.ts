/**
 * The Elev8 pass, in the order the dependencies force.
 *
 *   1. LISTINGS first, and they now carry more than the objects: the PMS ids and
 *      the OTA ids come in the same response, so the linking that used to need
 *      61 extra calls happens inside this one stage.
 *   2. BED TYPES once. Reference data; reading it per listing would spend the
 *      whole rate budget re-fetching the same handful of rows.
 *   3. ROOMS per listing. The band, and the reason this pass exists.
 *
 * Each stage records its own outcome and a failure in a later stage does not
 * discard an earlier one. A pass that imported 65 listings and then failed to
 * read the bed types has still done something worth keeping, and reporting it as
 * a single failure would hide that.
 */
import type { PoolClient } from 'pg'
import type { Elev8Client } from './client.js'
import { importListings, type ListingImportReport } from './listings.js'
import { readBedTypes, readRooms, applyReading } from './rooms.js'
import { recordShape } from './shape.js'

export interface Elev8ImportReport {
  listings: ListingImportReport
  bedTypes: string
  rooms: {
    attempted: number
    banded: number
    /** Rooms empty for this listing: the feature is unused, not a studio. */
    noRooms: number
    withSleeps: number
    /** Where the room list was empty and maximum_capacity carried the band. */
    fellBackToOccupancy: number
    failed: number
    /** The notes from the first listing that actually HAD rooms. */
    firstNotes: string[]
  }
  /** Named so a partial pass is legible rather than looking like a success. */
  stageErrors: string[]
}

/** Entities that have an Elev8 listing alias — the ones a rooms call can name. */
async function elev8Entities(
  db: PoolClient,
): Promise<{ entityId: string, listingId: string, sleeps: number | null }[]> {
  const { rows } = await db.query<{ entity_id: string, external_id: string, sleeps: number | null }>(
    `select a.entity_id, a.external_id, e.sleeps
       from entity_alias a join entity e on e.id = a.entity_id
      where a.source = 'elev8' and a.kind = 'listing' and e.active
      order by a.external_id`)
  return rows.map(r => ({ entityId: r.entity_id, listingId: r.external_id, sleeps: r.sleeps }))
}

export async function importElev8(
  db: PoolClient, api: Elev8Client,
): Promise<Elev8ImportReport> {
  const stageErrors: string[] = []

  const listings = await importListings(db, api)

  let beds = { byId: new Map<string, number>(), field: null as string | null, note: 'not read' }
  try {
    beds = await readBedTypes(db, api)
  } catch (err) {
    stageErrors.push(`bed types: ${(err as Error).message}`)
  }

  const rooms = {
    attempted: 0, banded: 0, noRooms: 0, withSleeps: 0,
    /** Banded from Elev8's stated maximum rather than from a summed bed list. */
    fellBackToOccupancy: 0,
    /** Held a bedroom band already, so this pass left the band alone. */
    keptBedroomBand: 0,
    failed: 0, firstNotes: [] as string[],
  }

  /**
   * Every room from every listing, so the recorded shape is derived from the
   * whole portfolio rather than from one object.
   *
   * The previous version recorded only the FIRST listing's shape, reasoning that
   * identical structures add nothing. That reasoning holds for the structure and
   * fails for the FILL COUNTS — which are the entire point of recording shapes.
   * The first listing happened to have no rooms, so the table read
   * "0 samples, 0 paths" while the dashboard showed 2BR and 3BR bands from
   * listings further down. At n = 1, "empty" and "never populated" are the same
   * observation, which is precisely the distinction this is here to make.
   */
  const allRooms: unknown[] = []

  const targets = await elev8Entities(db)
  for (const t of targets) {
    rooms.attempted++
    try {
      const reading = await readRooms(db, api, t.listingId, beds, { collect: allRooms })
      // The first listing that HAS units is the informative one; the notes from
      // an empty list say only that it was empty.
      if (!rooms.firstNotes.length && reading.units) rooms.firstNotes = reading.notes
      if (reading.units === null) rooms.noRooms++
      // One write, whether or not there were units: `sleeps` from Elev8's stated
      // maximum is worth storing on a listing whose room feature is unused, and
      // the band is ranked inside applyReading so an occupancy band can never
      // overwrite a bedroom one.
      const applied = await applyReading(db, t.entityId, reading, t.sleeps)
      if (applied.band) {
        rooms.banded++
        if (applied.from === 'bed configuration') rooms.withSleeps++
        else rooms.fellBackToOccupancy++
      }
    } catch (err) {
      rooms.failed++
      if (rooms.failed === 1) stageErrors.push(`rooms: ${(err as Error).message}`)
    }
  }

  // One shape row per pass, from every room seen. Written even when the total is
  // zero: "82 listings, 0 rooms" is a finding, and an absent row would read as
  // "not measured yet".
  if (rooms.attempted) {
    try {
      await recordShape(db, 'elev8', 'GET /api/v1/listing/:id/room', allRooms,
        `aggregated over ${rooms.attempted} listing(s); ${rooms.noRooms} had no units`)
    } catch (err) {
      stageErrors.push(`room shape: ${(err as Error).message}`)
    }
  }

  return { listings, bedTypes: beds.note, rooms, stageErrors }
}
