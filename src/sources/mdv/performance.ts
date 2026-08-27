/**
 * The performance endpoints: rank, and the market environment as the channel sees it.
 *
 * I had written down that these two only duplicated PriceLabs. The shape export
 * says otherwise, and the difference is most of what was still missing:
 *
 *   · SEARCH RANK per property, with its previous value and its change — the
 *     figure I recorded as "not sent by this account" because I only looked in
 *     /booking/ranking/. There is also a whole `ranking_timeline` with a daily
 *     percentile and the sampling basis behind it.
 *   · HOW LONG PEOPLE STAY and HOW MANY TRAVEL TOGETHER, current and comparison.
 *   · WHERE THEY COME FROM, ten countries deep, current and comparison — the
 *     search-side origin mix, next to the booked-side mix we already have.
 *   · THE CANCELLATION RATE, with its change.
 *   · Revenue, ADR and nights PER CURRENCY. CHF, EUR and IDR arrive separately,
 *     and summing them would produce a number in no currency at all.
 *
 * TWO THINGS THIS REFUSES TO DO.
 *
 * It does not label the comparison "last year" unless `period_info.compare_yoy`
 * says so. The endpoint compares against the prior period by default, and calling
 * that a year-on-year figure is the kind of quiet mislabelling that survives for
 * months because both numbers look plausible.
 *
 * It does not guess whether a breakdown is counts or shares. `"2-6 nights": 41`
 * is either forty-one reservations or forty-one percent. That can be DERIVED —
 * shares sum to about 100, counts sum to the reservation total — so it checks,
 * records which it concluded, and marks the set undecidable when neither holds.
 */
import type { PoolClient } from 'pg'
import { MdvError, type MdvClient } from './client.js'
import { recordShape } from '../elev8/shape.js'
import { lookupAlias } from '../../entity/resolve.js'
import { countOf, signedOf } from './fields.js'
import { writeSnapshots, type SnapshotRow } from '../../snapshot/write.js'

export type Unit = 'count' | 'share' | 'rate' | 'percentile' | 'undecidable'

export interface PerformanceEndpoint {
  path: string
  status: number | 'ok'
  /** Objects the per-property breakdown could be attributed to. */
  matched: number
  unresolvedIds: string[]
  snapshotRows: number
  insightRows: number
  /** Which comparison the provider used: a year earlier, or the prior period. */
  compareYoy: boolean | null
  /** What each breakdown turned out to be measured in. */
  units: Record<string, Unit>
  /** Currencies the payload split by. Never summed across. */
  currencies: string[]
  /** Reported, deliberately not displayed. See `vendorClaim` below. */
  vendorClaim: string | null
  note: string
}

export interface PerformanceReport {
  kind: 'mdv-performance'
  asOf: string
  endpoints: PerformanceEndpoint[]
  ranksWritten: number
}

const today = (): string => new Date().toISOString().slice(0, 10)

const isoDate = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v)
  return m ? m[1]! : null
}

