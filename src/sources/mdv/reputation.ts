/**
 * Reviews and commercial levers: the two things a price cannot fix.
 *
 * WHY THESE TWO BELONG TOGETHER. Both answer the same question — "is this
 * listing losing on something other than its price?" — and both are read the
 * same way, with candidate names resolved against the payload rather than
 * assumed. What they are NOT is interchangeable in storage: a review score is a
 * measurement that moves, so it goes in `snapshot`; a promotion is a state with
 * a shape (type, switch, rate, window), so it gets its own table.
 *
 * WHY REVIEWS MATTER MORE THAN THEIR SIZE SUGGESTS. MyDataValue's own ranking
 * work weights `review_score` at 18.4% and `review_count` at 3.1% of the match
 * that decides where a listing lands in a search result. On this account there is
 * an object with a score of 10 from a SINGLE review. It loses structurally, and
 * no price change repairs that — a pricing tool pointed at it would go on
 * proposing prices forever. Two numbers, and they change which findings are even
 * allowed to fire.
 *
 * WHY PROMOTIONS ARE STORED AS THE PROVIDER NAMES THEM. `genius`,
 * `mobile_discount`, `visibility_booster`, `preferred` — transcribed, never
 * normalised into a vocabulary of our own. Deciding that two provider labels mean
 * the same thing is a guess, and the take-rate stack is multiplicative: getting
 * one label wrong misstates the whole margin, not one line of it.
 */
import type { PoolClient } from 'pg'
import { MdvError, type MdvClient } from './client.js'
import { rowsOf } from './discover.js'
import { recordShape } from '../elev8/shape.js'
import { lookupAlias } from '../../entity/resolve.js'
import { resolveFields, countOf, type FieldSpec, type Resolution } from './fields.js'
import { writeSnapshots, type SnapshotRow } from '../../snapshot/write.js'

/* ------------------------------------------------------------------- specs */

/**
 * Reviews: five fields per row on both channels, per the discovery pass. The
 * candidate lists lead with the names the provider's own ranking write-up uses,
 * which is the closest thing to a measurement we had before the first run.
 */
export const REVIEWS: FieldSpec = {
  propertyId: ['property_id', 'property', 'hotel_id', 'id'],
  listingId: ['listing_id', 'listing', 'id'],
  score: ['review_score', 'score', 'rating', 'average_score', 'guest_rating',
          'review_rating', 'overall_score'],
  count: ['review_count', 'reviews_count', 'number_of_reviews', 'reviews',
          'total_reviews', 'count'],
  observedAt: ['data_as_of', 'updated_at', 'last_review_at'],
}

/**
 * Promotions: 34 fields, so the candidate lists are wider and the `unclaimed`
 * report matters more here than anywhere else. Whatever this misses comes back
 * named on the import page.
 */
export const PROMOTIONS: FieldSpec = {
  propertyId: ['property_id', 'property', 'hotel_id'],
  externalId: ['promotion_id', 'id', 'campaign_id', 'deal_id'],
  kind: ['promotion_type', 'type', 'name', 'programme', 'program', 'deal_type',
         'promotion_name', 'kind'],
  active: ['active', 'is_active', 'enabled', 'is_enabled', 'status'],
  discountPct: ['discount_percentage', 'discount_pct', 'discount', 'percentage',
                'percent', 'rate', 'commission_pct'],
  startsOn: ['start_date', 'starts_on', 'valid_from', 'from_date', 'stay_start'],
  endsOn: ['end_date', 'ends_on', 'valid_to', 'to_date', 'stay_end'],
  observedAt: ['data_as_of', 'updated_at', 'created_at'],
}

/* ------------------------------------------------------------------ report */

export interface ReputationEndpoint {
  path: string
  status: number | 'ok'
  rows: number
  envelope: string
  resolution: Resolution
  /** Rows attributed to an object we hold. */
  matched: number
  /** Rows the provider gave us that belong to no object we hold. */
  unresolvedIds: string[]
  /**
   * Rows that carry no object id at all. NOT the same as unresolved: the
   * promotions report is documented as team-wide, so an unattributed row is the
   * provider's design and not our failure to join.
   */
  unattributed: number
  withheld: number
  stored: number
  /** The label vocabulary actually seen, so the next mapping is exact. */
  vocabulary: string[]
  truncated: boolean
  note: string
}

export interface ReputationReport {
  kind: 'mdv-reputation'
  asOf: string
  endpoints: ReputationEndpoint[]
  reviewRows: number
  promotionRows: number
}

/* -------------------------------------------------------------------- helper */

/** A score, refused when it falls outside any scale a review could be on. */
export function scoreOf(v: unknown): number | null {
  const n = countOf(v)
  // Booking runs 0-10, Airbnb 0-5, some feeds send 0-100. A number above 100 is
  // not a review score on any of them, and 0 is legitimately "no rating yet"
  // rather than the worst possible one — so it is withheld, not stored as zero.
  if (n === null || n === 0 || n > 100) return null
  return n
}

