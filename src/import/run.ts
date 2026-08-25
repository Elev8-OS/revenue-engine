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
import { Elev8Client } from '../sources/elev8/client.js'
import { authFromEnv } from '../sources/elev8/auth.js'
import { importElev8, type Elev8ImportReport } from '../sources/elev8/import.js'
import { PriceLabsClient } from '../sources/pricelabs/client.js'
import { importPriceLabs, type PriceLabsImportReport } from '../sources/pricelabs/import.js'

/**
 * Three importers, three report shapes, one column.
 *
 * The intent was always to discriminate by a tag rather than by which keys
 * happen to be present — and for two shapes the shortcut held, because only
 * Elev8 had a `listings` object. PriceLabs brought a second one, which is
 * exactly the failure the original comment was written to prevent. So the new
 * shape carries `kind`, and the older guard now tests a key that is genuinely
 * unique to what it identifies.
 */
export type AnyReport = ImportReport | Elev8ImportReport | PriceLabsImportReport

export interface RunRow {
  id: string
  source: string
  startedBy: string | null
  startedAt: Date
  finishedAt: Date | null
  report: AnyReport | null
  error: string | null
}

/**
 * Narrows a stored report without trusting the caller to know the source.
 *
 * `bedTypes`, not `listings`. The PriceLabs report also carries a `listings`
 * object, so the old test would have read every PriceLabs run as an Elev8 run
 * and put the wrong three numbers on the import page with nothing to show that
 * it had. A discriminator has to be unique to the shape it identifies, and the
 * bed-type note is: no other source has one.
 */
export const isElev8Report = (r: AnyReport | null): r is Elev8ImportReport =>
  Boolean(r) && 'bedTypes' in (r as Elev8ImportReport)

/**
 * Tagged rather than inferred. Every report written from here on says what it
 * is; the two older shapes predate the tag, which is harmless because neither
 * of them is this one.
 */
export const isPriceLabsReport = (r: AnyReport | null): r is PriceLabsImportReport =>
  Boolean(r) && (r as PriceLabsImportReport).kind === 'pricelabs'

export class ImportBusyError extends Error {
  constructor() { super('an import is already running') }
}

/** The most recent run, finished or not. The page reads this and nothing else. */
export async function latestRun(client: PoolClient): Promise<RunRow | undefined> {
  const { rows } = await client.query<{
    id: string, source: string, started_by: string | null, started_at: Date,
    finished_at: Date | null, report: AnyReport | null, error: string | null
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
    const report = source === 'elev8'
      ? await runElev8(client)
      : source === 'pricelabs' ? await runPriceLabs(client)
      : source === 'mdv' ? await runMdv(client)
      : (() => { throw new Error(`no importer for source ${source}`) })()
    await client.query(
      `update import_run set finished_at = now(), report = $2::jsonb where id = $1`,
      [runId, JSON.stringify(report)],
    )
    // The report, not just the fact. Shortened to "finished" when this grew a
    // second importer, which removed the only place a run's outcome could be
    // read without a browser — and the log is exactly where somebody looks
    // after a run they were not watching.
    console.log(`import ${runId} (${source}) finished: ${JSON.stringify(report)}`)
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
 * Elev8 needs no grant, only a credential — which is the operational difference
 * that matters. An MDV import can be blocked by a revoked grant that a human has
 * to repair with the provider; an Elev8 import is blocked only by a variable
 * nobody has set yet.
 */
async function runElev8(client: PoolClient): Promise<Elev8ImportReport> {
  const resolved = authFromEnv()
  if (!resolved.auth) throw new Error(`elev8 not configured: ${resolved.reason}`)
  const api = new Elev8Client({
    auth: resolved.auth,
    base: process.env.ELEV8_API_BASE ?? undefined,
  })
  return importElev8(client, api)
}

/**
 * PriceLabs attaches to objects and never creates them, so this importer is
 * useless before an Elev8 pass has run — which is a real ordering constraint and
 * not an error. It is not enforced here: a pass over zero resolved listings
 * reports exactly that, which is more informative than a refusal.
 */
async function runPriceLabs(client: PoolClient): Promise<PriceLabsImportReport> {
  const apiKey = process.env.PRICELABS_API_KEY
  if (!apiKey) throw new Error('PRICELABS_API_KEY is not set')
  const base = process.env.PRICELABS_API_BASE ?? undefined
  const api = new PriceLabsClient({ apiKey, base })
  const estimatorKey = process.env.PRICELABS_ESTIMATOR_API_KEY
  return importPriceLabs(client, api, {
    estimator: estimatorKey
      // Its own client, because it is its own credential. Sharing one would mean
      // presenting the Customer API key to the Estimator and reading the 401 as
      // an outage.
      ? { api: new PriceLabsClient({ apiKey: estimatorKey, base }),
          currency: (process.env.PRICELABS_ESTIMATOR_CURRENCY ?? 'CHF').toUpperCase() }
      : undefined,
  })
}

async function runMdv(client: PoolClient): Promise<ImportReport> {
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
  return importObjects(client, mdv)
}

/**
 * The three numbers the import page shows, from either report shape.
 *
 * Here rather than in the page so that adding a third importer does not mean
 * editing the HTML, and so the two shapes are reconciled in one place where the
 * mapping is visible. "Created" means objects that did not exist before,
 * whichever source found them.
 */
export function reportCounts(r: AnyReport | null): {
  created: number, known: number, unresolved: number
} {
  if (!r) return { created: 0, known: 0, unresolved: 0 }
  if (isPriceLabsReport(r)) {
    // `created` is zero and stays zero. PriceLabs is a consumer of objects, not
    // a source of them: a listing that matches nothing we hold is a gap to
    // report, not a 63rd apartment to invent. A non-zero number in this column
    // for this source would mean something had gone wrong.
    return {
      created: 0,
      known: r.listings.resolved,
      unresolved: r.listings.unresolved,
    }
  }
  if (isElev8Report(r)) {
    return {
      created: r.listings.created,
      known: r.listings.alreadyKnown,
      // Rows we saw and could not place. Only the market failure counts now: an
      // OTA channel without an id is not an unplaceable object, it is a channel
      // connection with nothing published behind it, and it belongs to a listing
      // that WAS placed. Counting it here would inflate "not assessable" with
      // rows that are fine.
      unresolved: r.listings.noMarket,
    }
  }
  return {
    created: r.bookingCreated + r.airbnbCreated,
    known: r.alreadyKnown,
    unresolved: r.unresolved,
  }
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
