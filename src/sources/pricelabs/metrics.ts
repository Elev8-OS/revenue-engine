/**
 * Performance windows, and the market beside them.
 *
 * This is the endpoint that makes a finding possible. Everything else in this
 * system so far describes our own portfolio; `/v1/listing_metrics` returns
 * `listing_level` AND `market_level` for the same metric over the same horizon,
 * already computed against the listing's own comparable set. "Occupancy 63% at
 * 30 days against a market at 30%" is a sentence with evidence on both sides,
 * from one call.
 *
 * Three measured facts shape the mapping, and each one would have been a bug:
 *
 *   1. THE KEYS ARE NOT ALL DAYS. Alongside '7', '30' and '-90' the live payload
 *      carries '995', '997', '998', '-995', '-997', '-998' and '-999'. The
 *      provider documents these only as "days-from-today index"; what a horizon
 *      of 998 days means is not stated anywhere, and the values sit in a
 *      plausible range (998 → 36.7% occupancy). Read as days they would produce
 *      confident numbers about the year 2029. Only real day offsets are mapped;
 *      the rest are named in the report so somebody can ask.
 *
 *   2. NEGATIVE IS A SENTINEL, NOT A QUANTITY. `adr['1'] = -1`,
 *      `revpar['1'] = -1`, `weekend_total_occupancy['1'] = -4`. In the
 *      provider's own formatted view those same cells read "Fully Blocked" and
 *      "Unavailable" — so the number is a code for the absence of a number.
 *
 *   3. `market_level` IS PER LISTING, NOT PER COHORT. It is the market as
 *      PriceLabs computes it for THIS listing's neighbourhood, which is why it
 *      is written per entity and NOT into `snapshot_market` keyed by
 *      (market, band). Two 2-bedroom flats in the same band can sit in different
 *      neighbourhoods; filing both under one cohort row would make whichever
 *      imported last the market for both.
 */
import type { PoolClient } from 'pg'
import { writeSnapshots, recordFreshness, type SnapshotRow } from '../../snapshot/write.js'
import { recordShape } from '../elev8/shape.js'
import { PriceLabsClient, plain, keepSpecimen, PriceLabsBlockedError } from './client.js'
import type { ResolvedListing } from './listings.js'

/**
 * The horizons kept, out of the twenty-odd offered.
 *
 * A deliberate cut, not a limitation: the full grid is fifteen metrics across
 * thirty keys for every listing, which is thirty thousand rows a day to keep a
 * series nobody has asked for. These six are the ones a pricing decision is
 * actually made on — the next week, the next month, the quarter — plus the two
 * trailing windows a claim about a trend needs. The whole grid stays available
 * in the kept specimen.
 */
export const FORWARD = [7, 30, 60, 90] as const
export const TRAILING = [7, 30, 90] as const

/** Metrics taken from `listing_level`, and whether the value is money. */
const LISTING_METRICS: Array<{ key: string, name: string, money: boolean }> = [
  { key: 'occupancy', name: 'occupancy', money: false },
  { key: 'adjusted_occupancy', name: 'adjusted_occupancy', money: false },
  { key: 'adr', name: 'adr', money: true },
  { key: 'revpar', name: 'revpar', money: true },
  { key: 'revenue', name: 'revenue', money: true },
  // Market pricing index: our price against the market's. A ratio, so no
  // currency — and the one metric here that is already a comparison.
  { key: 'mpi', name: 'mpi', money: false },
  { key: 'stly_occupancy', name: 'stly_occupancy', money: false },
  { key: 'stly_adr', name: 'stly_adr', money: true },
  { key: 'stly_revenue', name: 'stly_revenue', money: true },
]

/** Metrics taken from `market_level`. Prefixed, so the side is never in doubt. */
const MARKET_METRICS: Array<{ key: string, name: string, money: boolean }> = [
  { key: 'occupancy', name: 'market_occupancy', money: false },
  { key: 'adjusted_occupancy', name: 'market_adjusted_occupancy', money: false },
  { key: 'adr', name: 'market_adr', money: true },
]

/** Scalars: one number for the listing, no horizon. */
const SCALARS = ['bp_ratio'] as const

export interface MetricsReport {
  attempted: number
  ok: number
  failed: number
  /** The key is valid and may not read this. A state, not a crash. */
  blocked: string | null
  rowsWritten: number
  /** Listings for which PriceLabs returned a market side at all. */
  withMarket: number
  /** Undocumented horizon codes seen. Named so they can be asked about. */
  sentinelKeys: string[]
  /** Horizons we wanted and the payload did not carry. */
  missingHorizons: string[]
  /** Values that were a sentinel rather than a number, and so withheld. */
  sentinelValues: number
  firstError: string | null
}

/**
 * True for a key that is a day offset we can name a horizon after.
 *
 * The bound is 400 rather than 360 so the documented year-ahead window survives
 * a provider that counts inclusively, and the sentinels — the smallest of which
 * is 995 — stay outside it by a wide margin. A tighter bound would be a guess
 * about their arithmetic; a looser one would let 995 in.
 */
export const isDayOffset = (key: string): boolean => {
  const n = Number(key)
  return Number.isInteger(n) && n !== 0 && Math.abs(n) <= 400
}