/**
 * A switch, or null when the payload has no opinion.
 *
 * `null` and `false` are different facts and this is where they part. A missing
 * switch means "the provider did not say"; false means "the provider said off".
 * Collapsing them would let the page report a programme as switched off on the
 * strength of a field that was never sent.
 */
export function switchOf(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') {
    const t = v.trim().toLowerCase()
    if (['true', 'yes', 'y', '1', 'active', 'enabled', 'running', 'on'].includes(t)) return true
    if (['false', 'no', 'n', '0', 'inactive', 'disabled', 'off', 'expired',
         'stopped', 'ended'].includes(t)) return false
  }
  return null
}

const isoDate = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v)
  return m ? m[1]! : null
}

const today = (): string => new Date().toISOString().slice(0, 10)

/** Read-only alias lookup. `objects.ts` stays the only writer of aliases. */
async function entityFor(
  client: PoolClient, source: 'mdv_booking' | 'mdv_airbnb', externalId: string,
): Promise<string | null> {
  for (const kind of ['property', 'listing', 'room'] as const) {
    const hit = await lookupAlias(client, { source, kind, externalId })
    if (hit) return hit.entityId
  }
  return null
}

const blank = (path: string): ReputationEndpoint => ({
  path, status: 'ok', rows: 0, envelope: '',
  resolution: { used: {}, missing: [], unclaimed: [] },
  matched: 0, unresolvedIds: [], unattributed: 0, withheld: 0, stored: 0,
  vocabulary: [], truncated: false, note: '',
})

/* ------------------------------------------------------------------- reviews */

async function readReviews(
  client: PoolClient, mdv: MdvClient, asOf: string,
  path: string, source: 'mdv_booking' | 'mdv_airbnb', idConcept: 'propertyId' | 'listingId',
): Promise<ReputationEndpoint> {
  const out = blank(path)
  let body: unknown
  try {
    body = await mdv.get<unknown>(client, path, { limit: 500 })
  } catch (err) {
    const status = err instanceof MdvError && err.status ? err.status : 0
    return { ...out, status: status || 'ok',
             note: `the endpoint did not answer: ${(err as Error).message}` }
  }
  const { rows, envelope } = rowsOf(body)
  await recordShape(client, 'mdv', `GET ${path}`, rows.slice(0, 20),
                    `reviews pass, envelope: ${envelope}`)
  const resolution = resolveFields(rows, REVIEWS)
  const o = { ...out, rows: rows.length, envelope, resolution,
              truncated: rows.length >= 500 }
  if (!rows.length) return { ...o, note: 'the endpoint answered with no rows' }

  const idKey = resolution.used[idConcept]
  if (!idKey) {
    return { ...o, note: `no object id: none of ${REVIEWS[idConcept]!.join(', ')} `
      + `was present, so these rows cannot be attributed to a listing` }
  }
  const channel = source === 'mdv_booking' ? 'booking' : 'airbnb'
  const objs = rows.filter((r): r is Record<string, unknown> =>
    Boolean(r) && typeof r === 'object')
  const snapshots: SnapshotRow[] = []
  const unresolved = new Set<string>()
  let withheld = 0

  for (const row of objs) {
    const externalId = String(row[idKey] ?? '').trim()
    if (!externalId) { withheld++; continue }
    const entityId = await entityFor(client, source, externalId)
    if (!entityId) { unresolved.add(externalId); continue }
    const observedAt = resolution.used.observedAt
      && typeof row[resolution.used.observedAt] === 'string'
      ? row[resolution.used.observedAt] as string : undefined
    const score = resolution.used.score ? scoreOf(row[resolution.used.score]) : null
    // A count of zero IS the finding — a listing nobody has reviewed is exactly
    // the structural handicap this pass exists to surface — so countOf, which
    // keeps zero, and not scoreOf, which refuses it.
    const count = resolution.used.count ? countOf(row[resolution.used.count]) : null
    if (score === null && count === null) { withheld++; continue }
    if (score !== null) {
      snapshots.push({ entityId, metric: `reviews_${channel}_score`, stayDate: asOf,
                       value: score, source, observedAt })
    }
    if (count !== null) {
      snapshots.push({ entityId, metric: `reviews_${channel}_count`, stayDate: asOf,
                       value: count, source, observedAt })
    }
  }
  const stored = await writeSnapshots(client, asOf, snapshots)
  const notes: string[] = []
  if (unresolved.size) notes.push(`${unresolved.size} id(s) matched nothing in the portfolio`)
  if (resolution.unclaimed.length) {
    notes.push(`unclaimed keys present: ${resolution.unclaimed.join(', ')}`)
  }
  if (o.truncated) notes.push('the row count hit the page size, so this is one page')
  return { ...o, matched: new Set(snapshots.map(s => s.entityId)).size,
           unresolvedIds: [...unresolved].slice(0, 20), withheld, stored,
           note: notes.join('; ') }
}

/* ---------------------------------------------------------------- promotions */

