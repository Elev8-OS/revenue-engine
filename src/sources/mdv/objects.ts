/**
 * The object import: MDV's two channels into `entity` + `entity_alias`.
 *
 * ONE DELIBERATE OMISSION. This does not try to work out that a Booking property
 * and an Airbnb listing are the same villa. It could guess — both channels
 * expose coordinates, and coordinates plus a name comparison would be right most
 * of the time. But Elev8 is the PMS and holds that mapping authoritatively, and a
 * guess that is right most of the time is the worst kind of input to a system
 * that moves prices: nobody would know which rows were guessed. So each channel
 * imports as its own entity, and Elev8 merges them later.
 *
 * What IS derived here is the market, and only because it is a different kind of
 * inference. Booking states `country_code` outright. Airbnb does not, but the
 * three markets are thousands of kilometres apart, so a coordinate falls in
 * exactly one of them or in none — and "none" is recorded as unresolved rather
 * than rounded to the nearest guess.
 *
 * Re-running is safe and cheap: an existing alias short-circuits before any
 * detail call, so a second pass costs two list requests and nothing else.
 */
import type { PoolClient } from 'pg'
import type { MdvClient } from './client.js'
import { lookupAlias, link, recordUnresolved, clearUnresolved }
  from '../../entity/resolve.js'
import { recordFreshness } from '../../snapshot/write.js'

/* ------------------------------------------------------- the documented shapes */

export interface BookingProperty {
  property_id: number
  name?: string | null
  city?: string | null
  status: string
  tags?: unknown[]
  commission_pct?: number | null
  data_as_of?: string | null
}
export interface BookingPropertyList {
  properties: BookingProperty[]
  data_as_of?: string | null
}
export interface BookingDetail {
  property_id: number
  name?: string | null
  latitude?: number | null
  longitude?: number | null
  country_code?: string | null
  currency?: string | null
  data_as_of?: string | null
  /** Per-dataset observation times. The whole reason dataset_freshness exists. */
  sync_state?: { metrics?: Record<string, string | null> } | null
}
export interface AirbnbListing {
  listing_id: string
  nickname?: string | null
  listing_title?: string | null
  title?: string | null
  active?: boolean | null
  data_as_of?: string | null
}
export interface AirbnbListingList {
  count: number
  limit?: number
  offset?: number
  results: AirbnbListing[]
  data_as_of?: string | null
}
export interface AirbnbDetail {
  listing_id: string
  lat?: number | null
  lng?: number | null
  currency?: string | null
  data_as_of?: string | null
}

/* -------------------------------------------------------------------- market */

export type Market = 'ch' | 'at' | 'bali'

/** Booking says it outright. `id` is Indonesia, which for us means Bali. */
export function marketFromCountry(code: string | null | undefined): Market | null {
  switch ((code ?? '').trim().toLowerCase()) {
    case 'ch': return 'ch'
    case 'at': return 'at'
    case 'id': return 'bali'
    default: return null
  }
}

/**
 * Bounding boxes, one per market.
 *
 * Switzerland and Austria genuinely overlap around Vorarlberg, so a point inside
 * both boxes returns null rather than picking one. Our Austrian properties sit
 * near longitude 14 and the Swiss ones below 10, so the strip is empty in
 * practice — but a box that quietly resolves ties is a box that will one day put
 * a property in the wrong market and the wrong minimum-wage basis with it.
 */
const BOXES: Array<{ market: Market, latMin: number, latMax: number, lngMin: number, lngMax: number }> = [
  { market: 'bali', latMin: -9.3, latMax: -8.0, lngMin: 114.3, lngMax: 115.9 },
  { market: 'ch', latMin: 45.80, latMax: 47.81, lngMin: 5.95, lngMax: 10.50 },
  { market: 'at', latMin: 46.35, latMax: 49.03, lngMin: 9.53, lngMax: 17.17 },
]

export function marketFromCoordinates(
  lat: number | null | undefined, lng: number | null | undefined,
): Market | null {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null
  const hits = BOXES.filter(b =>
    lat >= b.latMin && lat <= b.latMax && lng >= b.lngMin && lng <= b.lngMax)
  return hits.length === 1 ? hits[0]!.market : null
}

/* -------------------------------------------------------------------- import */

export interface ImportReport {
  bookingSeen: number
  bookingCreated: number
  airbnbSeen: number
  airbnbCreated: number
  /** Already known from a previous run; no detail call was made for these. */
  alreadyKnown: number
  unresolved: number
  freshnessRows: number
}

const empty = (): ImportReport => ({
  bookingSeen: 0, bookingCreated: 0, airbnbSeen: 0, airbnbCreated: 0,
  alreadyKnown: 0, unresolved: 0, freshnessRows: 0,
})

