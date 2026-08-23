/**
 * Currency normalisation.
 *
 * Needed because the portfolio spans CHF and IDR and two providers lie about
 * it: PriceLabs reports `currency: "CHF"` on Bali villas, and Elev8 returns CHF
 * and IDR rows side by side in one result (which is why its own
 * `pct_of_revenue` is already wrong).
 *
 * Rule: convert at the rate of the day the money was COMMITTED — the booking
 * date — not the day we happen to read it. Otherwise a portfolio total changes
 * retroactively every time the rupiah moves, and no report reconciles twice.
 */
import type { PoolClient } from 'pg'

export interface Money { amount: number, currency: string }

export class FxError extends Error {}

/**
 * Looks up 1 base = ? quote for a day, falling back to the most recent earlier
 * day. Weekends and holidays have no JISDOR fixing, so the fallback is normal
 * operation, not a degraded path — but it is capped, because silently using a
 * three-week-old rate is a different thing from using Friday's.
 */
export async function rateFor(
  client: PoolClient,
  day: string,
  base: string,
  quote: string,
  maxStaleDays = 7,
): Promise<{ rate: number, day: string, stale: number }> {
  if (base === quote) return { rate: 1, day, stale: 0 }
  const { rows } = await client.query<{ rate: string, day: string, stale: number }>(
    `select rate, day::text, ($1::date - day) as stale
       from fx_rate
      where base = $2 and quote = $3 and day <= $1::date
      order by day desc
      limit 1`,
    [day, base, quote],
  )
  const row = rows[0]
  if (!row) throw new FxError(`no fx rate for ${base}/${quote} on or before ${day}`)
  if (row.stale > maxStaleDays) {
    throw new FxError(
      `fx rate for ${base}/${quote} is ${row.stale} days stale (${row.day}); refusing to convert`,
    )
  }
  return { rate: Number(row.rate), day: row.day, stale: row.stale }
}

export async function convert(
  client: PoolClient, money: Money, to: string, onDay: string,
): Promise<Money> {
  if (money.currency === to) return money
  const { rate } = await rateFor(client, onDay, money.currency, to)
  return { amount: money.amount * rate, currency: to }
}

/**
 * Sums mixed-currency amounts into one currency, or refuses. It refuses loudly
 * on purpose: a portfolio figure that silently dropped an unconvertible row is
 * worse than no figure.
 */
export async function sumInto(
  client: PoolClient, items: Array<Money & { day: string }>, to: string,
): Promise<Money> {
  let total = 0
  for (const item of items) {
    const converted = await convert(client, item, to, item.day)
    total += converted.amount
  }
  return { amount: total, currency: to }
}
