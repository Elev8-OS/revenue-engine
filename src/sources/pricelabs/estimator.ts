/**
 * The cohort benchmark — the only genuinely market-level source in the system.
 *
 * Every other market number we hold is attached to one listing: PriceLabs'
 * `market_level` grid is that listing's own neighbourhood, MDV's compset is that
 * property's chosen rivals. Useful, but they cannot answer "what does a
 * two-bedroom in this market earn", because they are not about a cohort — they
 * are about a neighbour set that differs per object.
 *
 * The Revenue Estimator is addressed differently: a coordinate, a bedroom count,
 * a currency. That is a cohort question, and its answer is the row
 * `snapshot_market` was created to hold.
 *
 * FOUR THINGS THIS FILE REFUSES TO GUESS:
 *
 *   1. IT IS A DIFFERENT KEY. The specification says so in as many words: "Your
 *      Revenue Estimator API key. This is different from the Customer API key."
 *      So it gets its own variable and its own client, and a missing one is a
 *      stage that did not run rather than a stage that failed.
 *
 *   2. THE MONTH KEY FORMAT IS UNDOCUMENTED. `MonthlyBreakup.Revenue50Percentile`
 *      is an object of month → number and the specification says nothing about
 *      what a month looks like. '2026-09', 'Sep 2026' and '9' are all plausible.
 *      Keys that parse as a real month are used; the rest are reported by name,
 *      because a month misread as a date is a series silently shifted by a year.
 *
 *   3. AN OCCUPANCY BAND IS NOT A BEDROOM COUNT. The endpoint requires
 *      `bedroom_category` as an integer. A cohort banded on sleeping capacity —
 *      'sleeps 3-4', the documented fallback when the room feature is unused —
 *      has no such number, and inventing one would put a four-sleeper studio in
 *      the two-bedroom market. Those cohorts are skipped and counted.
 *
 *   4. ONE COORDINATE STANDS FOR A COHORT, AND IT IS RECORDED. A market panel is
 *      only as local as the point it was measured at. The sampled listing's id
 *      goes on every row, so "Bali, 2BR" can always be traced to the coordinate
 *      it was asked from — and two panels measured from opposite ends of an
 *      island are visibly different claims rather than one contradictory series.
 */
import type { PoolClient } from 'pg'
import { writeMarketSnapshots, type MarketSnapshotRow } from '../../snapshot/write.js'
import { recordShape } from '../elev8/shape.js'
import { PriceLabsClient, plain, keepSpecimen, PriceLabsBlockedError } from './client.js'

export interface EstimatorCohort {
  market: string
  band: string
  bedrooms: number
  entityId: string
  lat: number
  lng: number
}

export interface EstimatorReport {
  cohorts: number
  fetched: number
  failed: number
  /** Bands with no bedroom number to ask with. Skipped, never approximated. */
  notBedroomBanded: number
  /** Cohorts with no coordinate on any listing. */
  noCoordinate: number
  rowsWritten: number
  monthlyRows: number
  /** Month keys we could not read as a month. Named rather than dropped. */
  unreadableMonthKeys: string[]
  blocked: string | null
  firstError: string | null
}

/** '2BR' → 2, '5BR+' → 5, 'sleeps 3-4' → null. */
export function bedroomsFromBand(band: string | null | undefined): number | null {
  const m = /^(\d+)BR\+?$/.exec((band ?? '').trim())
  if (!m) return null
  const n = Number(m[1])
  return Number.isInteger(n) && n >= 0 ? n : null
}

/**
 * A month key to the first day of that month, or null.
 *
 * Accepts the two forms a JSON month key realistically takes — '2026-09' and
 * '2026-09-01' — and nothing else. 'Sep 2026' is deliberately NOT parsed: a
 * month name has no year unless the payload happens to carry one, and
 * `Date.parse` will happily invent the current year for it.
 */
export function monthStart(key: string): string | null {
  const m = /^(\d{4})-(\d{2})(?:-\d{2})?$/.exec(key.trim())
  if (!m) return null
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  return `${m[1]}-${m[2]}-01`
}

