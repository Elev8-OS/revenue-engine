/**
 * The PriceLabs Customer API transport.
 *
 * What is documented and therefore not guessed here: the server is
 * `https://api.pricelabs.co`, the credential is the header `X-API-Key`, and the
 * read endpoints this service uses are `/v1/listings`, `/v1/listing_prices`,
 * `/v1/listing_metrics`, `/v1/reservation_data` and `/v1/neighborhood_data`.
 *
 * Three things are NOT documented, and each is handled as an unknown rather than
 * assumed into a constant:
 *
 *   1. THERE IS NO STATED RATE LIMIT. Not in the specification, not in the
 *      reference, not on the pricing page — while `429` is a documented response
 *      on every endpoint. So the provider throttles and does not say when. This
 *      client therefore runs on the `pricelabs_other` bucket, whose limit is
 *      null, which the budget deliberately floors at one request a second. Slow
 *      is recoverable; being throttled out of a portfolio-wide pass is not.
 *
 *   2. THERE IS NO COMMON ENVELOPE. Measured against the reference, the four
 *      read endpoints return four different shapes:
 *        /v1/listings         { listings: [...] }
 *        /v1/listing_prices   [ { id, pms, data: [...] } ]     ← a bare array
 *        /v1/listing_metrics  { data: { listing_level, market_level } }
 *        /v1/reservation_data { pms_name, next_page, data: [...] }
 *      Writing one `unwrap()` over that would have to guess which of four
 *      wrappers it was looking at, and would quietly return the wrong half when
 *      it guessed wrong. Each caller reads its own documented shape instead, and
 *      records what it actually saw.
 *
 *   3. `-1` IS A SENTINEL, NOT A NUMBER. Measured on the live account:
 *      `user_price: -1`, `ADR: -1`, `booked_date: "-1"`, `revpar["1"]: -1`,
 *      `weekend_total_occupancy["1"]: -4`. Every one of those means "no value" in
 *      a field whose type is a number. `plain()` below is the only way values
 *      enter this system from PriceLabs, and it rejects them — because the
 *      alternative is a dashboard that reports an ADR of minus one franc and
 *      looks like it is working.
 *
 * A 403 is a NAMED state, not a failure. `/v1/reservation_data` is documented to
 * return one, and the difference between "your key may not read this" and "the
 * request broke" is the difference between a sentence a human can act on and a
 * red box.
 */
import type { PoolClient } from 'pg'
import { RateBudget, LIMITS } from '../../scheduler/budget.js'

export const DEFAULT_BASE = 'https://api.pricelabs.co'

/** Named states this API is documented to produce, beyond plain success. */
export type PriceLabsBlocked =
  | 'unauthorised'      // 401: the key is wrong, missing, or disabled
  | 'insufficient_role' // 403: a real key that may not read this endpoint
  | 'bad_request'       // 400: our parameters, not their server

export class PriceLabsError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

/** A blocked call is an outcome, not an exception. */
export class PriceLabsBlockedError extends Error {
  constructor(readonly blocked: PriceLabsBlocked, readonly status: number, message: string) {
    super(message)
  }
}

/**
 * The provider's own message: read for shape, never trusted as text we repeat
 * verbatim into a page without escaping, and capped so a stack trace in a body
 * cannot become our log.
 */
function messageOf(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    for (const k of ['error', 'message', 'detail']) {
      const v = (body as Record<string, unknown>)[k]
      if (typeof v === 'string' && v.length && v.length < 300) return v
    }
  }
  return `http_${status}`
}

/**
 * A number, or nothing. The single gate every PriceLabs value passes through.
 *
 * `allowNegative` exists for exactly one class of field — an index or a delta
 * that can legitimately be below zero. Nothing in the mapped set uses it today;
 * it is a parameter rather than an exception so that the day something does, the
 * decision is visible at the call site instead of being a special case buried
 * here.
 */
export function plain(v: unknown, { allowNegative = false } = {}): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  if (!Number.isFinite(n)) return null
  if (!allowNegative && n < 0) return null
  return n
}

