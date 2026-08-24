/**
 * Starting an import from a page, because there is no shell.
 *
 * Whoever operates this has a browser and a variables page. So the import is a
 * route, its progress is a row, and its outcome is readable afterwards — rather
 * than a log line that scrolls away in a deploy that nobody was watching.
 *
 * It runs in the background on purpose. A first pass over the live account is
 * 58 Booking properties plus 50 Airbnb listings with a detail call each, which
 * at 120 requests a minute is about a minute of work. A request that hangs for a
 * minute looks broken, and a boot that hangs for a minute fails the health check
 * and takes the deploy with it.
 */
import type { Pool, PoolClient } from 'pg'
import { MdvClient } from '../sources/mdv/client.js'
import { importObjects, type ImportReport } from '../sources/mdv/objects.js'

export interface RunRow {
  id: string
  source: string
  startedBy: string | null
  startedAt: Date
  finishedAt: Date | null
  report: ImportReport | null
  error: string | null
}

export class ImportBusyError extends Error {
  constructor() { super('an import is already running') }
}

/** The most recent run, finished or not. The page reads this and nothing else. */
export async function latestRun(client: PoolClient): Promise<RunRow | undefined> {
  const { rows } = await client.query<{
    id: string, source: string, started_by: string | null, started_at: Date,
    finished_at: Date | null, report: ImportReport | null, error: string | null
  }>(`select id::text, source, started_by, started_at, finished_at, report, error
        from import_run order by started_at desc limit 1`)
  const r = rows[0]
  return r && {
    id: r.id, source: r.source, startedBy: r.started_by, startedAt: r.started_at,
    finishedAt: r.finished_at, report: r.report, error: r.error,
  }
}

/**
 * Claims the right to run, then runs.
 *
 * The claim is an insert against a partial unique index on unfinished rows, so
 * two clicks arriving together resolve in the database rather than in a check
 * that both passed. The loser gets ImportBusyError and nothing else happens.
 */
export async function startImport(
  pool: Pool, opts: { startedBy?: string, source?: string } = {},
): Promise<string> {
  const source = opts.source ?? 'mdv'
  const claim = await pool.connect()
  let runId: string
  try {
    const { rows } = await claim.query<{ id: string }>(
      `insert into import_run (source, started_by) values ($1, $2) returning id::text`,
      [source, opts.startedBy ?? null],
    )
    runId = rows[0]!.id
  } catch (err) {
    // 23505 is unique_violation: the index did its job.
    if ((err as { code?: string }).code === '23505') throw new ImportBusyError()
    throw err
  } finally { claim.release() }

  // Deliberately not awaited. The caller answers the request; this finishes on
  // its own and writes the outcome where the page can find it.
  void run(pool, runId, source)
  return runId
}

async function run(pool: Pool, runId: string, source: string): Promise<void> {
  const client = await pool.connect()
  try {
    if (source !== 'mdv') throw new Error(`no importer for source ${source}`)
    const clientId = process.env.MDV_CLIENT_ID
    const clientSecret = process.env.MDV_CLIENT_SECRET
    if (!clientId || !clientSecret) {
      throw new Error('MDV_CLIENT_ID and MDV_CLIENT_SECRET must both be set')
    }
    const mdv = new MdvClient({
      clientId, clientSecret,
      base: process.env.MDV_BASE_URL ?? undefined,
      // A seam, not a knob: without it this function cannot be tested against a
      // stand-in provider, and an untested importer is one nobody can trust
      // with a portfolio.
      tokenUrl: process.env.MDV_TOKEN_URL ?? undefined,
    })
    const report = await importObjects(client, mdv)
    await client.query(
      `update import_run set finished_at = now(), report = $2::jsonb where id = $1`,
      [runId, JSON.stringify(report)],
    )
    console.log(`import ${runId} finished: ${JSON.stringify(report)}`)
  } catch (err) {
    const message = (err as Error).message
    // Finish the row even on failure. An unfinished row would block every later
    // attempt through the one-at-a-time index — a failed import must not become
    // a permanent lock.
    await client.query(
      `update import_run set finished_at = now(), error = $2 where id = $1`,
      [runId, message],
    ).catch(() => {})
    console.error(`import ${runId} failed: ${message}`)
  } finally { client.release() }
}

/**
 * Releases a run that will never finish, e.g. because the process was killed
 * mid-import. Called at boot: a redeploy is exactly when this happens.
 */
export async function releaseAbandoned(client: PoolClient): Promise<number> {
  const { rowCount } = await client.query(
    `update import_run set finished_at = now(),
            error = coalesce(error, 'abandoned: the process restarted mid-import')
      where finished_at is null`)
  return rowCount ?? 0
}
