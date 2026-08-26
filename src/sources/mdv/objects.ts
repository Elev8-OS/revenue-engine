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
import type { FunnelReport } from './funnel.js'
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
  /**
   * Channel objects newly ATTACHED to an object we already hold. Not created —
   * see `attach()`. Named `*Attached` rather than `*Created` because the old name
   * described what this importer used to do and would have gone on reading as if
   * it still did.
   */
  bookingAttached: number
  airbnbSeen: number
  airbnbAttached: number
  /** Already linked from a previous run; no detail call was made for these. */
  alreadyKnown: number
  /** Channel objects that match nothing we hold. Reported, never invented. */
  unresolved: number
  /**
   * Matched under the OTHER alias kind — Elev8 records an OTA id as a 'listing',
   * MDV addresses a Booking object as a 'property'. Counted separately because
   * it is the join that stops this importer duplicating the portfolio, and a
   * silent zero here would be the first sign that it broke.
   */
  crossKind: number
  freshnessRows: number
  /**
   * The funnel pass that ran alongside, when it ran. Nested rather than merged so
   * the narrowing in `import/run.ts` keeps working: the MDV report is identified
   * by being none of the tagged shapes, and a `kind` at the top level here would
   * make it collide with the funnel report's own tag.
   */
  funnel?: FunnelReport
  /** Why it did not run. Separate permissions, so this is an ordinary outcome. */
  funnelError?: string
}

const empty = (): ImportReport => ({
  bookingSeen: 0, bookingAttached: 0, airbnbSeen: 0, airbnbAttached: 0,
  alreadyKnown: 0, unresolved: 0, crossKind: 0, freshnessRows: 0,
})

/**
 * Finds the entity a channel object belongs to. NEVER creates one.
 *
 * This importer used to create an entity per channel object, deliberately,
 * because there was no key to join the two channels and a guessed join is the
 * worst possible input to a system that moves prices. That was right with the
 * information available. It is wrong now: Elev8 sits upstream of the channel
 * manager and its `ota_channels[]` carries each OTA's own listing id, so the
 * join is the channel manager's own mapping rather than a guess.
 *
 * Left as it was, a first MDV pass would have added roughly 58 Booking
 * properties and 50 Airbnb listings NEXT TO the 57 objects Elev8 had already
 * placed — the same apartment two or three times, diluted cohort bands, and a
 * "not assessable" count nobody could trust again.
 *
 * So the same rule PriceLabs already follows: attach, never invent. A channel
 * object that matches nothing is a gap to report, with its id and label intact
 * on the unresolved list, and can be promoted deliberately later.
 *
 * THE CROSS-KIND LOOKUP is the part that makes it work at all. Elev8 writes
 * `(mdv_booking, listing, ota_id)`; MDV addresses the same object as
 * `(mdv_booking, property, property_id)`. Looking up only our own kind would
 * match nothing for Booking by construction — which is exactly the defect this
 * function exists to close, so both kinds are tried and the tuple we were asked
 * about is then linked too, so the next run is a direct hit.
 */
async function attach(
  client: PoolClient,
  input: { source: 'mdv_booking' | 'mdv_airbnb', kind: 'property' | 'listing',
           externalId: string, label?: string },
  report: ImportReport,
): Promise<{ entityId: string, direct: boolean } | null> {
  // `direct` means "this importer had already linked it, so nothing to do".
  // It is NOT the same as "an alias exists" — see below.
  const direct = await lookupAlias(client, input)
  if (direct) {
    /**
     * "Already known" and "the join worked" are different facts, and a direct
     * hit can be either. An alias this importer wrote on an earlier run means
     * nothing happened; one Elev8 wrote means this channel object is entering
     * the portfolio for the first time, through the channel manager's own
     * mapping. Collapsing them would make the Airbnb join invisible — it would
     * look exactly like a no-op second pass, and there would be no number
     * anywhere saying whether it worked at all.
     */
    const ours = direct.matchedBy.startsWith('mdv_')
      || direct.matchedBy === 'ota_id_crosskind'
      || direct.matchedBy.endsWith('+mdv_confirmed')
    if (!ours) {
      /**
       * The tuple is already exactly the one MDV addresses, so there is no new
       * alias to write — and without recording anything, this run would classify
       * it as a first attachment again tomorrow, and spend a detail call doing
       * it. So the confirmation is appended to `matched_by` rather than
       * replacing it: the origin of the link is the channel manager's own
       * mapping and that provenance is the most valuable thing about it, but
       * "MDV has since attached to it" is worth recording too.
       */
      await client.query(
        `update entity_alias set matched_by = matched_by || '+mdv_confirmed'
          where source = $1 and kind = $2::alias_kind and external_id = $3`,
        [input.source, input.kind, input.externalId])
    }
    return { entityId: direct.entityId, direct: ours }
  }

  for (const kind of ['listing', 'property', 'room'] as const) {
    if (kind === input.kind) continue
    const other = await lookupAlias(client, { ...input, kind })
    if (!other) continue
    // Record the tuple MDV actually uses, so the next pass is a direct hit and
    // the cross-kind path stays a one-off per object rather than a permanent
    // detour.
    await link(client, input, other.entityId, 'ota_id_crosskind')
    report.crossKind++
    return { entityId: other.entityId, direct: false }
  }
  return null
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
    const hit = await attach(client, input, report)
    if (!hit) {
      // Named, not invented. The label travels with it so the unresolved list is
      // readable by a human deciding whether this is a retired listing, a
      // misconfiguration, or an object Elev8 genuinely does not know.
      await recordUnresolved(client, input,
        `no Elev8 listing carries this Booking id, and Elev8 is the authority for `
        + `what exists; nothing was created`)
      report.unresolved++
      continue
    }
    if (hit.direct) report.alreadyKnown++
    else report.bookingAttached++
    const entityId = hit.entityId

    /**
     * The detail call is no longer optional for a known object, and that is a
     * deliberate reversal.
     *
     * It used to be skipped for anything already linked, to save a request. That
     * made sense when the call existed to decide a market and create an entity —
     * facts that do not change. It stopped making sense the moment this importer
     * stopped creating: the ONLY thing the detail response still gives us is the
     * provider's own per-dataset freshness, and freshness that is written once
     * and never again is not freshness. The first live pass proved it —
     * `freshnessRows: 0` on 78 matched objects — which is exactly the state that
     * makes the staleness gate decorative.
     */
    const detail = await mdv.get<BookingDetail>(
      client, `/booking/properties/${p.property_id}/`)
    // It may have been undecidable on an earlier run; it is placed now.
    await clearUnresolved(client, input)

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
      const hit = await attach(client, input, report)
      if (!hit) {
        await recordUnresolved(client, input,
          `no Elev8 listing carries this Airbnb id, and Elev8 is the authority for `
          + `what exists; nothing was created`)
        report.unresolved++
        continue
      }
      if (hit.direct) report.alreadyKnown++
      else report.airbnbAttached++
      const entityId = hit.entityId

      // Same reversal as the Booking side: the detail call now exists for the
      // freshness stamp, so skipping it for a known object would leave the
      // staleness gate reading a number from whenever the object first appeared.
      const detail = await mdv.get<AirbnbDetail>(
        client, `/airbnb/listings/${encodeURIComponent(l.listing_id)}/`)
      await clearUnresolved(client, input)
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