export interface PriceLabsClientOptions {
  apiKey: string
  base?: string
  budget?: RateBudget
  maxRetries?: number
  sleep?: (ms: number) => Promise<void>
  fetchImpl?: typeof fetch
}

const wait = (ms: number) => new Promise<void>(r => setTimeout(r, Math.max(0, ms)))

export class PriceLabsClient {
  private readonly budget: RateBudget
  private readonly base: string
  private readonly maxRetries: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: PriceLabsClientOptions) {
    this.budget = opts.budget ?? new RateBudget()
    this.base = (opts.base ?? DEFAULT_BASE).replace(/\/$/, '')
    this.maxRetries = opts.maxRetries ?? 2
    this.sleep = opts.sleep ?? wait
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /**
   * One call. `bucket` names which budget it spends: the neighbourhood panel is
   * ~207'000 characters a time and belongs in its own bucket, everything else
   * shares the conservative one.
   */
  private async call<T>(
    path: string,
    { method = 'GET', params = {}, body, bucket = 'pricelabs_other' }: {
      method?: 'GET' | 'POST'
      params?: Record<string, string | number | boolean>
      body?: unknown
      bucket?: 'pricelabs_other' | 'pricelabs_market'
    } = {},
  ): Promise<T> {
    const url = new URL(`${this.base}/${path.replace(/^\//, '')}`)
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))

    for (let attempt = 0; ; attempt++) {
      await this.budget.take(bucket, LIMITS[bucket]!.perMinute)
      const res = await this.fetchImpl(url, {
        method,
        headers: {
          'X-API-Key': this.opts.apiKey,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })

      if (res.ok) return await res.json() as T

      // The one thing the provider tells us about its undocumented limit is a
      // 429 when we cross it. Honour Retry-After where it sends one; back off
      // linearly where it does not.
      if (res.status === 429 && attempt < this.maxRetries) {
        const ra = Number(res.headers.get('retry-after'))
        await this.sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : (attempt + 1) * 3_000)
        continue
      }

      const payload = await res.json().catch(() => null) as unknown
      const said = messageOf(payload, res.status)

      // Not retried, on purpose. A rejected key is not going to be accepted on
      // the second ask, and a role that may not read an endpoint will not grow
      // into one. Retrying either just spends budget to be told the same thing.
      if (res.status === 401) {
        throw new PriceLabsBlockedError('unauthorised', 401,
          `PRICELABS_API_KEY was rejected: ${said}`)
      }
      if (res.status === 403) {
        throw new PriceLabsBlockedError('insufficient_role', 403,
          `the key is valid but may not read ${path}: ${said}`)
      }
      if (res.status === 400) {
        throw new PriceLabsBlockedError('bad_request', 400, `${path} rejected our request: ${said}`)
      }

      throw new PriceLabsError(`pricelabs ${method} ${path} failed: ${said}`, res.status)
    }
  }

  get<T>(
    path: string, params: Record<string, string | number | boolean> = {},
    bucket: 'pricelabs_other' | 'pricelabs_market' = 'pricelabs_other',
  ): Promise<T> {
    return this.call<T>(path, { method: 'GET', params, bucket })
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.call<T>(path, { method: 'POST', body })
  }
}

/**
 * Keeps one full response per endpoint per pass, and only one.
 *
 * The raw landing zone exists because too much of these APIs is undocumented to
 * decide at ingest time what matters — but the honest version of that argument
 * has a cost. A day of price calendars for 62 listings is a couple of megabytes,
 * every day, for fields nobody has looked at yet; a year of it is most of a
 * gigabyte to keep a decision open.
 *
 * So: one specimen. The whole response for the first listing of each pass, kept
 * in full, which is enough to design against later — beside a recorded shape
 * that covers the whole portfolio and says how often each field was actually
 * filled. The shape answers "is this field real", the specimen answers "what
 * does it look like", and neither needs 62 copies.
 */
export async function keepSpecimen(
  db: PoolClient, endpoint: string, externalId: string | null, body: unknown,
): Promise<void> {
  await db.query(
    `insert into raw_payload (source, endpoint, external_id, body)
     values ('pricelabs', $1, $2, $3::jsonb)`,
    [endpoint, externalId, JSON.stringify(body)],
  )
}
