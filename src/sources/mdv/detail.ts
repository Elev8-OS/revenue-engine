/**
 * Everything the two endpoints we ALREADY call were carrying and nobody read.
 *
 * `/booking/properties/` and `/airbnb/listings/` have been fetched on every
 * object import since the beginning. The object importer took an id, a name and a
 * status from each and dropped the rest. The shape export shows what the rest is:
 *
 *   · the whole take-rate stack per object — `commission_pct`,
 *     `guest_target_pct`, `pms_markup_pct`;
 *   · the entire Airbnb funnel per listing, under `chart_metrics` — search views,
 *     property views, booking conversions, the two conversion rates, occupancy,
 *     cancellation rate, booking window, AND `adr_booked_comps`, which is the
 *     competitor ADR we went looking for a compset endpoint to find;
 *   · every Airbnb promotion per listing with its factor and its window;
 *   · `eligible_promotions[]` — levers the channel would let us run and we do
 *     not, which is a different fact from "off" and the cheapest action list on
 *     the account;
 *   · the three programme switches (`mobile_only`, `loyalty_data`,
 *     `new_listing_promotion`), each with eligible / enabled / percentage;
 *   · `rating_average` and `review_count`, which we were fetching from a second
 *     endpoint.
 *
 * NO NEW HTTP. This reads fields off responses the service already pays for,
 * which is why it is the best value on the whole remaining list — and why it
 * being unread for a month is the least excusable gap in the project.
 */
import type { PoolClient } from 'pg'
import { MdvError, type MdvClient } from './client.js'
import { rowsOf } from './discover.js'
import { recordShape } from '../elev8/shape.js'
import { lookupAlias } from '../../entity/resolve.js'
import { resolveFields, countOf, type FieldSpec, type Resolution } from './fields.js'
import { writeSnapshots, type SnapshotRow } from '../../snapshot/write.js'

/* -------------------------------------------------------------------- specs */

/** The commercial terms. Percent as the provider states it, never rescaled. */
export const BOOKING_TERMS: FieldSpec = {
  propertyId: ['property_id', 'id'],
  commissionPct: ['commission_pct', 'commission', 'commission_percentage'],
  guestTargetPct: ['guest_target_pct', 'guest_target'],
  pmsMarkupPct: ['pms_markup_pct', 'pms_markup', 'markup_pct'],
  observedAt: ['data_as_of', 'updated_at'],
}

export const AIRBNB_LISTING: FieldSpec = {
  listingId: ['listing_id', 'id'],
  guestTargetPct: ['guest_target_pct', 'guest_target'],
  pmsMarkupPct: ['airbnb_pms_markup', 'pms_markup_pct', 'markup_pct'],
  ratingAverage: ['rating_average', 'review_score', 'rating'],
  reviewCount: ['review_count', 'reviews_count'],
  active: ['active', 'is_active'],
  needsSetup: ['needs_setup'],
}

/**
 * The Airbnb funnel and its neighbours, under `chart_metrics`.
 *
 * `adr_booked_comps` is the find: the ADR of the comparable set, delivered on an
 * endpoint we already call. It does not replace a compset — it names no
 * competitor and gives no distance — but it is the one number a compset was
 * mainly wanted for, and it has been arriving all along.
 */
export const CHART_METRICS: Record<string, string> = {
  search_views: 'funnel_airbnb_impressions',
  property_views: 'funnel_airbnb_views',
  booking_conversions: 'funnel_airbnb_conversions',
  search_to_view_rate: 'funnel_airbnb_provider_view_rate',
  view_to_booking_rate: 'funnel_airbnb_provider_book_rate',
  search_listing_conversion: 'funnel_airbnb_search_listing_conversion',
  listing_booking_conversion: 'funnel_airbnb_listing_booking_conversion',
  fp_search_impressions: 'funnel_airbnb_first_page_impressions',
  occupancy_rate: 'channel_occupancy_airbnb',
  cancellation_rate: 'cancellation_rate_airbnb',
  booking_window: 'booking_window_airbnb',
  adr_booked: 'adr_booked_airbnb',
  adr_booked_comps: 'adr_booked_comps_airbnb',
}

/* ------------------------------------------------------------------- report */

export interface DetailEndpoint {
  path: string
  status: number | 'ok'
  rows: number
  resolution: Resolution
  matched: number
  unresolvedIds: string[]
  /** Rows written per destination, so a silent zero is impossible to miss. */
  terms: number
  metrics: number
  levers: number
  eligible: number
  note: string
}

