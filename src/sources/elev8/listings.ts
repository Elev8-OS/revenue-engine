/**
 * Elev8 listings as entities — and the reason this became the primary importer.
 *
 * The MDV importer creates one entity per CHANNEL object, deliberately, because
 * it had no key to join the two channels and a guessed join is the worst
 * possible input to a system that moves prices. That was the right call with the
 * information available, and it produces two entities for one apartment.
 *
 * Elev8 is upstream of both. It drives the channel manager that publishes to the
 * OTAs, so its listing is the apartment and the OTA listings hang off it —
 * literally: `ota_channels[]` on this very payload carries each OTA's own id.
 * One call gives the objects, the PMS ids and the OTA ids together.
 */
import type { PoolClient } from 'pg'
import { normaliseElev8Id, link, lookupAlias, recordUnresolved } from '../../entity/resolve.js'
import { marketFromCountry, marketFromCoordinates, type Market } from '../mdv/objects.js'
import type { Elev8Client } from './client.js'
import { recordShape } from './shape.js'
import { linkOtaChannels, type OtaChannel, type OtaLinkCounts } from './channels.js'

export interface Elev8ListingRow {
  id?: string
  /**
   * The PMS/Channex listing id, and the field that decides what exists.
   * Filled on 65 of 82 rows in the live account — see `isRentable`.
   */
  pms_listing_id?: string
  pms_room_id?: string
  pms_unit_id?: string
  title?: string
  room_title?: string
  internal_name?: string
  city?: string
  country?: string
  latitude?: number | string
  longitude?: number | string
  maximum_capacity?: number
  is_parent?: boolean
  unit_count?: number
  parent_listing_id?: string
  status?: number
  ota_channels?: OtaChannel[] | null
  [k: string]: unknown
}

