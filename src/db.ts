/** Postgres access plus the advisory locks that keep single-writer rules real. */
import { Pool, type PoolClient } from 'pg'

let pool: Pool | undefined

export function getPool(connectionString: string): Pool {
  pool ??= new Pool({ connectionString, max: 8, idleTimeoutMillis: 30_000 })
  return pool
}

/**
 * Named advisory lock. Used for the MDV token refresh (two refreshers would
 * revoke the grant) and for each ingest job, so an overlapping cron run waits
 * instead of double-writing.
 */
export async function withLock<T>(
  client: PoolClient,
  name: string,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  const key = hashLockName(name)
  const { rows } = await client.query<{ locked: boolean }>(
    'select pg_try_advisory_lock($1) as locked', [key],
  )
  if (!rows[0]?.locked) return undefined
  try {
    return await fn()
  } finally {
    await client.query('select pg_advisory_unlock($1)', [key])
  }
}

/** Stable 64-bit-ish key from a name. Deterministic across deploys. */
function hashLockName(name: string): number {
  let h = 5381
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h + name.charCodeAt(i)) | 0
  return h
}