export interface DetailReport {
  kind: 'mdv-detail'
  asOf: string
  endpoints: DetailEndpoint[]
  /** Metric names actually written, so the dashboard query can be checked against it. */
  metricsWritten: string[]
}

const today = (): string => new Date().toISOString().slice(0, 10)

const blank = (path: string): DetailEndpoint => ({
  path, status: 'ok', rows: 0,
  resolution: { used: {}, missing: [], unclaimed: [] },
  matched: 0, unresolvedIds: [], terms: 0, metrics: 0, levers: 0, eligible: 0, note: '',
})

async function entityFor(
  client: PoolClient, source: 'mdv_booking' | 'mdv_airbnb', externalId: string,
): Promise<string | null> {
  for (const kind of ['property', 'listing', 'room'] as const) {
    const hit = await lookupAlias(client, { source, kind, externalId })
    if (hit) return hit.entityId
  }
  return null
}

/** A percentage the provider states. Kept as given; never divided into a fraction. */
function percentOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  // Negative is legitimate here and this is the one place it is: a negative guest
  // target means we are subsidising the price the guest sees.
  return Number.isFinite(n) && Math.abs(n) <= 100 ? n : null
}

const isoDate = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v)
  return m ? m[1]! : null
}

/** Reads a nested path like `attributes.bookDates.dates.from`. */
function at(row: Record<string, unknown>, path: string): unknown {
  let cur: unknown = row
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/* ---------------------------------------------------- the commercial terms */

async function readBookingTerms(
  client: PoolClient, mdv: MdvClient, asOf: string,
): Promise<DetailEndpoint> {
  const path = '/booking/properties/'
  const out = blank(path)
  let body: unknown
  try {
    body = await mdv.get<unknown>(client, path)
  } catch (err) {
    const status = err instanceof MdvError && err.status ? err.status : 0
    return { ...out, status: status || 'ok',
             note: `the endpoint did not answer: ${(err as Error).message}` }
  }
  const { rows } = rowsOf(body)
  await recordShape(client, 'mdv', `GET ${path}`, rows.slice(0, 20), 'terms pass')
  const resolution = resolveFields(rows, BOOKING_TERMS)
  const o = { ...out, rows: rows.length, resolution }
  const idKey = resolution.used.propertyId
  if (!idKey) return { ...o, note: 'no property id present, so nothing can be attributed' }

  const unresolved = new Set<string>()
  let terms = 0
  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const externalId = String(row[idKey] ?? '').trim()
    if (!externalId) continue
    const entityId = await entityFor(client, 'mdv_booking', externalId)
    if (!entityId) { unresolved.add(externalId); continue }
    const res = await client.query(
      `insert into channel_terms
         (entity_id, source, commission_pct, guest_target_pct, pms_markup_pct,
          observed_at, as_of_date)
       values ($1, 'mdv_booking', $2, $3, $4, $5, $6::date)
       on conflict (entity_id, source, as_of_date)
         do update set commission_pct = excluded.commission_pct,
                       guest_target_pct = excluded.guest_target_pct,
                       pms_markup_pct = excluded.pms_markup_pct,
                       observed_at = excluded.observed_at`,
      [entityId,
       resolution.used.commissionPct ? percentOf(row[resolution.used.commissionPct]) : null,
       resolution.used.guestTargetPct ? percentOf(row[resolution.used.guestTargetPct]) : null,
       resolution.used.pmsMarkupPct ? percentOf(row[resolution.used.pmsMarkupPct]) : null,
       resolution.used.observedAt && typeof row[resolution.used.observedAt] === 'string'
         ? row[resolution.used.observedAt] : null,
       asOf])
    terms += res.rowCount ?? 0
  }
  const notes: string[] = []
  if (unresolved.size) notes.push(`${unresolved.size} id(s) matched nothing`)
  if (resolution.unclaimed.length) {
    notes.push(`unclaimed: ${resolution.unclaimed.join(', ')}`)
  }
  return { ...o, matched: terms, terms, unresolvedIds: [...unresolved].slice(0, 20),
           note: notes.join('; ') }
}

/* ------------------------------------------- the Airbnb listing, in full */

