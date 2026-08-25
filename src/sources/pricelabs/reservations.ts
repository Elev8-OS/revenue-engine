/**
 * Realised bookings — the only place in this system where money is a fact
 * rather than a forecast.
 *
 * Everything else PriceLabs gives us is forward-looking: a recommended price, an
 * expected occupancy, a market average. `/v1/reservation_data` is what actually
 * happened, per reservation, with the commission on it. That is the input the
 * margin basis has been missing: a gross figure minus a stated OTA commission
 * minus a confirmed cleaning cost is a margin somebody can defend, and two of
 * those three arrive here.
 *
 * It is also the one endpoint documented to return 403 to a valid key. So a
 * refusal here is a NAMED state that the readiness page can explain — "this key
 * may not read reservations" — rather than a red failure that looks like the
 * integration is broken. The distinction matters because the two need opposite
 * responses: one is a support request to PriceLabs, the other is a bug in here.
 *
 * WHAT IS DELIBERATELY NOT MAPPED: `total_cost`. It sits beside `rental_revenue`
 * with no statement of whose cost it is — the guest's total, or ours. Those are
 * opposite sides of the same booking and guessing would corrupt the margin this
 * stage exists to make possible. Counted in the report, left in the specimen.
 */
import type { PoolClient } from 'pg'
import { lookupAlias } from '../../entity/resolve.js'
import { recordFreshness } from '../../snapshot/write.js'
import { recordShape } from '../elev8/shape.js'
import { PriceLabsClient, plain, keepSpecimen, PriceLabsBlockedError } from './client.js'

/** Days either side of today. A booking window, not a full history. */
export const WINDOW_DAYS = 180
export const PAGE = 200
/** A loop bound, not a belief about the account size. */
export const MAX_PAGES = 25

export interface ReservationRow {
  listing_id?: string
  listing_name?: string
  reservation_id?: string
  check_in?: string
  check_out?: string
  booking_status?: string
  booked_date?: string
  rental_revenue?: number
  total_cost?: number
  no_of_days?: number
  currency?: string
  cancelled_on?: string
  booking_channel?: string
  guest_count?: number
  ota_commission?: number
  [k: string]: unknown
}

export interface ReservationsReport {
  pages: number
  seen: number
  written: number
  /** Reservations for a listing we do not hold. Named, not silently dropped. */
  unknownListing: number
  /** No usable revenue figure — kept out rather than written as zero. */
  noRevenue: number
  cancelled: number
  withCommission: number
  /** `total_cost` is present and unmapped, on purpose. Counted so it is visible. */
  totalCostSeen: number
  /** The raw channel strings seen, so the enum mapping stays auditable. */
  channels: string[]
  unmappedChannels: string[]
  blocked: string | null
  firstError: string | null
}

/**
 * PriceLabs sends a channel as free text; our column is an enum of four.
 *
 * The mapping is by substring because the same channel arrives as
 * 'Booking.com', 'BookingCom' and 'booking' depending on the PMS, and an exact
 * table would silently send all three to 'other'. Anything unrecognised becomes
 * 'other' AND is reported by name — the second half is what stops 'other' from
 * quietly absorbing a channel worth its own row.
 */
export function channelOf(raw: string | undefined): {
  channel: 'booking' | 'airbnb' | 'direct' | 'other', known: boolean
} {
  const s = (raw ?? '').trim().toLowerCase()
  if (!s) return { channel: 'other', known: false }
  if (s.includes('booking')) return { channel: 'booking', known: true }
  if (s.includes('airbnb')) return { channel: 'airbnb', known: true }
  if (s.includes('direct') || s.includes('website') || s.includes('manual')) {
    return { channel: 'direct', known: true }
  }
  return { channel: 'other', known: false }
}

const day = (v: unknown): string | null => {
  if (typeof v !== 'string') return null
  const d = v.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
}

/** Nights, from the stated count where there is one and from the dates where not. */
export function nightsOf(row: ReservationRow): number | null {
  const stated = plain(row.no_of_days)
  if (stated !== null && stated >= 1) return Math.round(stated)
  const from = day(row.check_in)
  const to = day(row.check_out)
  if (!from || !to) return null
  const n = Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000)
  return n >= 1 ? n : null
}