export interface ListingImportReport {
  seen: number
  /** Rows with no pms_listing_id: present in Elev8, not rentable objects. */
  notRentable: number
  created: number
  alreadyKnown: number
  noMarket: number
  /** Container listings among those imported — their units are separate rows. */
  parents: number
  /** Room ids already claimed by another object. Never silent. */
  roomIdConflicts: number
  ota: OtaLinkCounts
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

/**
 * Elev8 names countries; MDV codes them.
 *
 * Found by a test, not by reading: `marketFromCountry` takes ISO-2 because that
 * is what Booking sends (`country_code: 'ch'`), and Elev8's field holds
 * 'Indonesia', 'Switzerland', 'Germany'. Passing a name to the code matcher
 * returns null for every row, which does not fail — it silently produces a
 * portfolio with no markets, and every finding then reads "not assessable" for a
 * reason that has nothing to do with the data.
 *
 * Localised spellings are included because the field is free text written by
 * whoever set the listing up, and a Swiss operator writing 'Schweiz' is not an
 * exotic case. A country outside our three markets — Germany, for one — is
 * correctly null: it is a real place and not a market we model.
 */
const COUNTRY_NAMES: Record<string, Market> = {
  switzerland: 'ch', schweiz: 'ch', suisse: 'ch', svizzera: 'ch',
  austria: 'at', 'österreich': 'at', oesterreich: 'at',
  indonesia: 'bali', indonesien: 'bali',
}

export function marketFromCountryName(name: string | null | undefined): Market | null {
  const key = (name ?? '').trim().toLowerCase()
  if (!key) return null
  // A two-letter value in this field is a code, not a name. Both spellings of
  // the same fact should reach the same answer.
  if (key.length === 2) return marketFromCountry(key)
  return COUNTRY_NAMES[key] ?? null
}

export function marketOf(row: Elev8ListingRow): Market | null {
  const byCountry = marketFromCountryName(row.country ?? null)
  if (byCountry) return byCountry
  const lat = num(row.latitude)
  const lng = num(row.longitude)
  return lat !== null && lng !== null ? marketFromCoordinates(lat, lng) : null
}

/** The label a human will recognise. */
export const labelOf = (row: Elev8ListingRow): string =>
  (row.title ?? row.room_title ?? row.internal_name ?? '').trim() || 'unnamed listing'

/**
 * Is this row a rentable object at all?
 *
 * MEASURED, and it corrects a bug that shipped. `pms_listing_id` is filled on
 * 65 of 82 rows; `id` is filled on 82 of 82. The first version of this test read
 * `pms_listing_id ?? id`, so it never rejected anything, and a storage cupboard,
 * an office and a building-level collective entry went into a revenue cohort.
 *
 * The distinction is not a naming guess. Without a PMS listing id the object is
 * published on no channel, cannot be booked, and therefore cannot have revenue
 * or an occupancy — there is nothing for this system to assess about it. The
 * seventeen without one are real rows in Elev8; they are just not lettings.
 */
export const isRentable = (row: Elev8ListingRow): boolean =>
  Boolean(row.pms_listing_id && row.pms_listing_id.trim())

/** Our own key. Elev8 hands out ids in three shapes; normalising makes them comparable. */
export function keyOf(row: Elev8ListingRow): string | null {
  return normaliseElev8Id(row.id)
}

export async function importListings(
  db: PoolClient, api: Elev8Client,
): Promise<ListingImportReport> {
  const rows = await api.getAll<Elev8ListingRow>(db, '/api/v1/listing')
  await recordShape(db, 'elev8', 'GET /api/v1/listing', rows)

  const report: ListingImportReport = {
    seen: rows.length, notRentable: 0, created: 0, alreadyKnown: 0, noMarket: 0,
    parents: 0, roomIdConflicts: 0,
    ota: { linked: 0, alreadyLinked: 0, unknownChannel: [], noOtaId: 0 },
  }

  for (const row of rows) {
    if (!isRentable(row)) {
      // Counted, not recorded as unresolved: this is not a row we failed to
      // place, it is a row that is not an object. Putting it on the "not
      // assessable" list would make the storage cupboard look like a gap.
      report.notRentable++
      continue
    }
    const key = keyOf(row)
    if (!key) {
      report.notRentable++
      continue
    }

    const known = await lookupAlias(db, { source: 'elev8', kind: 'listing', externalId: key })
    let entityId = known?.entityId

    if (!entityId) {
      const market = marketOf(row)
      if (!market) {
        report.noMarket++
        await recordUnresolved(db,
          { source: 'elev8', kind: 'listing', externalId: key, label: labelOf(row) },
          'no country and no coordinates inside a known market box')
        continue
      }
      // maximum_capacity goes in as `sleeps` but sets NO band. It is the
      // fallback basis, and choosing a basis is the rooms pass's decision —
      // which knows whether the better one is available. Writing a band here
      // would mean the weaker basis won by arriving first.
      //
      // In the REST payload this field is filled on 82 of 82. The 55-of-72 I
      // recorded earlier came from the curated MCP view and does not apply here.
      const capacity = num(row.maximum_capacity)
      const { rows: created } = await db.query<{ id: string }>(
        `insert into entity (label, market, sleeps) values ($1, $2, $3) returning id`,
        [labelOf(row), market, capacity && capacity > 0 ? capacity : null],
      )
      entityId = created[0]!.id
      await link(db, { source: 'elev8', kind: 'listing', externalId: key }, entityId, 'explicit')
      report.created++
    } else {
      report.alreadyKnown++
    }

    if (row.is_parent) report.parents++

    /**
     * The two PMS ids go to two different places, and the distinction was a bug
     * before it was a design.
     *
     *   pms_room_id      one room is one unit → a KEY. Aliased under 'channex',
     *                    because that is whose namespace it is, and because
     *                    PriceLabs identifies a listing as
     *                    `<channex_property>___<channex_room>`. Recording it
     *                    here is what makes the PriceLabs join resolve later,
     *                    through resolution code that already exists.
     *   pms_listing_id   one property, MANY units → an ATTRIBUTE. In the live
     *                    account "The R Villa Merapi" is one Channex property
     *                    with two rooms. As an alias it recorded whichever unit
     *                    was imported first and dropped the rest silently;
     *                    as a column it is the multi-unit structure made
     *                    explicit — units in one building share this value.
     */
    const property = row.pms_listing_id?.trim()
    if (property) {
      await db.query(
        `update entity set pms_property_id = $2, updated_at = now()
          where id = $1 and coalesce(pms_property_id, '') <> $2`,
        [entityId, property])
    }
    const roomId = row.pms_room_id?.trim()
    if (roomId) {
      const outcome = await link(db, { source: 'channex', kind: 'room', externalId: roomId },
                                 entityId, 'elev8_pms_field')
      // A room id claimed by another object is reported by link() itself. Count
      // it here too, so a pass that hit one is legible in the report rather than
      // only in a table somebody has to go and read.
      if (outcome === 'conflict') report.roomIdConflicts++
    }

    await linkOtaChannels(db, entityId, row.ota_channels, report.ota)
  }
  return report
}