async function readAirbnbListings(
  client: PoolClient, mdv: MdvClient, asOf: string, written: Set<string>,
): Promise<DetailEndpoint> {
  const path = '/airbnb/listings/'
  const out = blank(path)
  let body: unknown
  try {
    body = await mdv.get<unknown>(client, path, { limit: 500 })
  } catch (err) {
    const status = err instanceof MdvError && err.status ? err.status : 0
    return { ...out, status: status || 'ok',
             note: `the endpoint did not answer: ${(err as Error).message}` }
  }
  const { rows } = rowsOf(body)
  await recordShape(client, 'mdv', `GET ${path}`, rows.slice(0, 20), 'detail pass')
  const resolution = resolveFields(rows, AIRBNB_LISTING)
  const o = { ...out, rows: rows.length, resolution }
  const idKey = resolution.used.listingId
  if (!idKey) return { ...o, note: 'no listing id present, so nothing can be attributed' }

  const snapshots: SnapshotRow[] = []
  const unresolved = new Set<string>()
  let terms = 0, levers = 0, eligible = 0

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const externalId = String(row[idKey] ?? '').trim()
    if (!externalId) continue
    const entityId = await entityFor(client, 'mdv_airbnb', externalId)
    if (!entityId) { unresolved.add(externalId); continue }
    const observedAt = typeof row.data_as_of === 'string' ? row.data_as_of : undefined

    /* --- the funnel and its neighbours, from chart_metrics ---------------- */
    const chart = row.chart_metrics
    if (chart && typeof chart === 'object') {
      for (const [key, metric] of Object.entries(CHART_METRICS)) {
        const value = countOf((chart as Record<string, unknown>)[key])
        if (value === null) continue
        // Trailing: this block is one figure per listing over a window the
        // provider does not name, exactly like the ranking endpoint.
        snapshots.push({ entityId, metric: `${metric}_trailing`, stayDate: asOf,
                         value, source: 'mdv_airbnb', observedAt })
        written.add(`${metric}_trailing`)
      }
    }

    /* --- the review standing, already here rather than on a second call --- */
    for (const [concept, metric] of [['ratingAverage', 'reviews_airbnb_score'],
                                     ['reviewCount', 'reviews_airbnb_count']] as const) {
      const key = resolution.used[concept]
      if (!key) continue
      const value = countOf(row[key])
      if (value === null) continue
      snapshots.push({ entityId, metric, stayDate: asOf, value,
                       source: 'mdv_airbnb', observedAt })
      written.add(metric)
    }

    /* --- the terms ------------------------------------------------------- */
    const gt = resolution.used.guestTargetPct
      ? percentOf(row[resolution.used.guestTargetPct]) : null
    const mk = resolution.used.pmsMarkupPct
      ? percentOf(row[resolution.used.pmsMarkupPct]) : null
    if (gt !== null || mk !== null) {
      const res = await client.query(
        `insert into channel_terms
           (entity_id, source, guest_target_pct, pms_markup_pct, observed_at, as_of_date)
         values ($1, 'mdv_airbnb', $2, $3, $4, $5::date)
         on conflict (entity_id, source, as_of_date)
           do update set guest_target_pct = excluded.guest_target_pct,
                         pms_markup_pct = excluded.pms_markup_pct,
                         observed_at = excluded.observed_at`,
        [entityId, gt, mk, observedAt ?? null, asOf])
      terms += res.rowCount ?? 0
    }

    /* --- the levers this listing runs ------------------------------------ */
    const promos = Array.isArray(row.promotions) ? row.promotions : []
    for (const p of promos) {
      if (!p || typeof p !== 'object') continue
      const pr = p as Record<string, unknown>
      const kind = String(pr.promotion_type ?? '').trim()
      if (!kind) continue
      levers += await upsertLever(client, {
        entityId, source: 'mdv_airbnb', asOf,
        externalId: typeof pr.promotion_id === 'string' ? pr.promotion_id : null,
        kind, active: typeof pr.is_active === 'boolean' ? pr.is_active : null,
        eligible: true,
        discountPct: null,
        priceFactor: countOf(pr.price_factor),
        priceChange: countOf(pr.price_change),
        leadDays: countOf(pr.lead_days),
        minLos: countOf(pr.min_length_of_stay),
        startsOn: isoDate(pr.start_date), endsOn: isoDate(pr.end_date),
        observedAt: observedAt ?? null,
      })
    }

    /**
     * The levers the channel WOULD let us run and we do not.
     *
     * `eligible_promotions[]` is the cheapest action list on this account and it
     * has been arriving on every import. Stored with `eligible = true` and
     * `active = null` where no live promotion of that type exists: not off, which
     * is a decision, but unclaimed, which is the absence of one.
     */
    const offered = Array.isArray(row.eligible_promotions) ? row.eligible_promotions : []
    for (const p of offered) {
      if (!p || typeof p !== 'object') continue
      const pr = p as Record<string, unknown>
      const kind = String(pr.type ?? '').trim()
      if (!kind) continue
      const attrs = Array.isArray(pr.attributes) ? pr.attributes : []
      const first = attrs[0] && typeof attrs[0] === 'object'
        ? attrs[0] as Record<string, unknown> : null
      eligible += await upsertLever(client, {
        entityId, source: 'mdv_airbnb', asOf,
        externalId: first && typeof first.uuid === 'string' ? first.uuid : null,
        kind, active: null, eligible: true, discountPct: null,
        priceFactor: first ? countOf(first.priceFactor) : null,
        priceChange: null, leadDays: null, minLos: null,
        startsOn: first ? isoDate(first.startDate) : null,
        endsOn: first ? isoDate(first.endDate) : null,
        observedAt: observedAt ?? null,
      })
    }

    /**
     * The three programme switches, each carrying eligible AND enabled.
     *
     * This pair is the whole point: `is_eligible: true, is_enabled: false` is a
     * lever the channel is offering and nobody has taken. A boolean called
     * `active` alone could never say that.
     */
    for (const key of ['mobile_only', 'loyalty_data', 'new_listing_promotion'] as const) {
      const prog = row[key]
      if (!prog || typeof prog !== 'object') continue
      const pg = prog as Record<string, unknown>
      const isEligible = typeof pg.is_eligible === 'boolean' ? pg.is_eligible : null
      if (isEligible === false) continue
      levers += await upsertLever(client, {
        entityId, source: 'mdv_airbnb', asOf, externalId: null,
        kind: key.toUpperCase(),
        active: typeof pg.is_enabled === 'boolean' ? pg.is_enabled : null,
        eligible: isEligible ?? true,
        discountPct: percentOf(pg.percentage),
        priceFactor: null, priceChange: null, leadDays: null, minLos: null,
        startsOn: null, endsOn: null, observedAt: observedAt ?? null,
      })
    }
  }

  const stored = await writeSnapshots(client, asOf, snapshots)
  const notes: string[] = []
  if (unresolved.size) notes.push(`${unresolved.size} id(s) matched nothing`)
  if (resolution.unclaimed.length) {
    notes.push(`unclaimed: ${resolution.unclaimed.slice(0, 12).join(', ')}`)
  }
  return { ...o, matched: new Set(snapshots.map(s => s.entityId)).size,
           unresolvedIds: [...unresolved].slice(0, 20),
           terms, metrics: stored, levers, eligible, note: notes.join('; ') }
}