/**
 * The cohorts worth asking about, one representative coordinate each.
 *
 * `order by id` rather than "the nearest to the centre" or "the biggest": the
 * point is that two runs a week apart sample the SAME listing, so a change in
 * the series is a change in the market rather than a change in where we stood.
 */
export async function cohortsToSample(db: PoolClient): Promise<{
  cohorts: EstimatorCohort[], notBedroomBanded: number, noCoordinate: number
}> {
  const { rows } = await db.query<{
    market: string, band: string, entity_id: string | null,
    latitude: string | null, longitude: string | null, n: number
  }>(`select market::text as market, band,
             (array_agg(id order by id))[1]::text as entity_id,
             (array_agg(latitude order by id) filter (where latitude is not null))[1] as latitude,
             (array_agg(longitude order by id) filter (where longitude is not null))[1] as longitude,
             count(*)::int as n
        from entity
       where active and band is not null
       group by market, band
       order by market, band`)

  const cohorts: EstimatorCohort[] = []
  let notBedroomBanded = 0
  let noCoordinate = 0
  for (const r of rows) {
    const bedrooms = bedroomsFromBand(r.band)
    if (bedrooms === null) { notBedroomBanded++; continue }
    const lat = r.latitude === null ? null : Number(r.latitude)
    const lng = r.longitude === null ? null : Number(r.longitude)
    if (lat === null || lng === null || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      noCoordinate++
      continue
    }
    cohorts.push({ market: r.market, band: r.band, bedrooms,
                   entityId: r.entity_id!, lat, lng })
  }
  return { cohorts, notBedroomBanded, noCoordinate }
}

interface CategoryKpis {
  RevenueMonthlyAvg?: number
  Revenue50PercentileSum?: number
  Revenue25PercentileSum?: number
  Revenue75PercentileSum?: number
  ADR50PercentileAvg?: number
  ADR25PercentileAvg?: number
  ADR75PercentileAvg?: number
  AvgAdjustedOccupancy?: number
  NoOfListings?: number
  MonthlyBreakup?: Record<string, Record<string, number> | undefined>
  bedrooms_considered?: string[]
  [k: string]: unknown
}

/**
 * The aggregate row set. Names carry the statistic AND that it is a total or an
 * average over the whole horizon, so a monthly value and a yearly one can never
 * collide on the same key — which they would if the run happened to fall on the
 * first of a month.
 */
const AGGREGATES: Array<{ field: keyof CategoryKpis, metric: string, money: boolean }> = [
  { field: 'Revenue50PercentileSum', metric: 'market_revenue_p50_total', money: true },
  { field: 'Revenue25PercentileSum', metric: 'market_revenue_p25_total', money: true },
  { field: 'Revenue75PercentileSum', metric: 'market_revenue_p75_total', money: true },
  { field: 'RevenueMonthlyAvg', metric: 'market_revenue_monthly_avg', money: true },
  { field: 'ADR50PercentileAvg', metric: 'market_adr_p50_avg', money: true },
  { field: 'ADR25PercentileAvg', metric: 'market_adr_p25_avg', money: true },
  { field: 'ADR75PercentileAvg', metric: 'market_adr_p75_avg', money: true },
  { field: 'AvgAdjustedOccupancy', metric: 'market_occupancy_avg', money: false },
  { field: 'NoOfListings', metric: 'market_listings_total', money: false },
]

/** MonthlyBreakup sub-object → metric name. */
const MONTHLY: Record<string, { metric: string, money: boolean }> = {
  Revenue50Percentile: { metric: 'market_revenue_p50', money: true },
  Revenue25Percentile: { metric: 'market_revenue_p25', money: true },
  Revenue75Percentile: { metric: 'market_revenue_p75', money: true },
  ADR50Percentile: { metric: 'market_adr_p50', money: true },
  ADR25Percentile: { metric: 'market_adr_p25', money: true },
  ADR75Percentile: { metric: 'market_adr_p75', money: true },
  AvgOccupancy: { metric: 'market_occupancy', money: false },
  Occ25Percentile: { metric: 'market_occupancy_p25', money: false },
  Occ75Percentile: { metric: 'market_occupancy_p75', money: false },
  NoListingUsed: { metric: 'market_listings', money: false },
}