async function createEntity(
  client: PoolClient, label: string, market: Market, active: boolean,
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `insert into entity (label, market, active) values ($1, $2::market, $3) returning id`,
    [label, market, active],
  )
  return rows[0]!.id
}

/** The Booking side: an id, a stated country, and per-dataset freshness. */
async function importBooking(
  client: PoolClient, mdv: MdvClient, report: ImportReport,
): Promise<void> {
  // No parameters on this endpoint — it returns the whole account in one call.
  const list = await mdv.get<BookingPropertyList>(client, '/booking/properties/')
  for (const p of list.properties ?? []) {
    report.bookingSeen++
    const input = {
      source: 'mdv_booking' as const, kind: 'property' as const,
      externalId: String(p.property_id), label: p.name ?? undefined,
    }
    // A pure lookup, not `resolve`: a miss here is a NEW object, not a failure,
    // and recording it as unresolved would put a successfully imported row on
    // the "not assessable" list.
    if (await lookupAlias(client, input)) { report.alreadyKnown++; continue }

    const detail = await mdv.get<BookingDetail>(
      client, `/booking/properties/${p.property_id}/`)
    const market = marketFromCountry(detail.country_code)
      ?? marketFromCoordinates(detail.latitude, detail.longitude)
    if (!market) {
      await recordUnresolved(client, input,
        `no market: country_code=${detail.country_code ?? 'null'}, `
        + `coords=${detail.latitude ?? 'null'},${detail.longitude ?? 'null'}`)
      report.unresolved++
      continue
    }

    const label = p.name ?? detail.name ?? `booking:${p.property_id}`
    // `status` from the list is the OTA's own view. 'removed' rows are imported
    // as inactive rather than dropped, so a delisting is visible instead of
    // looking like a row that never existed.
    const entityId = await createEntity(client, label, market, p.status === 'active')
    await link(client, input, entityId, 'mdv_property_id')
    // It may have been undecidable on an earlier run; it is placed now.
    await clearUnresolved(client, input)
    report.bookingCreated++

    // One row per dataset, because the account's datasets age at different
    // rates and a single "last synced" would hide the spread.
    for (const [dataset, at] of Object.entries(detail.sync_state?.metrics ?? {})) {
      await recordFreshness(client, 'mdv_booking', dataset, entityId, at ?? null,
                            at ? 'ok' : 'unknown')
      report.freshnessRows++
    }
  }
}

/** The Airbnb side: paginated, no country, coordinates only. */
async function importAirbnb(
  client: PoolClient, mdv: MdvClient, report: ImportReport, pageSize: number,
): Promise<void> {
  let offset = 0
  for (;;) {
    const page = await mdv.get<AirbnbListingList>(
      client, '/airbnb/listings/', { limit: pageSize, offset })
    const results = page.results ?? []
    for (const l of results) {
      report.airbnbSeen++
      // listing_title is the human name; nickname carries a numeric PMS prefix.
      const label = l.listing_title ?? l.title ?? l.nickname ?? `airbnb:${l.listing_id}`
      const input = {
        source: 'mdv_airbnb' as const, kind: 'listing' as const,
        externalId: l.listing_id, label,
      }
      if (await lookupAlias(client, input)) { report.alreadyKnown++; continue }

      const detail = await mdv.get<AirbnbDetail>(
        client, `/airbnb/listings/${encodeURIComponent(l.listing_id)}/`)
      const market = marketFromCoordinates(detail.lat, detail.lng)
      if (!market) {
        await recordUnresolved(client, input,
          `no market from coordinates: ${detail.lat ?? 'null'},${detail.lng ?? 'null'}`)
        report.unresolved++
        continue
      }
      const entityId = await createEntity(client, label, market, l.active !== false)
      await link(client, input, entityId, 'mdv_listing_id')
      await clearUnresolved(client, input)
      report.airbnbCreated++
      await recordFreshness(client, 'mdv_airbnb', 'listing_core', entityId,
                            detail.data_as_of ?? null,
                            detail.data_as_of ? 'ok' : 'unknown')
      report.freshnessRows++
    }
    offset += results.length
    // Trust `count` over an empty page, but stop on either: a provider that
    // keeps returning rows past its own count would otherwise loop.
    if (!results.length || offset >= (page.count ?? offset)) break
  }
}

/**
 * Imports both channels. Nothing here writes a bedroom band: MDV documents the
 * field but leaves it empty on this account, and a cohort needs five members to
 * mean anything. Until Elev8 supplies it, every finding correctly reads
 * "not assessable" — which is the designed behaviour, not a gap.
 */
export async function importObjects(
  client: PoolClient, mdv: MdvClient, opts: { pageSize?: number } = {},
): Promise<ImportReport> {
  const report = empty()
  await importBooking(client, mdv, report)
  await importAirbnb(client, mdv, report, opts.pageSize ?? 100)
  return report
}