function at(o: unknown, path: string): unknown {
  let cur: unknown = o
  for (const part of path.split('.')) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

/**
 * Counts or shares, derived from the set rather than assumed.
 *
 * A breakdown that sums to roughly 100 is shares. One that sums to the
 * reservation total is counts. Anything else is undecidable — and undecidable
 * figures are stored but never charted, because a bar chart of numbers whose unit
 * is unknown is a picture of nothing.
 *
 * The tolerance is wide on purpose: providers round, and a set of shares summing
 * to 99.4 is still a set of shares.
 */
export function unitOfBreakdown(values: number[], reservations: number | null): Unit {
  const clean = values.filter(v => Number.isFinite(v) && v >= 0)
  if (!clean.length) return 'undecidable'
  const total = clean.reduce((a, b) => a + b, 0)
  if (Math.abs(total - 100) <= 3) return 'share'
  if (reservations !== null && reservations > 0
      && Math.abs(total - reservations) <= Math.max(1, reservations * 0.05)) {
    return 'count'
  }
  return 'undecidable'
}

interface InsightRow {
  source: 'mdv_booking' | 'mdv_airbnb'
  section: string
  label: string
  value: number | null
  comparison: number | null
  unit: Unit
  compareYoy: boolean | null
  periodStart: string | null
  periodEnd: string | null
  observedAt: string | null
  asOf: string
}

async function putInsight(client: PoolClient, r: InsightRow): Promise<number> {
  const res = await client.query(
    `insert into channel_insight
       (source, section, label, value, comparison, unit, compare_yoy,
        period_start, period_end, observed_at, as_of_date)
     values ($1, $2, $3, $4, $5, $6, $7, $8::date, $9::date, $10, $11::date)
     on conflict (source, section, label, as_of_date)
       do update set value = excluded.value, comparison = excluded.comparison,
                     unit = excluded.unit, compare_yoy = excluded.compare_yoy,
                     period_start = excluded.period_start,
                     period_end = excluded.period_end,
                     observed_at = excluded.observed_at`,
    [r.source, r.section, r.label, r.value, r.comparison, r.unit, r.compareYoy,
     r.periodStart, r.periodEnd, r.observedAt, r.asOf])
  return res.rowCount ?? 0
}

async function entityFor(
  client: PoolClient, source: 'mdv_booking' | 'mdv_airbnb', externalId: string,
): Promise<string | null> {
  for (const kind of ['property', 'listing', 'room'] as const) {
    const hit = await lookupAlias(client, { source, kind, externalId })
    if (hit) return hit.entityId
  }
  return null
}

/** A trailing figure per object, one metric name per channel. */
const metric = (channel: string, name: string) => `perf_${channel}_${name}`

async function readPerformance(
  client: PoolClient, mdv: MdvClient, asOf: string,
  path: string, source: 'mdv_booking' | 'mdv_airbnb',
  breakdownKey: 'property_breakdown' | 'listing_breakdown',
  idKey: 'property_id' | 'listing_id',
  countryKey: 'top_countries' | 'top_guest_locations',
): Promise<PerformanceEndpoint> {
  const channel = source === 'mdv_booking' ? 'booking' : 'airbnb'
  const out: PerformanceEndpoint = {
    path, status: 'ok', matched: 0, unresolvedIds: [], snapshotRows: 0,
    insightRows: 0, compareYoy: null, units: {}, currencies: [],
    vendorClaim: null, note: '',
  }
  let body: unknown
  try {
    // 365 days: the widest window the endpoint documents, and the only one where
    // a year-on-year comparison is even possible.
    body = await mdv.get<unknown>(client, path, { days_back: 365, compare_yoy: 'true' })
  } catch (err) {
    const status = err instanceof MdvError && err.status ? err.status : 0
    return { ...out, status: status || 'ok',
             note: `the endpoint did not answer: ${(err as Error).message}` }
  }
  await recordShape(client, 'mdv', `GET ${path}`, [body], 'performance pass')
  if (!body || typeof body !== 'object') {
    return { ...out, note: 'the response was not an object' }
  }
  const b = body as Record<string, unknown>

  const compareYoy = typeof at(b, 'period_info.compare_yoy') === 'boolean'
    ? at(b, 'period_info.compare_yoy') as boolean : null
  const periodStart = isoDate(at(b, 'period_info.current_start'))
  const periodEnd = isoDate(at(b, 'period_info.current_end'))
  const observedAt = typeof b.data_as_of === 'string' ? b.data_as_of : null
  const reservations = countOf(at(b, 'reservations.current'))

  /* ------------------------------------------------- per object: rank and more */

  const snapshots: SnapshotRow[] = []
  const unresolved = new Set<string>()
  const rows = Array.isArray(b[breakdownKey]) ? b[breakdownKey] as unknown[] : []
  const currencies = new Set<string>()
  let ranks = 0

  for (const raw of rows) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const externalId = String(row[idKey] ?? '').trim()
    if (!externalId) continue
    const entityId = await entityFor(client, source, externalId)
    if (!entityId) { unresolved.add(externalId); continue }

    /**
     * The CURRENCY goes into the metric name, and this is the third time the same
     * lesson has been paid for.
     *
     * `snapshot`'s primary key is (entity_id, metric, stay_date, as_of_date). It
     * has no source column — which is why the channel is in the name — and it has
     * no currency column either. Three currencies under one metric name are three
     * rows with the same key: Postgres refused the batch outright rather than
     * silently keeping the last one, which is the only reason this was caught
     * before a live run.
     *
     * The `currency` column is still filled, because the page needs it to format
     * the figure. It just cannot be what keeps the rows apart.
     */
    const put = (name: string, value: number | null, currency?: string) => {
      if (value === null) return
      const suffix = currency ? `_${currency.toLowerCase()}` : ''
      snapshots.push({ entityId, metric: metric(channel, name) + suffix, stayDate: asOf,
                       value, currency, source, observedAt: observedAt ?? undefined })
    }
    // Plain scalars with a current and a comparison.
    for (const [key, name] of [['nights', 'nights'], ['reservations', 'reservations'],
                               ['avg_los', 'avg_los'], ['rank', 'rank']] as const) {
      const node = row[key]
      if (!node || typeof node !== 'object') continue
      put(name, countOf((node as Record<string, unknown>).current))
      put(`${name}_prior`, countOf((node as Record<string, unknown>).comparison))
      if (key === 'rank') ranks++
    }
    /**
     * How far the rank has moved since the account started being measured — a
     * separate fact from the period-on-period change, and the more useful one.
     *
     * SIGNED, deliberately. `countOf` refuses negatives because a provider sends
     * -1 where it has no answer, but here -7 means the rank improved by seven
     * places: for a rank, lower is better, so the good direction is the negative
     * one. Refusing it would drop exactly the good news.
     */
    put('rank_change_since_first', signedOf(row.rank_change_since_first))

    /**
     * Money arrives PER CURRENCY, as an array. Each currency becomes its own row
     * — `snapshot` has a currency column precisely so this is possible. Summing
     * CHF, EUR and IDR would produce a number in no currency at all, which is the
     * single easiest way to put a confident nonsense figure on a dashboard.
     */
    for (const [key, name] of [['adr', 'adr'], ['revenue', 'revenue']] as const) {
      const arr = Array.isArray(row[key]) ? row[key] as unknown[] : []
      for (const entry of arr) {
        if (!entry || typeof entry !== 'object') continue
        const en = entry as Record<string, unknown>
        const cur = typeof en.currency === 'string' ? en.currency : undefined
        if (cur) currencies.add(cur)
        put(name, countOf(en.current), cur)
        put(`${name}_prior`, countOf(en.comparison), cur)
      }
    }
  }
  const written = await writeSnapshots(client, asOf, snapshots)

  /* --------------------------------------------- account level: the environment */

  let insightRows = 0
  const units: Record<string, Unit> = {}

  for (const [node, section] of [['duration_breakdown', 'duration'],
                                 ['group_size_breakdown', 'group_size']] as const) {
    const cur = at(b, `insights.current.${node}`)
    const cmp = at(b, `insights.comparison.${node}`)
    if (!cur || typeof cur !== 'object') continue
    const entries = Object.entries(cur as Record<string, unknown>)
      .map(([label, v]) => [label, countOf(v)] as const)
      .filter((e): e is readonly [string, number] => e[1] !== null)
    if (!entries.length) continue
    const unit = unitOfBreakdown(entries.map(e => e[1]), reservations)
    units[section] = unit
    for (const [label, value] of entries) {
      insightRows += await putInsight(client, {
        source, section, label, value,
        comparison: cmp && typeof cmp === 'object'
          ? countOf((cmp as Record<string, unknown>)[label]) : null,
        unit, compareYoy, periodStart, periodEnd, observedAt, asOf,
      })
    }
  }

  /**
   * Where the guests came from, ten deep, with the comparison period beside it.
   *
   * This is the SEARCH-and-book side as the channel counts it, and it sits next to
   * the origin mix we derive from our own reservations. The two answer different
   * questions and the page must not merge them: ours is who paid us, this is who
   * the channel says arrived.
   */
  const countryList = at(b, `insights.current.${countryKey}`)
  const countryPrior = at(b, `insights.comparison.${countryKey}`)
  if (Array.isArray(countryList)) {
    const prior = new Map<string, number>()
    if (Array.isArray(countryPrior)) {
      for (const e of countryPrior) {
        if (!e || typeof e !== 'object') continue
        const en = e as Record<string, unknown>
        const c = typeof en.country === 'string' ? en.country.toUpperCase() : null
        const n = countOf(en.count)
        if (c && n !== null) prior.set(c, n)
      }
    }
    units.country = 'count'
    for (const e of countryList) {
      if (!e || typeof e !== 'object') continue
      const en = e as Record<string, unknown>
      const c = typeof en.country === 'string' ? en.country.toUpperCase() : null
      const n = countOf(en.count)
      if (!c || n === null) continue
      insightRows += await putInsight(client, {
        source, section: 'country', label: c, value: n,
        comparison: prior.get(c) ?? null, unit: 'count',
        compareYoy, periodStart, periodEnd, observedAt, asOf,
      })
    }
  }

  const cancel = countOf(at(b, 'insights.current.cancellation_rate'))
  if (cancel !== null) {
    units.rate = 'rate'
    insightRows += await putInsight(client, {
      source, section: 'rate', label: 'cancellation',
      value: cancel, comparison: countOf(at(b, 'insights.comparison.cancellation_rate')),
      unit: 'rate', compareYoy, periodStart, periodEnd, observedAt, asOf,
    })
  }

  /**
   * The portfolio's rank percentile per day, with the sampling basis the provider
   * used. Kept per date because a rank that moved is the finding, and a single
   * average hides exactly that.
   */
  const timeline = at(b, 'ranking_timeline.daily_ranks')
  if (Array.isArray(timeline)) {
    units.rank_timeline = 'percentile'
    for (const e of timeline) {
      if (!e || typeof e !== 'object') continue
      const en = e as Record<string, unknown>
      const d = isoDate(en.date)
      const p = countOf(en.rank_percentile)
      if (!d || p === null) continue
      insightRows += await putInsight(client, {
        source, section: 'rank_timeline', label: d, value: p, comparison: null,
        unit: 'percentile', compareYoy, periodStart, periodEnd, observedAt, asOf,
      })
    }
  }

  /**
   * `mydata_summary` is the PROVIDER'S claim about its own effect: reservations
   * and revenue before and after their implementation. It is recorded in the
   * report and deliberately not stored or displayed.
   *
   * Not because it is untrue — because it is a vendor's self-assessment of a
   * vendor's product, with no control arm, and putting it on our page would turn
   * it into our finding. This engine has a holdout design precisely so effect
   * claims can be made properly. Until that runs, the honest place for someone
   * else's before-and-after is a line in a log.
   */
  const before = countOf(at(b, 'mydata_summary.before_reservations'))
  const now = countOf(at(b, 'mydata_summary.current_reservations'))
  const vendorClaim = before !== null && now !== null
    ? `provider reports ${before} reservations before its implementation and ${now} `
      + `after, over ${countOf(at(b, 'mydata_summary.days_since_implementation')) ?? '?'} `
      + `days — recorded, not displayed: a vendor's own before-and-after has no control arm`
    : null

  const notes: string[] = []
  notes.push(compareYoy === null ? 'the payload does not say what the comparison is'
    : compareYoy ? 'comparison is the same period one year earlier'
    : 'comparison is the immediately preceding period, NOT last year')
  if (unresolved.size) notes.push(`${unresolved.size} id(s) matched nothing`)
  const undecidable = Object.entries(units).filter(([, u]) => u === 'undecidable')
  if (undecidable.length) {
    notes.push(`stored but not charted, unit undecidable: ${
      undecidable.map(([k]) => k).join(', ')}`)
  }
  if (currencies.size > 1) {
    notes.push(`${currencies.size} currencies kept apart: ${[...currencies].sort().join(', ')}`)
  }
  return {
    ...out, matched: new Set(snapshots.map(s => s.entityId)).size,
    unresolvedIds: [...unresolved].slice(0, 20), snapshotRows: written,
    insightRows, compareYoy, units, currencies: [...currencies].sort(),
    vendorClaim, note: notes.join('; '),
  }
}

export async function importPerformance(
  client: PoolClient, mdv: MdvClient,
): Promise<PerformanceReport> {
  const asOf = today()
  const endpoints = [
    await readPerformance(client, mdv, asOf, '/booking/performance/', 'mdv_booking',
                          'property_breakdown', 'property_id', 'top_countries'),
    await readPerformance(client, mdv, asOf, '/airbnb/performance/', 'mdv_airbnb',
                          'listing_breakdown', 'listing_id', 'top_guest_locations'),
  ]
  return {
    kind: 'mdv-performance', asOf, endpoints,
    ranksWritten: endpoints.reduce((n, e) => n + e.snapshotRows, 0),
  }
}
