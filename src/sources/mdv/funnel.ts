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
import { resolveFields, countOf, rateUnit, asFraction, ratio,
         type FieldSpec, type Resolution, type RateUnit } from './fields.js'
import { writeSnapshots, type SnapshotRow } from '../../snapshot/write.js'

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
  impressions: ['search_views', 'impressions', 'search_impressions', 'search_results',
                'search_appearances', 'appearances'],
  views: ['property_views', 'views', 'page_views', 'detail_page_views', 'property_page_views'],
  conversions: ['booking_conversions', 'conversions', 'bookings', 'reservations',
                'conversion_count'],
  providerViewRate: ['search_to_view_rate', 'search_to_views_rate', 'view_rate',
                     'click_through_rate', 'ctr'],
  providerBookRate: ['view_to_booking_rate', 'view_to_book_rate', 'conversion_rate',
                     'booking_rate'],
  observedAt: ['data_as_of', 'updated_at', 'report_date', 'period_end'],
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
  impressions: ['search_views', 'impressions', 'search_impressions', 'searches'],
  views: ['property_views', 'views', 'listing_views', 'page_views', 'p3_views',
          'detail_views'],
  conversions: ['booking_conversions', 'bookings', 'conversions', 'reservations', 'booked'],
  providerViewRate: ['search_to_view_rate', 'search_to_views_rate', 'view_rate', 'ctr'],
  providerBookRate: ['view_to_booking_rate', 'view_to_book_rate', 'conversion_rate'],
  position: ['rank', 'average_rank', 'position', 'search_rank', 'avg_position'],
  observedAt: ['data_as_of', 'updated_at', 'report_date'],
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
  searches: ['searches', 'search_volume', 'search_count', 'demand'],
  reservations: ['reservations', 'bookings', 'conversions'],
  /**
   * Demand came back in LONG form: one row per figure, carrying `section`,
   * `category` and `value` instead of a column per metric. So there is nothing
   * named `searches` to find, and there never will be.
   *
   * These three concepts detect that shape. When they resolve and the named
   * metrics do not, the pass reports the label vocabulary and stores nothing —
   * because `value` arrives with no unit, under a word, and deciding that
   * "Searches" means a count of searches would be inference dressed as a
   * measurement. The vocabulary is cheap to report and makes the next edit exact.
   */
  metricSection: ['section', 'group', 'report', 'report_section'],
  metricLabel: ['category', 'metric', 'name', 'kpi', 'label'],
  metricValue: ['value', 'amount', 'count', 'figure'],
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
  /**
   * DERIVED from the payload, never declared.
   *
   * The provider's own documentation says Airbnb's ranking report is forward
   * looking, per future stay date. This account's does not carry a date field at
   * all: 47 rows, one per listing, with `data_as_of`. Declaring the axis in the
   * call site made every one of those 38 matched rows unfilable, and the run
   * stored nothing while reporting success on the fields it had found.
   *
   * So the axis is now whatever the rows can support, and it is REPORTED —
   * because a metric suffix that changes with the payload must be visible, not
   * inferred from a dashboard label.
   */
  axis: 'forward' | 'trailing' | 'none'
  /**
   * For a long-form report: the label vocabulary, so the next mapping is written
   * against words the provider actually used.
   */
  vocabulary: string[]
  /** The row count hit the page size, so this is a page and not the whole set. */
  truncated: boolean
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
  /** The page size asked for, so a full page can be reported as a partial answer. */
  limit?: number
}

