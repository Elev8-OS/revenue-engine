/**
 * PriceLabs listings attach to objects; they never create them.
 *
 * That asymmetry is the design and it is worth stating plainly. Elev8 is
 * upstream of the channel manager, so an Elev8 listing IS the apartment and the
 * importer there creates entities. PriceLabs sits beside it as a pricing tool
 * over the same channel manager, so a PriceLabs listing that matches nothing we
 * know is not a new apartment — it is a gap, and it belongs on the
 * "not assessable" list rather than becoming a 63rd object nobody can account
 * for.
 *
 * The join itself is already built and already verified. `resolve()` splits
 * `<channex_property>___<channex_room>` and matches on the ROOM half only,
 * because the property half names a building and "The R Villa Merapi" is one
 * building with two separately-let rooms. Matching on the building would price
 * them as one — a mistake that looks like a match. All this file does is hand
 * each id to that logic and count what came back.
 */
import type { PoolClient } from 'pg'
import { resolve } from '../../entity/resolve.js'
// Imported rather than restated. The band vocabulary ('2BR', '5BR+') has to be
// identical across sources or the cohorts silently split in two, and a second
// copy of the thresholds is exactly how that happens.
import { bandFromRooms } from '../elev8/rooms.js'
import { recordShape } from '../elev8/shape.js'
import { PriceLabsClient, plain, keepSpecimen } from './client.js'

export interface PriceLabsListingRow {
  id?: string
  pms?: string
  name?: string
  latitude?: string | number
  longitude?: string | number
  country?: string
  city_name?: string
  state?: string
  currency?: string
  /** 0 for a studio in the Revenue Estimator's input. Ambiguous here — see below. */
  no_of_bedrooms?: number
  /** What the GUEST is charged. NOT what cleaning costs us. */
  cleaning_fees?: number
  channel_listing_details?: Array<{ channel_name?: string, channel_listing_id?: string }> | null
  min?: number
  base?: number
  max?: number
  group?: string
  group_id?: number
  isHidden?: boolean
  push_enabled?: boolean
  last_refreshed_at?: string
  [k: string]: unknown
}

export interface PriceLabsListingsReport {
  seen: number
  /** Matched to an object we already hold, through the room half. */
  resolved: number
  /** Could not be placed. Each one is recorded with its own reason. */
  unresolved: number
  /** Rows whose `pms` is not 'channex' — the composite-id assumption is theirs. */
  foreignPms: string[]
  hidden: number
  pushEnabled: number
  coordsWritten: number
  coordsRejected: number
  bandsWritten: number
  /** Both sources have a bedroom count and they disagree. Never silently merged. */
  bandDisagreements: Array<{ label: string, elev8: string, pricelabs: string }>
  /** `no_of_bedrooms` absent or zero: unusable, and not assumed to be a studio. */
  bedroomsUnusable: number
  currencies: string[]
  guardrailsSeen: number
  /** Present-but-empty is the failure reading documentation cannot catch. */
  channelDetailsWithId: number
  cleaningFeesSeen: number
}

/** The resolved id set, so the later stages do not re-resolve the same 62 ids. */
export interface ResolvedListing {
  entityId: string
  listingId: string
  pms: string
  label: string
  band: string | null
  currency: string | null
}

/**
 * The provider sends coordinates as strings, so a failed parse arrives as a
 * plausible number rather than as an error. Exact (0, 0) is in the Gulf of
 * Guinea and no apartment in this portfolio is there; it is what two empty
 * strings look like after Number(). Rejected rather than stored, because a
 * coordinate is about to be used to ask "what does the market here earn" and a
 * wrong one answers confidently about the wrong place.
 */
export function coordsOf(row: PriceLabsListingRow): { lat: number, lng: number } | null {
  const lat = plain(row.latitude, { allowNegative: true })
  const lng = plain(row.longitude, { allowNegative: true })
  if (lat === null || lng === null) return null
  if (lat === 0 && lng === 0) return null
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  return { lat, lng }
}

/**
 * The bedroom count, where it is usable.
 *
 * Zero is deliberately NOT read as a studio here, and that is a judgement worth
 * defending. The Revenue Estimator's INPUT documents 0 as studio, so the value
 * exists in the vocabulary — but on the listing OUTPUT there is nothing to
 * distinguish "this is a studio" from "the channel manager never told us", and
 * Channex has no bedroom field at all for it to have come from. One of those
 * belongs in a 'studio' cohort and the other belongs nowhere. Counted and
 * reported rather than resolved by preference.
 */