export async function importPriceLabsReservations(
  db: PoolClient, api: PriceLabsClient, pms: string, asOf: string,
): Promise<ReservationsReport> {
  const report: ReservationsReport = {
    pages: 0, seen: 0, written: 0, unknownListing: 0, noRevenue: 0, cancelled: 0,
    withCommission: 0, totalCostSeen: 0, channels: [], unmappedChannels: [],
    blocked: null, firstError: null,
  }
  const channels = new Set<string>()
  const unmapped = new Set<string>()
  const samples: unknown[] = []
  let specimenKept = false

  const start = new Date(`${asOf}T00:00:00Z`)
  start.setUTCDate(start.getUTCDate() - WINDOW_DAYS)
  const end = new Date(`${asOf}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + WINDOW_DAYS)

  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await api.get<{
        pms_name?: string, next_page?: boolean, data?: ReservationRow[]
      }>('/v1/reservation_data', {
        pms,
        start_date: start.toISOString().slice(0, 10),
        end_date: end.toISOString().slice(0, 10),
        limit: PAGE, offset: page * PAGE,
      })
      report.pages++
      const rows = Array.isArray(body?.data) ? body.data : []
      if (!specimenKept && rows.length) {
        await keepSpecimen(db, 'GET /v1/reservation_data', rows[0]?.reservation_id ?? null, body)
        specimenKept = true
      }
      samples.push(...rows)

      for (const row of rows) {
        report.seen++
        const listingId = row.listing_id?.trim()
        const reservationId = row.reservation_id?.trim()
        if (!listingId || !reservationId) { report.unknownListing++; continue }

        // lookupAlias, not resolve: by this point the listings stage has aliased
        // everything it could place, so a miss here is a reservation for a
        // listing PriceLabs knows and we do not — already recorded once by that
        // stage, and recording it again per reservation would bury the object
        // list under a hundred copies of the same gap.
        const known = await lookupAlias(db,
          { source: 'pricelabs', kind: 'listing', externalId: listingId })
        if (!known) { report.unknownListing++; continue }

        const gross = plain(row.rental_revenue)
        const nights = nightsOf(row)
        const arrival = day(row.check_in)
        const departure = day(row.check_out)
        const currency = row.currency?.trim()?.toUpperCase()
        if (gross === null || nights === null || !arrival || !departure || !currency) {
          report.noRevenue++
          continue
        }

        const { channel, known: mapped } = channelOf(row.booking_channel)
        if (row.booking_channel?.trim()) {
          channels.add(row.booking_channel.trim())
          if (!mapped) unmapped.add(row.booking_channel.trim())
        }
        const commission = plain(row.ota_commission)
        if (commission !== null) report.withCommission++
        if (plain(row.total_cost) !== null) report.totalCostSeen++
        const cancelled = day(row.cancelled_on)
        if (cancelled) report.cancelled++

        await db.query(
          `insert into booking_economics
             (entity_id, reservation_id, channel, arrival, departure, nights,
              gross_amount, ota_commission, currency, booked_at, status, cancelled_on)
           values ($1, $2, $3::channel, $4::date, $5::date, $6, $7, $8, $9, $10, $11, $12::date)
           on conflict (entity_id, reservation_id) do update set
             channel = excluded.channel, arrival = excluded.arrival,
             departure = excluded.departure, nights = excluded.nights,
             gross_amount = excluded.gross_amount, ota_commission = excluded.ota_commission,
             currency = excluded.currency, booked_at = excluded.booked_at,
             status = excluded.status, cancelled_on = excluded.cancelled_on`,
          [known.entityId, reservationId, channel, arrival, departure, nights,
           gross, commission, currency,
           // '-1' is this provider's string for "no date". Parsed as a date it
           // would be either an error or, worse, something plausible.
           day(row.booked_date), row.booking_status?.trim() || null, cancelled])
        report.written++
      }

      if (!body?.next_page || !rows.length) break
    }
    await recordFreshness(db, 'pricelabs', 'reservations', null, null, 'ok', null)
  } catch (err) {
    if (err instanceof PriceLabsBlockedError) {
      report.blocked = `${err.blocked}: ${err.message}`
      // Recorded as a named state, so the freshness gate treats "not permitted"
      // differently from "we never looked".
      await recordFreshness(db, 'pricelabs', 'reservations', null, null,
                            err.blocked, err.message.slice(0, 200))
    } else {
      report.firstError = (err as Error).message
      await recordFreshness(db, 'pricelabs', 'reservations', null, null, 'error',
                            (err as Error).message.slice(0, 200))
    }
  }

  if (samples.length) {
    await recordShape(db, 'pricelabs', 'GET /v1/reservation_data', samples,
      `${report.pages} page(s), ${WINDOW_DAYS} days either side of ${asOf}`)
  }
  report.channels = [...channels].sort()
  report.unmappedChannels = [...unmapped].sort()
  return report
}
