/**
 * The PriceLabs pass, in the order the dependencies force.
 *
 *   1. LISTINGS first, always. Nothing else can run without the resolved id set:
 *      every other endpoint is addressed by listing id, and an unresolved id is
 *      a listing we must not attach data to. This stage also writes the
 *      coordinates the market stage is addressed by.
 *   2. PRICES, because it is the one stage whose data cannot be recovered later.
 *      Tomorrow's call will not tell us what today's forecast was.
 *   3. METRICS, the listing-against-market grid a finding argues from.
 *   4. NEIGHBOURHOOD, the price distribution around each listing — the micro
 *      layer. Placed after metrics because it is by far the most expensive read
 *      in the account, so a pass that dies here has already stored the two
 *      stages a finding needs.
 *   5. RESERVATIONS, realised money — and the one stage documented to be refused
 *      to a valid key.
 *   6. MARKET, last, because it samples the coordinates stage 1 wrote.
 *
 * A failure in a later stage never discards an earlier one. A pass that archived
 * ninety nights of prices for sixty listings and then found the reservations
 * endpoint closed has done the most valuable part of its job, and reporting that
 * as a single failure would hide it.
 */
import type { PoolClient } from 'pg'
import { PriceLabsClient } from './client.js'
import { importPriceLabsListings, type PriceLabsListingsReport } from './listings.js'
import { importPriceLabsPrices, type PricesReport } from './prices.js'
import { importPriceLabsMetrics, type MetricsReport } from './metrics.js'
import { importPriceLabsReservations, type ReservationsReport } from './reservations.js'
import { importPriceLabsMarket, type EstimatorReport } from './estimator.js'
import { importPriceLabsNeighbourhood, type NeighbourhoodReport } from './neighbourhood.js'

export interface PriceLabsImportReport {
  /**
   * An explicit tag, because the shapes stopped being distinguishable by their
   * keys. The Elev8 report has a `listings` object and so does this one, so the
   * guard that tested for that key would have read every PriceLabs run as an
   * Elev8 run — and shown the wrong three numbers on the import page with no
   * sign anything was wrong.
   */
  kind: 'pricelabs'
  asOf: string
  listings: PriceLabsListingsReport
  prices: PricesReport | null
  metrics: MetricsReport | null
  /** The micro layer: the price distribution of each listing's own neighbourhood. */
  neighbourhood: NeighbourhoodReport | null
  reservations: ReservationsReport | null
  market: EstimatorReport | null
  /** Named so a partial pass is legible rather than looking like a success. */
  stageErrors: string[]
  /** Stages that did not run, and why. Not the same thing as a failure. */
  skipped: string[]
}

export interface PriceLabsRunOptions {
  /** The Revenue Estimator is a separate credential; absent is a skip, not a fail. */
  estimator?: { api: PriceLabsClient, currency: string }
  /** Overridable for tests. The provider's dates are calendar days in UTC. */
  today?: string
}

export async function importPriceLabs(
  db: PoolClient, api: PriceLabsClient, opts: PriceLabsRunOptions = {},
): Promise<PriceLabsImportReport> {
  const asOf = opts.today ?? new Date().toISOString().slice(0, 10)
  const stageErrors: string[] = []
  const skipped: string[] = []

  const { report: listings, resolved } = await importPriceLabsListings(db, api)

  const report: PriceLabsImportReport = {
    kind: 'pricelabs', asOf, listings,
    prices: null, metrics: null, neighbourhood: null, reservations: null, market: null,
    stageErrors, skipped,
  }

  // Every remaining listing-addressed stage needs a resolved id. Zero is not a
  // failure of those stages, it is the listings stage having placed nothing —
  // and saying so is more useful than four empty reports.
  if (!resolved.length) {
    skipped.push('prices, metrics and reservations: no PriceLabs listing resolved to an object')
    return report
  }

  try {
    report.prices = await importPriceLabsPrices(db, api, resolved, asOf)
  } catch (err) {
    stageErrors.push(`prices: ${(err as Error).message}`)
  }

  try {
    report.metrics = await importPriceLabsMetrics(db, api, resolved, asOf)
  } catch (err) {
    stageErrors.push(`metrics: ${(err as Error).message}`)
  }

  try {
    // After metrics because it is by far the most expensive read in the account
    // — roughly 207'000 characters a listing — and a pass that dies here has
    // already stored the calendar and the grid.
    report.neighbourhood = await importPriceLabsNeighbourhood(db, api, resolved, asOf)
  } catch (err) {
    stageErrors.push(`neighbourhood: ${(err as Error).message}`)
  }

  try {
    // One PMS per pass. Measured: all 62 listings on this account are 'channex',
    // and the endpoint takes `pms` as a required scalar rather than a list — so
    // a second PMS would need a second call, and pretending one covers both
    // would report a partial read as a complete one.
    const pmsNames = [...new Set(resolved.map(r => r.pms))]
    for (const pms of pmsNames) {
      const res = await importPriceLabsReservations(db, api, pms, asOf)
      // Reported per PMS would need a shape change; with one PMS in the account
      // the first is the answer, and a second is named as unread rather than
      // quietly overwriting it.
      if (!report.reservations) report.reservations = res
      else skipped.push(`reservations for PMS ${pms}: only the first PMS is read per pass`)
    }
  } catch (err) {
    stageErrors.push(`reservations: ${(err as Error).message}`)
  }

  if (opts.estimator) {
    try {
      report.market = await importPriceLabsMarket(
        db, opts.estimator.api, opts.estimator.currency, asOf)
    } catch (err) {
      stageErrors.push(`market: ${(err as Error).message}`)
    }
  } else {
    skipped.push('market benchmark: PRICELABS_ESTIMATOR_API_KEY is not set '
      + '(a separate key from the Customer API one)')
  }

  return report
}