async function runPass(
  client: PoolClient, mdv: MdvClient, asOf: string, input: PassInput,
): Promise<EndpointOutcome> {
  const base: EndpointOutcome = {
    path: input.path, status: 'ok', rows: 0, envelope: '',
    resolution: { used: {}, missing: [], unclaimed: [] },
    matched: 0, unresolvedIds: [], withheld: 0, rateUnit: 'undecidable',
    snapshotRows: 0, axis: 'none', vocabulary: [], truncated: false, note: '',
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

  out.truncated = input.limit !== undefined && rows.length >= input.limit

  /**
   * A LONG-FORM report: `section`, `category`, `value` instead of a column per
   * figure. Reported, not mapped.
   *
   * `value` arrives with no unit, under a word. Deciding that a category called
   * "Searches" holds a count of searches — rather than an index, a share or a
   * rank — would be inference wearing a measurement's clothes, and this file's
   * whole reason for existing is that the project has twice paid for exactly
   * that. The vocabulary costs one line to report and makes the mapping exact.
   */
  if (resolution.used.metricValue && resolution.used.metricLabel
      && !resolution.used.searches && !resolution.used.reservations) {
    const labels = new Set<string>()
    for (const r of rows) {
      if (!r || typeof r !== 'object') continue
      const o = r as Record<string, unknown>
      const sec = resolution.used.metricSection ? o[resolution.used.metricSection] : null
      const lab = o[resolution.used.metricLabel]
      if (typeof lab === 'string' && lab) {
        labels.add(typeof sec === 'string' && sec ? `${sec} / ${lab}` : lab)
      }
    }
    return { ...out, vocabulary: [...labels].sort().slice(0, 40),
      note: `long-form report: one row per figure under `
        + `${resolution.used.metricLabel}, with the number in `
        + `${resolution.used.metricValue}. Nothing stored: the value carries no `
        + `unit, and reading a meaning off the label would be a guess. The `
        + `vocabulary is listed so the mapping can be written against it`
        + (out.truncated ? '. NOTE: the row count hit the page size, so this is one page' : '') }
  }

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
  /**
   * The axis, decided by what the rows carry rather than by what the call site
   * believed. A date field means each row is about a night; no date field means
   * the row is one figure about the object over a window the provider chose.
   */
  const axis: 'forward' | 'trailing' = resolution.used.stayDate ? 'forward' : 'trailing'
  out.axis = axis
  const rateKey = resolution.used.providerViewRate
  const unit = rateKey
    ? rateUnit(objs.map(o => Number(o[rateKey])).filter(n => Number.isFinite(n)))
    : 'undecidable'

  const snapshots: SnapshotRow[] = []
  const unresolved = new Set<string>()
  let withheld = 0
  /**
   * The metric name carries the CHANNEL, and this is the correction for a bug
   * that silently halved the funnel.
   *
   * `snapshot`'s primary key is (entity_id, metric, stay_date, as_of_date). There
   * is no `source` in it. Both channels answer with the same field names, the
   * same axis and — for a trailing figure — the same stay_date, so both wrote
   * `funnel_impressions_trailing` on the same object on the same day. The second
   * write won the upsert and the first channel disappeared: every listing on both
   * OTAs showed exactly one chain, and which one depended on pass order.
   *
   * The read side was already split by source. Splitting only the read was the
   * mistake — by the time the query ran there was one row left to split.
   *
   * So the channel goes into the name, because the name is ours and "how many
   * people saw this listing" is not a complete question until it says where.
   * Widening the primary key would be the other fix, and a bigger one: that
   * column is shared with prices, occupancy and market rows, and changing what
   * makes them unique is not a change to make while chasing a display bug.
   */
  const channel = input.source === 'mdv_booking' ? 'booking' : 'airbnb'
  const suffix = axis === 'trailing' ? '_trailing' : ''
  const name = (concept: string) => `funnel_${channel}_${concept}`

  for (const row of objs) {
    const externalId = String(row[idKey] ?? '').trim()
    if (!externalId) { withheld++; continue }
    const entityId = await entityFor(client, input.source, input.kind, externalId)
    if (!entityId) { unresolved.add(externalId); continue }

    const stayKey = resolution.used.stayDate
    const stayDate = axis === 'forward' && stayKey ? isoDate(row[stayKey]) : asOf
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
    if (resolution.used.impressions) put(name('impressions'), imp)
    if (resolution.used.views) put(name('views'), views)
    if (resolution.used.conversions) put(name('conversions'), conv)
    if (resolution.used.position) put(name('position'), pos)

    // Computed from the counts, so there is no scale to misread. The provider's
    // own rate is written only in addition, and only once its unit is settled.
    const vr = ratio(views, imp)
    if (vr !== null) put(name('view_rate'), vr)
    const br = ratio(conv, views)
    if (br !== null) put(name('book_rate'), br)
    if (rateKey) {
      const raw = Number(row[rateKey])
      const asFrac = Number.isFinite(raw) ? asFraction(raw, unit) : null
      if (asFrac === null) withheld++
      else put(name('provider_view_rate'), asFrac)
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
  // Said out loud, because it decides what the metric is called and therefore
  // which half of the dashboard reads it.
  notes.push(axis === 'forward'
    ? `filed per stay date, from ${resolution.used.stayDate}`
    : `filed as one trailing figure per object: no date field was present, so `
      + `the window is the provider's own and is not named`)
  if (out.truncated) {
    notes.push(`the row count hit the page size, so this is one page and not the `
      + `whole set`)
  }
  return {
    ...out, axis, matched: snapshots.length ? new Set(snapshots.map(s => s.entityId)).size : 0,
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
    { path: '/booking/ranking/', params: { limit: 500 }, limit: 500,
      spec: BOOKING_RANKING, source: 'mdv_booking', kind: 'property',
      idConcept: 'propertyId' },
    // `days_ahead` is still sent because the provider documents it, but this
    // account's answer carries no date, so the axis comes from the rows.
    { path: '/airbnb/ranking/', params: { limit: 500, days_ahead: 90 }, limit: 500,
      spec: AIRBNB_RANKING, source: 'mdv_airbnb', kind: 'listing',
      idConcept: 'listingId' },
    { path: '/booking/demand/', params: { limit: 500 }, limit: 500,
      spec: BOOKING_DEMAND, source: 'mdv_booking', kind: 'property',
      idConcept: 'propertyId' },
  ]
  const endpoints: EndpointOutcome[] = []
  for (const p of passes) endpoints.push(await runPass(client, mdv, asOf, p))
  const snapshotRows = endpoints.reduce((n, e) => n + e.snapshotRows, 0)
  return { kind: 'mdv-funnel', asOf, endpoints, snapshotRows, anyStored: snapshotRows > 0 }
}
