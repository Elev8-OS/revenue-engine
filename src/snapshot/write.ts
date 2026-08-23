/**
 * The nightly archive.
 *
 * Every forward-looking series these providers give us is implicitly "as of
 * today": PriceLabs has no as-of snapshots, MDV's ranking is a current
 * observation, our own calendar is current state. So pickup, pace and any
 * before/after measurement are computable ONLY if we keep our own dated copies.
 * Nothing here can be backfilled later, which is why this ships first.
 */
import type { PoolClient } from 'pg'
import type { SourceSystem } from '../entity/resolve.js'

export interface SnapshotRow {
  entityId: string
  metric: string
  /** The date the value is about. */
  stayDate: string
  value: number
  currency?: string
  source: SourceSystem
  /** When the provider says it observed it, where it tells us. */
  observedAt?: string
}

export interface MarketSnapshotRow {
  market: string
  band: string
  metric: string
  stayDate: string
  value: number
  currency?: string
}

/**
 * Writes with as_of_date = the run's date, and is idempotent within a day: a
 * re-run overwrites the same key rather than creating a second version, so a
 * retry after a partial failure is safe.
 */
export async function writeSnapshots(
  client: PoolClient, asOf: string, rows: SnapshotRow[],
): Promise<number> {
  if (!rows.length) return 0
  const COLS = 8
  const values: unknown[] = []
  const tuples = rows.map((r, i) => {
    const b = i * COLS
    values.push(r.entityId, r.metric, r.stayDate, asOf, r.value, r.currency ?? null,
                r.source, r.observedAt ?? null)
    return `($${b + 1}, $${b + 2}, $${b + 3}::date, $${b + 4}::date, $${b + 5}, $${b + 6}, `
      + `$${b + 7}::source_system, $${b + 8})`
  })
  const sql = `
    insert into snapshot (entity_id, metric, stay_date, as_of_date, value, currency, source, observed_at)
    values ${tuples.join(', ')}
    on conflict (entity_id, metric, stay_date, as_of_date)
      do update set value = excluded.value,
                    currency = excluded.currency,
                    source = excluded.source,
                    observed_at = excluded.observed_at`
  const res = await client.query(sql, values)
  return res.rowCount ?? 0
}

export async function writeMarketSnapshots(
  client: PoolClient, asOf: string, rows: MarketSnapshotRow[],
): Promise<number> {
  if (!rows.length) return 0
  const values: unknown[] = []
  const tuples = rows.map((r, i) => {
    const b = i * 7
    values.push(r.market, r.band, r.metric, r.stayDate, asOf, r.value, r.currency ?? null)
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::date, $${b + 5}::date, $${b + 6}, $${b + 7})`
  })
  const res = await client.query(`
    insert into snapshot_market (market, band, metric, stay_date, as_of_date, value, currency)
    values ${tuples.join(', ')}
    on conflict (market, band, metric, stay_date, as_of_date)
      do update set value = excluded.value, currency = excluded.currency`, values)
  return res.rowCount ?? 0
}

/**
 * Pickup between two observation dates for the same stay date. This is the
 * function the archive exists for — it is unanswerable without it, and no
 * provider offers it.
 */
export async function pickup(
  client: PoolClient,
  entityId: string, metric: string, stayDate: string, fromAsOf: string, toAsOf: string,
): Promise<number | null> {
  const { rows } = await client.query<{ delta: string | null }>(
    `select (
       (select value from snapshot
         where entity_id = $1 and metric = $2 and stay_date = $3::date and as_of_date = $5::date)
       -
       (select value from snapshot
         where entity_id = $1 and metric = $2 and stay_date = $3::date and as_of_date = $4::date)
     ) as delta`,
    [entityId, metric, stayDate, fromAsOf, toAsOf],
  )
  const d = rows[0]?.delta
  return d === null || d === undefined ? null : Number(d)
}

/** Records per-dataset freshness. A stale dataset blocks its findings. */
export async function recordFreshness(
  client: PoolClient,
  source: SourceSystem, dataset: string, entityId: string | null,
  observedAt: string | null, status = 'ok', error: string | null = null,
): Promise<void> {
  await client.query(
    `insert into dataset_freshness (source, dataset, entity_id, observed_at, fetched_at, status, error)
     values ($1, $2, $3, $4, now(), $5, $6)
     on conflict (source, dataset, entity_id)
       do update set observed_at = excluded.observed_at,
                     fetched_at = excluded.fetched_at,
                     status = excluded.status,
                     error = excluded.error`,
    [source, dataset, entityId, observedAt, status, error],
  )
}

/**
 * The freshness gate. Returns the datasets that are too old to argue with.
 * Observed on the live MDV account: five datasets 20 minutes old while
 * property_core was 25 hours behind — exactly the spread a single "last check"
 * timestamp hides.
 */
export async function staleDatasets(
  client: PoolClient, entityId: string, maxAgeHours = 24,
): Promise<Array<{ source: string, dataset: string, ageHours: number }>> {
  const { rows } = await client.query<{ source: string, dataset: string, age_hours: string }>(
    `select source::text, dataset,
            extract(epoch from (now() - coalesce(observed_at, fetched_at))) / 3600 as age_hours
       from dataset_freshness
      where (entity_id = $1 or entity_id is null)
        and coalesce(observed_at, fetched_at) < now() - ($2 || ' hours')::interval`,
    [entityId, String(maxAgeHours)],
  )
  return rows.map(r => ({ source: r.source, dataset: r.dataset, ageHours: Number(r.age_hours) }))
}
