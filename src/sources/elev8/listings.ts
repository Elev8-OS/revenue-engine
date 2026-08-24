/**
 * Elev8 listings as entities — and the reason this became the primary importer.
 *
 * The MDV importer creates one entity per CHANNEL object, deliberately, because
 * it had no key to join the two channels and a guessed join is the worst
 * possible input to a system that moves prices. That was the right call with the
 * information available, and it produces two entities for one apartment.
 *
 * Elev8 is upstream of both. It is the system that drives the channel manager
 * that publishes to the OTAs, so its listing is the apartment and the OTA
 * listings hang off it. Importing Elev8 FIRST and then linking the channels
 * (channels.ts) turns two entities-per-apartment into one, with the join taken
 * from the channel manager's own mapping rather than from name similarity.
 *
 * One measured rule that decides what exists: a row without a `listing_id` is
 * NOT a rentable object. Of 72 rows in the live account, 55 carry one; the other
 * 17 are things like "Apartment Storage". Importing all 72 would put a broom
 * cupboard in a revenue cohort.
 */
import type { PoolClient } from 'pg'
import { normaliseElev8Id, link, lookupAlias, recordUnresolved } from '../../entity/resolve.js'
import { marketFromCountry, marketFromCoordinates, type Market } from '../mdv/objects.js'
import type { Elev8Client } from './client.js'
import { recordShape } from './shape.js'

export interface Elev8ListingRow {
  id?: string
  listing_id?: string
  listing_name?: string
  name?: string
  internal_name?: string
  city?: string
  country?: string
  latitude?: string | number
  longitude?: string | number
  maximum_capacity?: number
  status?: number
  [k: string]: unknown
}

export interface ListingImportReport {
  seen: number
  /** Rows with no listing_id: present in Elev8, not rentable objects. */
  notRentable: number
  created: number
  alreadyKnown: number
  noMarket: number
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
 * Found by a test, not by reading: `marketFromCountry` takes ISO-2 because
 * that is what Booking sends (`country_code: 'ch'`), and Elev8's field holds
 * 'Indonesia', 'Switzerland', 'Germany'. Passing a name to the code matcher
 * returns null for every row, which does not fail — it silently produces a
 * portfolio with no markets, and every finding then reads "not assessable"
 * for a reason that has nothing to do with the data.
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

/**
 * Country first, coordinates second.
 *
 * Not interchangeable: a country is a statement by the source, and coordinates
 * are an inference by us. Where the source says nothing, the three markets are
 * thousands of kilometres apart so the inference is safe — and where the boxes
 * genuinely overlap it returns null rather than tossing a coin.
 */
export function marketOf(row: Elev8ListingRow): Market | null {
  const byCountry = marketFromCountryName(row.country ?? null)
  if (byCountry) return byCountry
  const lat = num(row.latitude)
  const lng = num(row.longitude)
  return lat !== null && lng !== null ? marketFromCoordinates(lat, lng) : null
}

/** The label a human will recognise, with internal_name as the fallback. */
export const labelOf = (row: Elev8ListingRow): string =>
  (row.listing_name ?? row.name ?? row.internal_name ?? '').trim() || 'unnamed listing'

/**
 * The key. Elev8 hands out ids in three shapes (32-hex, dashed UUID, empty), so
 * normalising is what makes them comparable — and an empty id is rejected rather
 * than normalised into something that looks like a key.
 */
export function keyOf(row: Elev8ListingRow): string | null {
  return normaliseElev8Id(row.listing_id) ?? normaliseElev8Id(row.id)
}

export async function importListings(
  db: PoolClient, api: Elev8Client,
): Promise<ListingImportReport> {
  const rows = await api.getAll<Elev8ListingRow>(db, '/api/v1/listing')
  await recordShape(db, 'elev8', 'GET /api/v1/listing', rows)

  const report: ListingImportReport = {
    seen: rows.length, notRentable: 0, created: 0, alreadyKnown: 0, noMarket: 0,
  }

  for (const row of rows) {
    const key = keyOf(row)
    if (!key) {
      // Counted, not recorded as unresolved: this is not a row we failed to
      // place, it is a row that is not an object. Putting it on the "not
      // assessable" list would make the storage cupboard look like a gap.
      report.notRentable++
      continue
    }

    const existing = await lookupAlias(db, { source: 'elev8', kind: 'listing', externalId: key })
    if (existing) { report.alreadyKnown++; continue }

    const market = marketOf(row)
    if (!market) {
      report.noMarket++
      await recordUnresolved(db,
        { source: 'elev8', kind: 'listing', externalId: key, label: labelOf(row) },
        'no country and no coordinates inside a known market box')
      continue
    }

    // maximum_capacity goes in as `sleeps` but sets NO band. It is the fallback
    // basis, and choosing a basis is a decision for the rooms pass — which knows
    // whether the better one is available. Writing a band here would mean the
    // weaker basis won by arriving first.
    const capacity = num(row.maximum_capacity)
    const { rows: created } = await db.query<{ id: string }>(
      `insert into entity (label, market, sleeps) values ($1, $2, $3) returning id`,
      [labelOf(row), market, capacity && capacity > 0 ? capacity : null],
    )
    await link(db, { source: 'elev8', kind: 'listing', externalId: key },
               created[0]!.id, 'explicit')
    report.created++
  }
  return report
}
