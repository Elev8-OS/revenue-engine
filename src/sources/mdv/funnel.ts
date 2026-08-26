/**
 * The funnel layer: how many people saw us, how many looked, how many booked.
 *
 * This is the layer the dashboard has been missing, and the reason every listing
 * has been saying "connected, not read". Occupancy tells us we sold too few
 * nights. Only this tells us WHY — whether nobody saw the listing, or plenty saw
 * it and nobody clicked, or plenty clicked and nobody booked. Three different
 * problems with three different remedies, and a price cut only fixes the third.
 *
 * WHY IT READS FIELD NAMES INSTEAD OF KNOWING THEM.
 *
 * The discovery pass established that all three gates answer: `/booking/ranking/`
 * (trailing), `/airbnb/ranking/` (forward, per stay date) and `/booking/demand/`.
 * What it could not hand over was the exact key names, and there is no route to
 * them that does not pass through somebody reading a rendered page — the MCP
 * connector to the same account is on a stranded token, so it cannot be asked.
 *
 * Reading them off a screen is precisely how this project has already lost two
 * deploys and two live runs: `search_to_view_rate` and `search_to_views_rate` are
 * indistinguishable at a glance, and the Elev8 room filter was calibrated against
 * a field name that the REST endpoint does not use.
 *
 * So this file does not hold a name. It holds, per CONCEPT, a list of candidate
 * names, picks whichever one the payload actually carries, and — the part that
 * matters — REPORTS the choice. Three facts come back from every pass:
 *
 *   used       which key fed which concept
 *   missing    which concepts nothing matched, so the gap is named
 *   unclaimed  which keys were present that no concept asked for
 *
 * `unclaimed` is the one that ends the guessing loop. A name we failed to
 * anticipate does not vanish into a zero; it comes back written down, and the
 * next version of the candidate list is a one-line edit against a measurement.
 *
 * WHAT IT REFUSES TO DO. A rate arriving as `3.4` is either 3.4% or 340%, and
 * the payload does not say which. Rather than pick, the ratios this writes are
 * computed from the counts — views over impressions has no unit to get wrong —
 * and the provider's own rate is stored only when its scale can be established
 * from the spread of values. Otherwise it is reported as undecidable and not
 * written. A number on a dashboard that might be off by a hundredfold is worse
 * than an empty cell, because only one of the two gets checked.
 */
import type { PoolClient } from 'pg'
import { MdvError, type MdvClient } from './client.js'
import { rowsOf } from './discover.js'
import { recordShape } from '../elev8/shape.js'
import { lookupAlias } from '../../entity/resolve.js'
import { writeSnapshots, type SnapshotRow } from '../../snapshot/write.js'

/* ---------------------------------------------------------------- resolution */

/** A concept, and every key name that might be carrying it. */
export type FieldSpec = Record<string, string[]>

export interface Resolution {
  /** concept → the key that actually carried it. */
  used: Record<string, string>
  /** Concepts no candidate matched. Named, so the gap is visible as a gap. */
  missing: string[]
  /**
   * Keys the rows carried that no concept claimed.
   *
   * The most valuable field in this file. Everything else reports what worked;
   * this reports what we failed to anticipate, which is the only thing that can
   * turn a wrong candidate list into a right one without another round trip.
   */
  unclaimed: string[]
}

/** Null, '', [] and {} are absent. Zero is a measurement and must survive. */
const present = (v: unknown): boolean =>
  v !== null && v !== undefined && v !== ''
  && !(Array.isArray(v) && v.length === 0)
  && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0)

/**
 * Picks, per concept, the candidate the payload actually fills.
 *
 * Fill share decides, and candidate order breaks ties. That ordering matters:
 * a provider that keeps a legacy field alive but empty would otherwise win on
 * being listed first, and the concept would resolve to a column of nulls while
 * the real one sat unclaimed two lines below.
 */
export function resolveFields(rows: unknown[], spec: FieldSpec): Resolution {
  const objects = rows.filter((r): r is Record<string, unknown> =>
    Boolean(r) && typeof r === 'object' && !Array.isArray(r))
  const seen = new Set<string>()
  for (const o of objects) for (const k of Object.keys(o)) seen.add(k)

  const used: Record<string, string> = {}
  const missing: string[] = []
  const claimed = new Set<string>()

  for (const [concept, candidates] of Object.entries(spec)) {
    let bestKey = ''
    let bestFilled = 0
    for (const key of candidates) {
      if (!seen.has(key)) continue
      const filled = objects.filter(o => present(o[key])).length
      // Strictly greater, so the earlier candidate wins a tie. Candidate order is
      // the only signal we have about which name the provider prefers.
      if (filled > bestFilled) { bestKey = key; bestFilled = filled }
    }
    if (bestKey) { used[concept] = bestKey; claimed.add(bestKey) }
    else missing.push(concept)
  }
  // Every candidate of every concept is excluded from `unclaimed`, not just the
  // winners: a documented alternative that happened to be empty this pass is
  // already known about, and listing it as unanticipated would bury the one key
  // that genuinely is.
  const known = new Set(Object.values(spec).flat())
  const unclaimed = [...seen].filter(k => !claimed.has(k) && !known.has(k)).sort()
  return { used, missing, unclaimed }
}

