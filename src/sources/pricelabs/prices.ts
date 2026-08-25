/**
 * The forward price calendar, archived nightly.
 *
 * This is the stage the archive was built for. PriceLabs will tell you what it
 * recommends for the next ninety nights TODAY, and it will tell you the same
 * thing tomorrow — but it will never tell you what it said yesterday. Pickup,
 * pace, and any "did the change work" question are computable only from our own
 * dated copies, and no amount of later effort can recover a night we did not
 * write down. So this runs whether or not anything reads it yet.
 *
 * Batched, because the request takes a LIST of listings and the alternative is
 * 62 round trips against a rate limit the provider declines to document. The
 * batch size is a guess and is labelled as one: too large risks a timeout on a
 * response that is a couple of hundred kilobytes a listing, too small wastes the
 * one thing the endpoint does better than the others.
 */
import type { PoolClient } from 'pg'
import { writeSnapshots, recordFreshness, type SnapshotRow } from '../../snapshot/write.js'
import { recordShape } from '../elev8/shape.js'
import { PriceLabsClient, plain, keepSpecimen } from './client.js'
import type { ResolvedListing } from './listings.js'

/** Nights ahead. Ninety is where PriceLabs' own demand signal thins out. */
export const HORIZON_DAYS = 90
/** A guess bounded by an undocumented limit, not a measured optimum. */
export const BATCH = 8

export interface PriceRow {
  date?: string
  price?: number
  user_price?: number
  uncustomized_price?: number
  min_stay?: number
  ADR?: number
  unbookable?: number
  booking_status?: string
  demand_desc?: string
  [k: string]: unknown
}

export interface PriceListingResponse {
  id?: string
  pms?: string
  currency?: string
  last_refreshed_at?: string
  error?: string
  error_status?: string
  data?: PriceRow[]
  [k: string]: unknown
}

export interface PricesReport {
  requested: number
  answered: number
  /** A listing-level failure inside a 200 response. Counted by what it said. */
  listingErrors: Array<{ listing: string, status: string }>
  nights: number
  rowsWritten: number
  /** `user_price` is -1 wherever nothing is live. Withheld, not written as -1. */
  noLivePrice: number
  /**
   * Vocabularies we do not know yet, discovered by looking rather than guessing.
   * `booking_status` came back as an empty string on every night measured, so
   * whether it says "booked" or "reserved" or something else is still unknown —
   * and a mapper that assumed one of them would have been wrong silently.
   */
  bookingStatuses: string[]
  demandLabels: string[]
  /**
   * `occupancy` is present in the live payload and absent from the documented
   * schema, and on a night whose demand reads "Unavailable" it was 1. That could
   * mean the night is taken or it could mean the neighbourhood is busy; the two
   * lead to opposite findings. Counted, never mapped.
   */
  occupancyFieldSeen: number
}

const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/** ISO date n days from the given day, in UTC. Dates here are calendar days. */
export function dayPlus(from: string, days: number): string {
  const d = new Date(`${from}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * The mapped set, and only the mapped set.
 *
 * Five metrics out of a payload with twenty fields, because the other fifteen
 * are either a sentinel, a colour, a label whose vocabulary is unknown, or a
 * field that is not in the documentation at all. Every one of them is recorded
 * as a shape and counted in the report, so the next person to want one can see
 * whether it is worth having before writing a line of code against it.
 */
export function rowsFor(
  entityId: string, night: PriceRow, currency: string | null, observedAt?: string,
): SnapshotRow[] {
  const stayDate = typeof night.date === 'string' ? night.date.slice(0, 10) : ''
  if (!/^\d{4}-\d{2}-\d{2}$/.test(stayDate)) return []

  const out: SnapshotRow[] = []
  const put = (metric: string, value: number | null, withCurrency = true) => {
    if (value === null) return
    out.push({
      entityId, metric, stayDate, value, source: 'pricelabs',
      ...(withCurrency && currency ? { currency } : {}),
      ...(observedAt ? { observedAt } : {}),
    })
  }

  put('price_recommended', plain(night.price))
  put('price_uncustomized', plain(night.uncustomized_price))
  // -1 means nothing is live for this night. Writing it would put a negative
  // franc on a page; writing zero would say the night is free.
  put('price_current', plain(night.user_price))
  put('adr_booked', plain(night.ADR))
  put('min_stay', plain(night.min_stay), false)
  // 0 and 1 are both real answers here, which is why it survives `plain()`.
  put('unbookable', plain(night.unbookable), false)
  return out
}

export async function importPriceLabsPrices(
  db: PoolClient, api: PriceLabsClient, listings: ResolvedListing[], asOf: string,
): Promise<PricesReport> {
  const report: PricesReport = {
    requested: listings.length, answered: 0, listingErrors: [], nights: 0,
    rowsWritten: 0, noLivePrice: 0, bookingStatuses: [], demandLabels: [],
    occupancyFieldSeen: 0,
  }
  if (!listings.length) return report

  const byId = new Map(listings.map(l => [l.listingId, l]))
  const statuses = new Set<string>()
  const labels = new Set<string>()
  const allNights: unknown[] = []
  let specimenKept = false

  const dateFrom = asOf
  const dateTo = dayPlus(asOf, HORIZON_DAYS)

  for (const group of chunk(listings, BATCH)) {
    const body = await api.post<PriceListingResponse[]>('/v1/listing_prices', {
      listings: group.map(l => ({ id: l.listingId, pms: l.pms, dateFrom, dateTo })),
    })
    const answers = Array.isArray(body) ? body : []

    if (!specimenKept && answers.length) {
      await keepSpecimen(db, 'POST /v1/listing_prices', answers[0]?.id ?? null, answers[0])
      specimenKept = true
    }

    for (const answer of answers) {
      const listing = answer.id ? byId.get(answer.id) : undefined
      if (!listing) continue

      // A 200 that carries an error for one listing is not a successful read of
      // that listing, and counting it as one is how a portfolio reports full
      // coverage over a hole.
      if (answer.error || answer.error_status) {
        report.listingErrors.push({
          listing: listing.label,
          status: String(answer.error_status ?? answer.error).slice(0, 120),
        })
        await recordFreshness(db, 'pricelabs', 'prices', listing.entityId, null, 'error',
                              String(answer.error_status ?? answer.error).slice(0, 200))
        continue
      }

      const nights = Array.isArray(answer.data) ? answer.data : []
      report.answered++
      report.nights += nights.length
      allNights.push(...nights)

      const rows: SnapshotRow[] = []
      for (const night of nights) {
        if (typeof night.booking_status === 'string') statuses.add(night.booking_status)
        if (typeof night.demand_desc === 'string') labels.add(night.demand_desc)
        if ('occupancy' in night) report.occupancyFieldSeen++
        if (plain(night.user_price) === null) report.noLivePrice++
        rows.push(...rowsFor(listing.entityId, night,
                            answer.currency ?? listing.currency, answer.last_refreshed_at))
      }
      report.rowsWritten += await writeSnapshots(db, asOf, rows)
      await recordFreshness(db, 'pricelabs', 'prices', listing.entityId,
                            answer.last_refreshed_at ?? null, 'ok', null)
    }
  }

  await recordShape(db, 'pricelabs', 'POST /v1/listing_prices', allNights,
    `${report.answered} of ${report.requested} listing(s), ${dateFrom} to ${dateTo}`)

  // Sorted so the report reads the same twice and a new value is visible as a
  // change rather than as a reordering.
  report.bookingStatuses = [...statuses].sort()
  report.demandLabels = [...labels].sort()
  return report
}