type Grid = Record<string, unknown>

function readWindow(grid: unknown, key: string): Record<string, unknown> | null {
  if (!grid || typeof grid !== 'object') return null
  const v = (grid as Grid)[key]
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
}

/**
 * Turns one metric grid into snapshot rows.
 *
 * `stayDate` is the run's own date for every row, because these values describe
 * a WINDOW starting today rather than a night. That makes `pickup()` — which
 * pairs one stay date across two observation dates — inapplicable to them by
 * construction, and correctly so: the change in "occupancy over the next 30
 * days" between Monday and Tuesday is a different question, answered by reading
 * the same metric across `as_of_date`. The horizon lives in the metric name so
 * that a query cannot accidentally compare two different windows.
 */
export function gridRows(
  entityId: string, grid: unknown, asOf: string, currency: string | null,
  spec: Array<{ key: string, name: string, money: boolean }>,
  seen: { sentinelKeys: Set<string>, missing: Set<string>, sentinelValues: number },
): SnapshotRow[] {
  const out: SnapshotRow[] = []
  for (const metric of spec) {
    const window = readWindow(grid, metric.key)
    if (!window) { seen.missing.add(metric.key); continue }

    for (const key of Object.keys(window)) {
      if (!isDayOffset(key)) { seen.sentinelKeys.add(key); continue }
    }

    const wanted: Array<{ key: string, name: string }> = [
      ...FORWARD.map(n => ({ key: String(n), name: `${metric.name}_next_${n}d` })),
      ...TRAILING.map(n => ({ key: String(-n), name: `${metric.name}_last_${n}d` })),
    ]
    for (const w of wanted) {
      if (!(w.key in window)) { seen.missing.add(`${metric.key}[${w.key}]`); continue }
      const value = plain(window[w.key])
      if (value === null) { seen.sentinelValues++; continue }
      out.push({
        entityId, metric: w.name, stayDate: asOf, value, source: 'pricelabs',
        ...(metric.money && currency ? { currency } : {}),
      })
    }
  }
  return out
}

export async function importPriceLabsMetrics(
  db: PoolClient, api: PriceLabsClient, listings: ResolvedListing[], asOf: string,
): Promise<MetricsReport> {
  const report: MetricsReport = {
    attempted: 0, ok: 0, failed: 0, blocked: null, rowsWritten: 0, withMarket: 0,
    sentinelKeys: [], missingHorizons: [], sentinelValues: 0, firstError: null,
  }
  const seen = {
    sentinelKeys: new Set<string>(), missing: new Set<string>(), sentinelValues: 0,
  }
  const samples: unknown[] = []
  let specimenKept = false

  for (const listing of listings) {
    report.attempted++
    try {
      const body = await api.get<{ data?: Record<string, unknown> }>('/v1/listing_metrics', {
        listing_id: listing.listingId, pms_name: listing.pms,
      })
      const data = body?.data
      if (!data) { report.failed++; continue }

      if (!specimenKept) {
        await keepSpecimen(db, 'GET /v1/listing_metrics', listing.listingId, body)
        specimenKept = true
      }
      samples.push(data)

      const listingLevel = data.listing_level
      const marketLevel = data.market_level
      const currency = (() => {
        const c = (listingLevel as Grid | undefined)?.currency
        return typeof c === 'string' && c.trim() ? c.trim().toUpperCase() : listing.currency
      })()

      const rows = [
        ...gridRows(listing.entityId, listingLevel, asOf, currency, LISTING_METRICS, seen),
        ...gridRows(listing.entityId, marketLevel, asOf, currency, MARKET_METRICS, seen),
      ]
      if (marketLevel && typeof marketLevel === 'object') report.withMarket++

      for (const name of SCALARS) {
        const value = plain((listingLevel as Grid | undefined)?.[name])
        if (value !== null) {
          rows.push({ entityId: listing.entityId, metric: name, stayDate: asOf,
                      value, source: 'pricelabs' })
        }
      }

      report.rowsWritten += await writeSnapshots(db, asOf, rows)
      await recordFreshness(db, 'pricelabs', 'metrics', listing.entityId, null, 'ok', null)
      report.ok++
    } catch (err) {
      // A role that may not read this endpoint stops the STAGE, not the listing:
      // the answer will be the same for all 62, and asking 61 more times spends
      // a minute of an undocumented rate limit to be refused again.
      if (err instanceof PriceLabsBlockedError) {
        report.blocked = `${err.blocked}: ${err.message}`
        break
      }
      report.failed++
      if (!report.firstError) report.firstError = (err as Error).message
      await recordFreshness(db, 'pricelabs', 'metrics', listing.entityId, null, 'error',
                            (err as Error).message.slice(0, 200))
    }
  }

  if (samples.length) {
    await recordShape(db, 'pricelabs', 'GET /v1/listing_metrics', samples,
      `aggregated over ${samples.length} listing(s)`)
  }

  report.sentinelKeys = [...seen.sentinelKeys].sort((a, b) => Number(a) - Number(b))
  report.missingHorizons = [...seen.missing].sort()
  report.sentinelValues = seen.sentinelValues
  return report
}