/* -------------------------------------------------------------------- values */

/**
 * A count, or null. Negatives are refused because PriceLabs taught this project
 * that a provider will happily put a sentinel where a number belongs, and a
 * sentinel that reaches a chart becomes a conclusion.
 */
export function countOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (!Number.isFinite(n) || n < 0) return null
  return n
}

export type RateUnit = 'fraction' | 'percent' | 'undecidable'

/**
 * Establishes whether a column of rates is 0–1 or 0–100, from the values.
 *
 * A single value of `3.4` is 3.4% or 340% and nothing in the payload says which.
 * A COLUMN, though, usually decides itself: any value above 1 rules out
 * fractions, and a spread that stays under 1 while reaching above 0.01 would be
 * an absurd set of percentages. Everything else — a column of small numbers that
 * could honestly be either — is undecidable, and undecidable is an answer this
 * file is willing to give.
 */
export function rateUnit(values: number[]): RateUnit {
  const v = values.filter(n => Number.isFinite(n) && n >= 0)
  if (!v.length) return 'undecidable'
  const max = Math.max(...v)
  if (max > 1) return 'percent'
  // Below 1 and above 1%: as percentages these would all be under one percent of
  // one percent, which no funnel reports.
  if (max > 0.01) return 'fraction'
  return 'undecidable'
}

/** Normalises to a fraction once the unit is known, and refuses over 1. */
const asFraction = (n: number, unit: RateUnit): number | null => {
  if (unit === 'undecidable') return null
  const f = unit === 'percent' ? n / 100 : n
  return f >= 0 && f <= 1 ? f : null
}

/** A ratio we computed ourselves, which has no unit to get wrong. */
const ratio = (num: number | null, den: number | null): number | null =>
  num === null || den === null || den <= 0 ? null : Math.min(1, num / den)

/* ---------------------------------------------------------------- the specs */

/**
 * Booking's ranking report, which the provider describes as TRAILING: search and
 * property views and conversions over recent history, with no window parameter.
 * The window is therefore the provider's own and unnamed, which is why the
 * metrics written from it carry `_trailing` and not a number of days. Inventing
 * `_last_30d` would be a claim about a window nobody stated.
 */
export const BOOKING_RANKING: FieldSpec = {
  propertyId: ['property_id', 'property', 'hotel_id', 'id'],
  impressions: ['impressions', 'search_impressions', 'search_results',
                'search_appearances', 'appearances', 'searches'],
  views: ['property_views', 'views', 'page_views', 'detail_page_views', 'property_page_views'],
  conversions: ['conversions', 'bookings', 'reservations', 'conversion_count'],
  providerViewRate: ['search_to_view_rate', 'search_to_views_rate', 'view_rate',
                     'click_through_rate', 'ctr'],
  providerBookRate: ['view_to_book_rate', 'conversion_rate', 'booking_rate'],
  observedAt: ['data_as_of', 'updated_at', 'report_date', 'date', 'period_end'],
}

/**
 * Airbnb's is FORWARD-looking: one row per future stay date from today. It cannot
 * share a mapper with Booking's for that reason alone — the same field name means
 * "over the last while" on one channel and "for that night" on the other, and a
 * single mapper would silently average the two into a number about nothing.
 */
export const AIRBNB_RANKING: FieldSpec = {
  listingId: ['listing_id', 'listing', 'id'],
  stayDate: ['stay_date', 'date', 'checkin_date', 'ds', 'day'],
  impressions: ['impressions', 'search_impressions', 'searches', 'search_views'],
  views: ['views', 'listing_views', 'page_views', 'p3_views', 'detail_views'],
  conversions: ['bookings', 'conversions', 'reservations', 'booked'],
  providerViewRate: ['search_to_view_rate', 'search_to_views_rate', 'view_rate', 'ctr'],
  position: ['rank', 'average_rank', 'position', 'search_rank', 'avg_position'],
}