async function readPromotions(
  client: PoolClient, mdv: MdvClient, asOf: string,
): Promise<ReputationEndpoint> {
  const path = '/booking/promotions/'
  const out = blank(path)
  let body: unknown
  try {
    body = await mdv.get<unknown>(client, path, { limit: 500 })
  } catch (err) {
    const status = err instanceof MdvError && err.status ? err.status : 0
    return { ...out, status: status || 'ok',
             note: `the endpoint did not answer: ${(err as Error).message}` }
  }
  const { rows, envelope } = rowsOf(body)
  await recordShape(client, 'mdv', `GET ${path}`, rows.slice(0, 20),
                    `promotions pass, envelope: ${envelope}`)
  const resolution = resolveFields(rows, PROMOTIONS)
  const o = { ...out, rows: rows.length, envelope, resolution,
              truncated: rows.length >= 500 }
  if (!rows.length) return { ...o, note: 'the endpoint answered with no rows' }

  const kindKey = resolution.used.kind
  if (!kindKey) {
    // Without a label there is nothing to store: a switch with no name is not a
    // promotion, it is a boolean of unknown subject.
    return { ...o, note: `no promotion label: none of ${PROMOTIONS.kind!.join(', ')} `
      + `was present, so nothing can be named. Keys seen are in the shape record` }
  }
  const objs = rows.filter((r): r is Record<string, unknown> =>
    Boolean(r) && typeof r === 'object')
  const idKey = resolution.used.propertyId
  const kinds = new Set<string>()
  const unresolved = new Set<string>()
  let unattributed = 0, stored = 0, withheld = 0

  for (const row of objs) {
    const kind = String(row[kindKey] ?? '').trim()
    if (!kind) { withheld++; continue }
    kinds.add(kind)
    let entityId: string | null = null
    if (idKey) {
      const externalId = String(row[idKey] ?? '').trim()
      if (!externalId) unattributed++
      else {
        entityId = await entityFor(client, 'mdv_booking', externalId)
        if (!entityId) unresolved.add(externalId)
      }
    } else unattributed++

    const pct = resolution.used.discountPct ? countOf(row[resolution.used.discountPct]) : null
    const res = await client.query(
      `insert into channel_promotion
         (entity_id, source, external_id, kind, active, discount_pct,
          starts_on, ends_on, observed_at, as_of_date)
       values ($1, 'mdv_booking', $2, $3, $4, $5, $6::date, $7::date, $8, $9::date)
       on conflict (source, as_of_date, coalesce(entity_id::text, '-'),
                    coalesce(external_id, kind))
         do update set active = excluded.active,
                       discount_pct = excluded.discount_pct,
                       starts_on = excluded.starts_on,
                       ends_on = excluded.ends_on,
                       observed_at = excluded.observed_at`,
      [entityId,
       resolution.used.externalId ? String(row[resolution.used.externalId] ?? '') || null : null,
       kind,
       resolution.used.active ? switchOf(row[resolution.used.active]) : null,
       pct !== null && pct <= 100 ? pct : null,
       resolution.used.startsOn ? isoDate(row[resolution.used.startsOn]) : null,
       resolution.used.endsOn ? isoDate(row[resolution.used.endsOn]) : null,
       resolution.used.observedAt
         && typeof row[resolution.used.observedAt] === 'string'
         ? row[resolution.used.observedAt] : null,
       asOf])
    stored += res.rowCount ?? 0
  }
  const notes: string[] = []
  if (unattributed) {
    notes.push(`${unattributed} row(s) carry no object id — this report is `
      + `documented as team-wide, so they are kept as account-level and not guessed onto a listing`)
  }
  if (unresolved.size) notes.push(`${unresolved.size} id(s) matched nothing in the portfolio`)
  if (resolution.unclaimed.length) {
    notes.push(`unclaimed keys present: ${resolution.unclaimed.join(', ')}`)
  }
  if (o.truncated) notes.push('the row count hit the page size, so this is one page')
  return { ...o, matched: objs.length - unattributed - unresolved.size,
           unresolvedIds: [...unresolved].slice(0, 20), unattributed, withheld, stored,
           vocabulary: [...kinds].sort().slice(0, 40), note: notes.join('; ') }
}

/* ---------------------------------------------------------------------- pass */

export async function importReputation(
  client: PoolClient, mdv: MdvClient,
): Promise<ReputationReport> {
  const asOf = today()
  const endpoints: ReputationEndpoint[] = [
    await readReviews(client, mdv, asOf, '/booking/reviews/', 'mdv_booking', 'propertyId'),
    await readReviews(client, mdv, asOf, '/airbnb/reviews/', 'mdv_airbnb', 'listingId'),
    await readPromotions(client, mdv, asOf),
  ]
  return {
    kind: 'mdv-reputation', asOf, endpoints,
    reviewRows: endpoints.slice(0, 2).reduce((n, e) => n + e.stored, 0),
    promotionRows: endpoints[2]!.stored,
  }
}
