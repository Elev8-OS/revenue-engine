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
import { importFunnel, type FunnelReport } from '../sources/mdv/funnel.js'
import { importObjects, type ImportReport } from '../sources/mdv/objects.js'
import { Elev8Client } from '../sources/elev8/client.js'
import { authFromEnv } from '../sources/elev8/auth.js'
import { importElev8, type Elev8ImportReport } from '../sources/elev8/import.js'
import { PriceLabsClient } from '../sources/pricelabs/client.js'
import { importPriceLabs, type PriceLabsImportReport } from '../sources/pricelabs/import.js'
import { runChecks, type CheckReport } from '../checks/run.js'
import { discoverMdv, type DiscoverReport } from '../sources/mdv/discover.js'
import { clientCredentials } from '../sources/mdv/register.js'

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
export type AnyReport = ImportReport | Elev8ImportReport | PriceLabsImportReport | CheckReport
  | DiscoverReport | FunnelReport

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

/**
 * A check run is not an import, and it rides here on purpose.
 *
 * `import_run` already gives the three things a check run needs and nothing
 * else: a background start from a page, an outcome readable afterwards, and
 * one-at-a-time enforced by the database. That last one is the real reason — a
 * check reading a portfolio that an import is halfway through writing would
 * produce findings from the seam between two states.
 */
export const isCheckReport = (r: AnyReport | null): r is CheckReport =>
  Boolean(r) && (r as CheckReport).kind === 'checks'

export const isDiscoverReport = (r: AnyReport | null): r is DiscoverReport =>
  Boolean(r) && (r as DiscoverReport).kind === 'mdv-discover'

export const isFunnelReport = (r: AnyReport | null): r is FunnelReport =>
  Boolean(r) && (r as FunnelReport).kind === 'mdv-funnel'

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
      : source === 'checks' ? await runChecks(client)
      : source === 'mdv-discover' ? await runDiscover(client)
      : source === 'mdv-funnel' ? await runFunnel(client)
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

/**
 * The discovery pass. Same transport as the import, but it maps nothing — it
 * asks a list of candidate endpoints what they answer and records the shapes.
 *
 * Its own source rather than a stage inside the MDV import, because it is a
 * question and not a read: it should be runnable without touching the portfolio,
 * and it should be obvious from the run list that a pass wrote no data.
 */
async function runDiscover(client: PoolClient): Promise<DiscoverReport> {
  const creds = await clientCredentials(client)
  if (!creds) throw new Error('no MDV client: none registered and MDV_CLIENT_ID is not set')
  const mdv = new MdvClient({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret ?? '',
    base: process.env.MDV_BASE_URL ?? undefined,
    tokenUrl: process.env.MDV_TOKEN_URL ?? undefined,
  })
  return discoverMdv(client, mdv)
}

async function runMdv(client: PoolClient): Promise<ImportReport> {
  // Our own registered client wherever one exists. Reading the variables here
  // while the grant was authorised under our own client would present the wrong
  // credentials to the token endpoint — and it would go on spending the shared
  // chain, which is the thing the registration exists to stop.
  const creds = await clientCredentials(client)
  if (!creds) {
    throw new Error('no MDV client: none registered and MDV_CLIENT_ID is not set')
  }
  const mdv = new MdvClient({
    clientId: creds.clientId, clientSecret: creds.clientSecret ?? '',
    base: process.env.MDV_BASE_URL ?? undefined,
    // A seam, not a knob: without it this function cannot be tested against a
    // stand-in provider, and an untested importer is one nobody can trust
    // with a portfolio.
    tokenUrl: process.env.MDV_TOKEN_URL ?? undefined,
  })
  const report = await importObjects(client, mdv)
  /**
   * The funnel rides on the object pass, in this order, on purpose: it resolves
   * channel ids through the aliases the pass just refreshed, so a listing that
   * only became joinable a second ago is already readable.
   *
   * Wrapped, because the three funnel endpoints are separate permissions on
   * MDV's side. A portfolio import that failed because one report was not
   * granted would be a regression dressed as a feature — the objects are the
   * part nothing else can replace.
   */
  try {
    report.funnel = await importFunnel(client, mdv)
  } catch (err) {
    report.funnelError = (err as Error).message
  }
  return report
}

/** The funnel on its own, for when the objects have not changed. */
async function runFunnel(client: PoolClient): Promise<FunnelReport> {
  const creds = await clientCredentials(client)
  if (!creds) {
    throw new Error('no MDV client: none registered and MDV_CLIENT_ID is not set')
  }
  const mdv = new MdvClient({
    clientId: creds.clientId, clientSecret: creds.clientSecret ?? '',
    base: process.env.MDV_BASE_URL ?? undefined,
    tokenUrl: process.env.MDV_TOKEN_URL ?? undefined,
  })
  return importFunnel(client, mdv)
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
  if (isDiscoverReport(r)) {
    // Endpoints that answered, controls aside, and the ones that do not exist.
    // "Created" is zero and must stay zero: a discovery pass that changed the
    // portfolio would be a migration in disguise.
    return { created: 0, known: r.answered, unresolved: r.missing.length }
  }
  if (isCheckReport(r)) {
    // The same three slots, read as a check run reads them: findings written,
    // rooms that came out healthy, rooms nothing could reach. `created` is the
    // right column for findings — they are what this run brings into existence.
    return { created: r.findings, known: r.healthy, unresolved: r.notAssessable }
  }
  /**
   * From here down, every branch reads fields out of JSON that a PREVIOUS build
   * wrote. `?? 0` is not defensive clutter: a report stored last week by a
   * reader that had one fewer field is a normal thing to meet, and the page that
   * shows "the run finished" must not die because a count moved. It is the same
   * lesson the import page just taught, one layer down.
   */
  if (isPriceLabsReport(r)) {
    // `created` is zero and stays zero. PriceLabs is a consumer of objects, not
    // a source of them: a listing that matches nothing we hold is a gap to
    // report, not a 63rd apartment to invent. A non-zero number in this column
    // for this source would mean something had gone wrong.
    return {
      created: 0,
      known: r.listings?.resolved ?? 0,
      unresolved: r.listings?.unresolved ?? 0,
    }
  }
  if (isElev8Report(r)) {
    return {
      created: r.listings?.created ?? 0,
      known: r.listings?.alreadyKnown ?? 0,
      // Rows we saw and could not place. Only the market failure counts now: an
      // OTA channel without an id is not an unplaceable object, it is a channel
      // connection with nothing published behind it, and it belongs to a listing
      // that WAS placed. Counting it here would inflate "not assessable" with
      // rows that are fine.
      unresolved: r.listings?.noMarket ?? 0,
    }
  }
  if (isFunnelReport(r)) {
    // A funnel pass places no objects at all, and saying "0 created" about a run
    // that stored four thousand measurements would read as a failure. What it
    // brought in is rows; what it could not place is ids that matched nothing.
    return {
      created: r.snapshotRows ?? 0,
      known: (r.endpoints ?? []).filter(e => e.snapshotRows > 0).length,
      unresolved: (r.endpoints ?? []).reduce((n, e) => n + (e.unresolvedIds?.length ?? 0), 0),
    }
  }
  return {
    // "Created" reads as attached for this source now. MDV stopped creating
    // objects when Elev8 became the authority for what exists; the column means
    // "channel objects this run brought into the portfolio", and for MDV that is
    // an attachment to a room we already had.
    created: (r.bookingAttached ?? 0) + (r.airbnbAttached ?? 0),
    known: r.alreadyKnown ?? 0,
    unresolved: r.unresolved ?? 0,
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
