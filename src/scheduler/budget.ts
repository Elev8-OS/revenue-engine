/**
 * The read scheduler's budget.
 *
 * One budget for all sources, not four independent cron jobs, because the
 * limits are wildly different in shape and two of them are undocumented:
 *
 *   PriceLabs  get_listing_neighborhood_market is ~207k characters per listing
 *              with no field and no date filter — about 12 MB for a full pass
 *              over 62 listings. The panel is segmented by market and bedroom
 *              band, so pulling it PER LISTING fetches the same payload many
 *              times: dedupe by (market, band) and the cost nearly vanishes.
 *   Channex    documented ARI limits only: 20 requests/minute overall and
 *              10/minute per property, page size max 100. Reviews and bookings
 *              have NO documented limit, which is an unknown, not a licence.
 *   MDV        120 requests/minute, stated by the provider, with Retry-After on
 *              429. The one documented limit of the four — so it is the one
 *              bucket that is a fact rather than a guess.
 *   Elev8      unknown until the API is connected — treated as the strictest
 *              until measured.
 */

export interface Limit {
  /** Requests per minute, or null when undocumented. */
  perMinute: number | null
  /** Per-entity cap per minute, where the provider states one. */
  perEntityPerMinute?: number
  /** Max page size the provider accepts. */
  maxPageSize?: number
  /** Rough bytes per call, for the byte budget rather than the call budget. */
  approxBytesPerCall?: number
  note: string
}

export const LIMITS: Record<string, Limit> = {
  pricelabs_market: {
    perMinute: null,
    approxBytesPerCall: 207_000,
    note: 'no documented limit; the cost is payload size, so dedupe by market+band',
  },
  pricelabs_other: { perMinute: null, note: 'undocumented; keep conservative' },
  channex_ari: {
    perMinute: 20, perEntityPerMinute: 10, maxPageSize: 100,
    note: 'documented: 20/min overall, 10/min/property',
  },
  channex_read: {
    perMinute: 20, maxPageSize: 100,
    note: 'undocumented for reviews/bookings; borrow the ARI ceiling deliberately',
  },
  // Corrected from an assumed 60 once the provider stated it. Kept as the real
  // ceiling rather than a safety margin, because 429 is handled and honoured:
  // pretending the limit is lower just makes a full pass take twice as long.
  mdv: { perMinute: 120, note: 'documented by the provider: 120/min, honour Retry-After on 429' },
  elev8: { perMinute: 30, note: 'unknown until connected; strictest assumption until measured' },
}

/** Simple token-bucket, one per bucket name. Enough for a single worker. */
export class RateBudget {
  private state = new Map<string, { tokens: number, last: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  /** Waits until a call is permitted, then consumes one. */
  async take(bucket: string, perMinute: number | null): Promise<void> {
    if (perMinute === null) { await sleep(1_000); return } // undocumented: 1/s floor
    const cap = perMinute
    const entry = this.state.get(bucket) ?? { tokens: cap, last: this.now() }
    const elapsedMin = (this.now() - entry.last) / 60_000
    entry.tokens = Math.min(cap, entry.tokens + elapsedMin * cap)
    entry.last = this.now()
    if (entry.tokens < 1) {
      const waitMs = ((1 - entry.tokens) / cap) * 60_000
      this.state.set(bucket, entry)
      await sleep(waitMs)
      return this.take(bucket, perMinute)
    }
    entry.tokens -= 1
    this.state.set(bucket, entry)
  }
}

/**
 * The saving that matters: market panels are per (market, band), not per
 * listing. Returns the distinct panels to fetch and how many fetches it avoided.
 */
export function dedupeMarketPanels(
  entities: Array<{ market: string, band: string | null }>,
): { panels: Array<{ market: string, band: string }>, saved: number } {
  const seen = new Map<string, { market: string, band: string }>()
  let skipped = 0
  for (const e of entities) {
    if (!e.band) { skipped++; continue }
    const key = `${e.market}::${e.band}`
    if (seen.has(key)) skipped++
    else seen.set(key, { market: e.market, band: e.band })
  }
  return { panels: [...seen.values()], saved: skipped }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, Math.max(0, ms)))