interface LeverRow {
  entityId: string
  source: 'mdv_booking' | 'mdv_airbnb'
  asOf: string
  externalId: string | null
  kind: string
  active: boolean | null
  eligible: boolean | null
  discountPct: number | null
  priceFactor: number | null
  priceChange: number | null
  leadDays: number | null
  minLos: number | null
  startsOn: string | null
  endsOn: string | null
  observedAt: string | null
}

async function upsertLever(client: PoolClient, l: LeverRow): Promise<number> {
  const res = await client.query(
    `insert into channel_promotion
       (entity_id, source, external_id, kind, active, eligible, discount_pct,
        price_factor, price_change, lead_days, min_los,
        starts_on, ends_on, observed_at, as_of_date)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
             $12::date, $13::date, $14, $15::date)
     on conflict (source, as_of_date, coalesce(entity_id::text, '-'),
                  coalesce(external_id, kind))
       do update set active = coalesce(excluded.active, channel_promotion.active),
                     eligible = coalesce(excluded.eligible, channel_promotion.eligible),
                     discount_pct = coalesce(excluded.discount_pct,
                                             channel_promotion.discount_pct),
                     price_factor = excluded.price_factor,
                     price_change = excluded.price_change,
                     lead_days = excluded.lead_days,
                     min_los = excluded.min_los,
                     starts_on = coalesce(excluded.starts_on, channel_promotion.starts_on),
                     ends_on = coalesce(excluded.ends_on, channel_promotion.ends_on),
                     observed_at = excluded.observed_at`,
    [l.entityId, l.source, l.externalId, l.kind, l.active, l.eligible, l.discountPct,
     l.priceFactor, l.priceChange, l.leadDays, l.minLos,
     l.startsOn, l.endsOn, l.observedAt, l.asOf])
  return res.rowCount ?? 0
}

/* ---------------------------------------------------------------------- pass */

export async function importDetail(
  client: PoolClient, mdv: MdvClient,
): Promise<DetailReport> {
  const asOf = today()
  const written = new Set<string>()
  const endpoints = [
    await readBookingTerms(client, mdv, asOf),
    await readAirbnbListings(client, mdv, asOf, written),
  ]
  return { kind: 'mdv-detail', asOf, endpoints, metricsWritten: [...written].sort() }
}