/**
 * Demand is described as TEAM-WIDE, so it may well carry no per-object id at all.
 * That is not a failure: it is a market signal rather than a listing signal, and
 * the pass says which of the two it turned out to be instead of quietly writing
 * nothing.
 */
export const BOOKING_DEMAND: FieldSpec = {
  propertyId: ['property_id', 'property', 'id'],
  stayDate: ['stay_date', 'date', 'checkin_date', 'period_start'],
  searches: ['searches', 'search_volume', 'search_count', 'demand', 'impressions'],
  reservations: ['reservations', 'bookings', 'conversions'],
}

/* -------------------------------------------------------------------- report */

export interface EndpointOutcome {
  path: string
  status: number | 'ok'
  rows: number
  envelope: string
  resolution: Resolution
  /** Objects matched to something in the portfolio, and ids that matched nothing. */
  matched: number
  unresolvedIds: string[]
  /** Values withheld because they were sentinels, or a rate of unknown scale. */
  withheld: number
  rateUnit: RateUnit
  snapshotRows: number
  note: string
}

export interface FunnelReport {
  kind: 'mdv-funnel'
  asOf: string
  endpoints: EndpointOutcome[]
  snapshotRows: number
  /** True when at least one endpoint produced at least one stored value. */
  anyStored: boolean
}

export const isFunnelReportShape = (r: unknown): boolean =>
  Boolean(r) && (r as FunnelReport).kind === 'mdv-funnel'

/* ---------------------------------------------------------------- the passes */

const today = (): string => new Date().toISOString().slice(0, 10)

const isoDate = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v)
  return m ? m[1]! : null
}

/**
 * Resolves a channel id to something already in the portfolio. READ ONLY.
 *
 * `objects.ts` owns aliasing and is the only place allowed to write one. A
 * signal pass that created or re-pointed an alias would be an import wearing a
 * report's clothes — and the last time an MDV pass was allowed to create, it
 * nearly tripled the portfolio.
 */
async function entityFor(
  client: PoolClient, source: 'mdv_booking' | 'mdv_airbnb',
  kind: 'property' | 'listing', externalId: string,
): Promise<string | null> {
  for (const k of [kind, 'listing', 'property', 'room'] as const) {
    const hit = await lookupAlias(client, { source, kind: k, externalId })
    if (hit) return hit.entityId
  }
  return null
}

interface PassInput {
  path: string
  params?: Record<string, string | number>
  spec: FieldSpec
  source: 'mdv_booking' | 'mdv_airbnb'
  kind: 'property' | 'listing'
  idConcept: string
  /** Per stay date, or one trailing figure per object. */
  axis: 'forward' | 'trailing'
}