export function bedroomsOf(row: PriceLabsListingRow): number | null {
  const n = plain(row.no_of_bedrooms)
  return n !== null && n >= 1 ? Math.round(n) : null
}

export async function importPriceLabsListings(
  db: PoolClient, api: PriceLabsClient,
): Promise<{ report: PriceLabsListingsReport, resolved: ResolvedListing[] }> {
  const body = await api.get<{ listings?: PriceLabsListingRow[] }>('/v1/listings')
  const rows = Array.isArray(body?.listings) ? body.listings : []
  await recordShape(db, 'pricelabs', 'GET /v1/listings', rows)
  await keepSpecimen(db, 'GET /v1/listings', null, body)

  const report: PriceLabsListingsReport = {
    seen: rows.length, resolved: 0, unresolved: 0, foreignPms: [],
    hidden: 0, pushEnabled: 0, coordsWritten: 0, coordsRejected: 0,
    bandsWritten: 0, bandDisagreements: [], bedroomsUnusable: 0,
    currencies: [], guardrailsSeen: 0, channelDetailsWithId: 0, cleaningFeesSeen: 0,
  }
  const resolvedRows: ResolvedListing[] = []
  const currencies = new Set<string>()
  const foreign = new Set<string>()

  for (const row of rows) {
    const id = row.id?.trim()
    if (!id) { report.unresolved++; continue }

    if (row.isHidden) report.hidden++
    if (row.push_enabled) report.pushEnabled++
    if (row.currency?.trim()) currencies.add(row.currency.trim().toUpperCase())
    if (plain(row.min) !== null && plain(row.max) !== null) report.guardrailsSeen++
    if (plain(row.cleaning_fees) !== null) report.cleaningFeesSeen++
    for (const ch of row.channel_listing_details ?? []) {
      if (ch?.channel_listing_id?.trim()) report.channelDetailsWithId++
    }

    const pms = (row.pms ?? '').trim().toLowerCase()
    // The room-half join is a fact about Channex ids. A row from another PMS may
    // well use a different id form entirely, so it is named rather than fed
    // through logic that was verified against something else.
    if (pms && pms !== 'channex') foreign.add(pms)

    const hit = await resolve(db, { source: 'pricelabs', kind: 'listing', externalId: id,
                                    label: row.name?.trim() })
    if (!hit.ok) { report.unresolved++; continue }
    report.resolved++

    const coords = coordsOf(row)
    if (coords) {
      // Written only where it changes something, so an unchanged pass does not
      // bump updated_at on 62 rows and make every object look freshly touched.
      const { rowCount } = await db.query(
        `update entity set latitude = $2, longitude = $3, updated_at = now()
          where id = $1 and (latitude is distinct from $2::numeric
                             or longitude is distinct from $3::numeric)`,
        [hit.entityId, coords.lat, coords.lng])
      if (rowCount) report.coordsWritten++
    } else if (row.latitude !== undefined || row.longitude !== undefined) {
      report.coordsRejected++
    }

    const bedrooms = bedroomsOf(row)
    const band = bandFromRooms(bedrooms)
    if (!bedrooms) report.bedroomsUnusable++

    const current = await db.query<{ label: string, band: string | null, basis: string | null }>(
      `select label, band, band_basis as basis from entity where id = $1`, [hit.entityId])
    const held = current.rows[0]

    if (band && held) {
      if (!held.band) {
        // Basis 'bedrooms' because that is what it measures. The same basis
        // Elev8's room pass writes, which is the point: two sources counting the
        // same thing must land in one cohort, not two.
        await db.query(
          `update entity set band = $2, band_basis = 'bedrooms', updated_at = now()
            where id = $1`, [hit.entityId, band])
        report.bandsWritten++
      } else if (held.band !== band && held.basis === 'bedrooms') {
        // Two sources counting bedrooms and arriving at different numbers is a
        // real disagreement about the object. Overwriting either way would pick
        // a winner by import order; the held value stays and the conflict is
        // reported so a human decides once.
        report.bandDisagreements.push(
          { label: held.label, elev8: held.band, pricelabs: band })
      }
    }

    resolvedRows.push({
      entityId: hit.entityId, listingId: id, pms: pms || 'channex',
      label: row.name?.trim() || held?.label || 'unnamed listing',
      band: held?.band ?? band, currency: row.currency?.trim()?.toUpperCase() ?? null,
    })
  }

  report.currencies = [...currencies].sort()
  report.foreignPms = [...foreign].sort()
  return { report, resolved: resolvedRows }
}
