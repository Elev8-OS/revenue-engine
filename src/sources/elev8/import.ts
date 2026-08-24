/**
 * The Elev8 pass, in the order the dependencies force.
 *
 *   1. LISTINGS first. Everything else attaches to an entity, so nothing else
 *      can run until the entities exist.
 *   2. BED TYPES once. Reference data; reading it per listing would spend the
 *      whole rate budget re-fetching the same twelve rows fifty-five times.
 *   3. ROOMS per listing. The band, and the reason this pass exists.
 *   4. CHANNELS last. Linking an OTA id to an entity requires the entity, and
 *      the OTA ids are the payoff — one apartment instead of three.
 *
 * Each stage records its own outcome and a failure in a later stage does not
 * discard an earlier one. A pass that imported 55 listings and then failed to
 * read the channels has still done something worth keeping, and reporting it as
 * a single failure would hide that.
 */
import type { PoolClient } from 'pg'
import type { Elev8Client } from './client.js'
import { importListings, type ListingImportReport } from './listings.js'
import { readBedTypes, readRooms, applyReading, applyOccupancyBand } from './rooms.js'
import { readChannels, linkChannel, type LinkReport } from './channels.js'

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
    /** The notes from the FIRST listing, which is where the shape is decided. */
    firstNotes: string[]
  }
  channels: { seen: number, usable: number, links: LinkReport[], ignored: string[] }
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
    fellBackToOccupancy: 0, failed: 0, firstNotes: [] as string[],
  }
  const targets = await elev8Entities(db)
  for (const [i, t] of targets.entries()) {
    rooms.attempted++
    try {
      // Only the first listing's shape is stored. Fifty-five identical shapes
      // say nothing the first did not, and each one is a row somebody has to
      // read past.
      const reading = await readRooms(db, api, t.listingId, beds, { record: i === 0 })
      if (i === 0) rooms.firstNotes = reading.notes
      if (reading.band) {
        await applyReading(db, t.entityId, reading)
        rooms.banded++
        if (reading.sleeps !== null) rooms.withSleeps++
      } else {
        rooms.noRooms++
        // The documented fallback. Capacity bands are a weaker claim about
        // comparability than bedroom bands, which is exactly why the basis is
        // stored beside the band rather than being implied by it.
        if (t.sleeps && t.sleeps > 0) {
          const band = await applyOccupancyBand(db, t.entityId, t.sleeps)
          if (band) rooms.fellBackToOccupancy++
        }
      }
    } catch (err) {
      rooms.failed++
      if (rooms.failed === 1) stageErrors.push(`rooms: ${(err as Error).message}`)
    }
  }

  const channels: Elev8ImportReport['channels'] =
    { seen: 0, usable: 0, links: [], ignored: [] }
  try {
    const found = await readChannels(db, api)
    channels.seen = found.length
    for (const c of found) {
      if (!c.source) { channels.ignored.push(`${c.title || c.channelId}: ${c.note}`); continue }
      channels.usable++
      try {
        channels.links.push(await linkChannel(db, api, { ...c, source: c.source }))
      } catch (err) {
        stageErrors.push(`channel ${c.title}: ${(err as Error).message}`)
      }
    }
  } catch (err) {
    stageErrors.push(`channels: ${(err as Error).message}`)
  }

  return { listings, bedTypes: beds.note, rooms, channels, stageErrors }
}