async function runPass(
  client: PoolClient, mdv: MdvClient, asOf: string, input: PassInput,
): Promise<EndpointOutcome> {
  const base: EndpointOutcome = {
    path: input.path, status: 'ok', rows: 0, envelope: '',
    resolution: { used: {}, missing: [], unclaimed: [] },
    matched: 0, unresolvedIds: [], withheld: 0, rateUnit: 'undecidable',
    snapshotRows: 0, note: '',
  }
  let body: unknown
  try {
    body = await mdv.get<unknown>(client, input.path, input.params ?? {})
  } catch (err) {
    const status = err instanceof MdvError && err.status ? err.status : 0
    return { ...base, status: status || 'ok',
             note: `the endpoint did not answer: ${(err as Error).message}` }
  }

  const { rows, envelope } = rowsOf(body)
  // Recorded even when nothing maps, because the shape is the thing that makes
  // the next candidate list right. This is the whole lesson of the last two days.
  await recordShape(client, 'mdv', `GET ${input.path}`, rows.slice(0, 20),
                    `funnel pass, envelope: ${envelope}`)

  const resolution = resolveFields(rows, input.spec)
  const out: EndpointOutcome = { ...base, rows: rows.length, envelope, resolution }
  if (!rows.length) return { ...out, note: 'the endpoint answered with no rows' }

  const idKey = resolution.used[input.idConcept]
  if (!idKey) {
    // Named absence. A team-wide report is a real answer, and saying so is worth
    // more than writing zero rows and letting the page imply the endpoint failed.
    return { ...out, note: `no per-object id: none of `
      + `${input.spec[input.idConcept]!.join(', ')} was present, so these rows are `
      + `about the account and not about a listing` }
  }

  const objs = rows.filter((r): r is Record<string, unknown> =>
    Boolean(r) && typeof r === 'object')
  const rateKey = resolution.used.providerViewRate
  const unit = rateKey
    ? rateUnit(objs.map(o => Number(o[rateKey])).filter(n => Number.isFinite(n)))
    : 'undecidable'

  const snapshots: SnapshotRow[] = []
  const unresolved = new Set<string>()
  let withheld = 0
  const suffix = input.axis === 'trailing' ? '_trailing' : ''

  for (const row of objs) {
    const externalId = String(row[idKey] ?? '').trim()
    if (!externalId) { withheld++; continue }
    const entityId = await entityFor(client, input.source, input.kind, externalId)
    if (!entityId) { unresolved.add(externalId); continue }

    const stayKey = resolution.used.stayDate
    const stayDate = input.axis === 'forward'
      ? (stayKey ? isoDate(row[stayKey]) : null)
      : asOf
    // A forward row with no date it is about cannot be filed. Guessing today
      // would put next month's impressions on tonight.
    if (!stayDate) { withheld++; continue }

    const observedAt = resolution.used.observedAt
      ? (typeof row[resolution.used.observedAt] === 'string'
         ? row[resolution.used.observedAt] as string : undefined)
      : undefined

    const imp = resolution.used.impressions ? countOf(row[resolution.used.impressions]) : null
    const views = resolution.used.views ? countOf(row[resolution.used.views]) : null
    const conv = resolution.used.conversions ? countOf(row[resolution.used.conversions]) : null
    const pos = resolution.used.position ? countOf(row[resolution.used.position]) : null

    const put = (metric: string, value: number | null) => {
      if (value === null) { withheld++; return }
      snapshots.push({ entityId, metric: metric + suffix, stayDate, value,
                       source: input.source, observedAt })
    }
    if (resolution.used.impressions) put('funnel_impressions', imp)
    if (resolution.used.views) put('funnel_views', views)
    if (resolution.used.conversions) put('funnel_conversions', conv)
    if (resolution.used.position) put('funnel_position', pos)

    // Computed from the counts, so there is no scale to misread. The provider's
    // own rate is written only in addition, and only once its unit is settled.
    const vr = ratio(views, imp)
    if (vr !== null) put('funnel_view_rate', vr)
    const br = ratio(conv, views)
    if (br !== null) put('funnel_book_rate', br)
    if (rateKey) {
      const raw = Number(row[rateKey])
      const asFrac = Number.isFinite(raw) ? asFraction(raw, unit) : null
      if (asFrac === null) withheld++
      else put('funnel_provider_view_rate', asFrac)
    }
  }

  const written = await writeSnapshots(client, asOf, snapshots)
  const notes: string[] = []
  if (unresolved.size) {
    notes.push(`${unresolved.size} id(s) matched nothing in the portfolio`)
  }
  if (rateKey && unit === 'undecidable') {
    notes.push(`${rateKey} was left unstored: its scale could not be established `
      + `from the values, and a rate that might be off a hundredfold is worse than none`)
  }
  if (resolution.unclaimed.length) {
    notes.push(`unclaimed keys present: ${resolution.unclaimed.join(', ')}`)
  }
  return {
    ...out, matched: snapshots.length ? new Set(snapshots.map(s => s.entityId)).size : 0,
    unresolvedIds: [...unresolved].slice(0, 20), withheld, rateUnit: unit,
    snapshotRows: written, note: notes.join('; '),
  }
}

/**
 * Reads the funnel and writes what it can defend.
 *
 * Each endpoint is its own outcome. One 403 must not take the other two with it:
 * the three gates are separate permissions on MDV's side, and a pass that
 * reported a single failure would make a partially granted account look like a
 * broken one.
 */
export async function importFunnel(
  client: PoolClient, mdv: MdvClient,
): Promise<FunnelReport> {
  const asOf = today()
  const passes: PassInput[] = [
    { path: '/booking/ranking/', params: { limit: 500 }, spec: BOOKING_RANKING,
      source: 'mdv_booking', kind: 'property', idConcept: 'propertyId', axis: 'trailing' },
    { path: '/airbnb/ranking/', params: { limit: 500, days_ahead: 90 },
      spec: AIRBNB_RANKING, source: 'mdv_airbnb', kind: 'listing',
      idConcept: 'listingId', axis: 'forward' },
    { path: '/booking/demand/', params: { limit: 500 }, spec: BOOKING_DEMAND,
      source: 'mdv_booking', kind: 'property', idConcept: 'propertyId', axis: 'forward' },
  ]
  const endpoints: EndpointOutcome[] = []
  for (const p of passes) endpoints.push(await runPass(client, mdv, asOf, p))
  const snapshotRows = endpoints.reduce((n, e) => n + e.snapshotRows, 0)
  return { kind: 'mdv-funnel', asOf, endpoints, snapshotRows, anyStored: snapshotRows > 0 }
}