export async function importPriceLabsMarket(
  db: PoolClient, api: PriceLabsClient, currency: string, asOf: string,
): Promise<EstimatorReport> {
  const { cohorts, notBedroomBanded, noCoordinate } = await cohortsToSample(db)
  const report: EstimatorReport = {
    cohorts: cohorts.length, fetched: 0, failed: 0, notBedroomBanded, noCoordinate,
    rowsWritten: 0, monthlyRows: 0, unreadableMonthKeys: [], blocked: null, firstError: null,
  }
  const badKeys = new Set<string>()
  const samples: unknown[] = []
  let specimenKept = false

  for (const cohort of cohorts) {
    try {
      const body = await api.get<{ KPIsByBedroomCategory?: Record<string, CategoryKpis> }>(
        '/v2/revenue/estimator',
        { lat: cohort.lat, lng: cohort.lng, currency,
          bedroom_category: cohort.bedrooms, monthly: true },
        'pricelabs_market')

      if (!specimenKept) {
        await keepSpecimen(db, 'GET /v2/revenue/estimator',
                           `${cohort.market}/${cohort.band}`, body)
        specimenKept = true
      }
      samples.push(body)

      const categories = body?.KPIsByBedroomCategory ?? {}
      // The v2 response is keyed by the bedroom count that was asked for. Read
      // by key where the key is there, and fall back to the single entry only
      // when there is exactly one — never to "the first", which would silently
      // take a neighbouring bedroom category's numbers.
      const keys = Object.keys(categories)
      const kpis = categories[String(cohort.bedrooms)]
        ?? (keys.length === 1 ? categories[keys[0]!] : undefined)
      if (!kpis) { report.failed++; continue }
      report.fetched++

      const rows: MarketSnapshotRow[] = []
      const base = { market: cohort.market, band: cohort.band }
      for (const agg of AGGREGATES) {
        const value = plain(kpis[agg.field])
        if (value === null) continue
        rows.push({ ...base, metric: agg.metric, stayDate: asOf, value,
                    ...(agg.money ? { currency } : {}) })
      }

      for (const [group, spec] of Object.entries(MONTHLY)) {
        const series = kpis.MonthlyBreakup?.[group]
        if (!series || typeof series !== 'object') continue
        for (const [key, raw] of Object.entries(series)) {
          const stayDate = monthStart(key)
          if (!stayDate) { badKeys.add(key); continue }
          const value = plain(raw)
          if (value === null) continue
          rows.push({ ...base, metric: spec.metric, stayDate, value,
                      ...(spec.money ? { currency } : {}) })
          report.monthlyRows++
        }
      }

      const written = await writeMarketSnapshots(db, asOf, rows)
      report.rowsWritten += written
      // Attribution, applied after the write because it is the same key set and
      // a second column on the same rows. Without it a cohort panel cannot be
      // traced back to the coordinate it was measured from.
      if (written) {
        await db.query(
          `update snapshot_market set sampled_entity_id = $3,
                  sampled_from = 'pricelabs_revenue_estimator'
            where market = $1::market and band = $2 and as_of_date = $4::date`,
          [cohort.market, cohort.band, cohort.entityId, asOf])
      }
    } catch (err) {
      if (err instanceof PriceLabsBlockedError) {
        // The same key answers for every cohort, so one refusal settles all of
        // them. Asking eleven more times would spend a rate limit to be told
        // the same thing eleven times.
        report.blocked = `${err.blocked}: ${err.message}`
        break
      }
      report.failed++
      if (!report.firstError) report.firstError = (err as Error).message
    }
  }

  if (samples.length) {
    await recordShape(db, 'pricelabs', 'GET /v2/revenue/estimator', samples,
      `${samples.length} cohort(s), currency ${currency}`)
  }
  report.unreadableMonthKeys = [...badKeys].sort()
  return report
}
