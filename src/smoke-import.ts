/**
 * The import trigger.
 *
 * The property worth protecting is not "does an import run" — that is tested in
 * smoke-mdv-objects. It is that a FAILED or KILLED import does not become a
 * permanent lock. The one-at-a-time guarantee is an index on unfinished rows, so
 * any run that never finishes blocks every later attempt for good.
 */
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { startImport, latestRun, releaseAbandoned, ImportBusyError,
  isElev8Report, isPriceLabsReport, isCheckReport, isDiscoverReport, isFunnelReport,
  reportCounts, funnelReportOf, type AnyReport } from './import/run.js'
import type { ImportReport as MdvImportReport } from './sources/mdv/objects.js'
import { seedRefreshToken } from './sources/mdv/client.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

const port = 4595
const srv = createServer((req, res) => {
  const path = (req.url ?? '').split('?')[0]!
  const json = (o: unknown) => {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o))
  }
  if (path === '/oauth/token') {
    return json({ access_token: 'at', refresh_token: `r${Math.random()}`, expires_in: 3600 })
  }
  if (path === '/api/v1/booking/properties/') {
    return json({ properties: [
      { property_id: 91, name: 'Imported Flat', status: 'active' },
    ] })
  }
  if (path === '/api/v1/booking/properties/91/') {
    return json({ property_id: 91, latitude: 47.55, longitude: 7.58, country_code: 'ch',
                  sync_state: { metrics: { pricing: '2026-08-23T07:00:00Z' } } })
  }
  if (path === '/api/v1/airbnb/listings/') return json({ count: 0, results: [] })
  res.writeHead(404); res.end()
})
await new Promise<void>(r => srv.listen(port, r))

process.env.MDV_BASE_URL = `http://127.0.0.1:${port}/api/v1`
process.env.MDV_TOKEN_URL = `http://127.0.0.1:${port}/oauth/token`
process.env.MDV_CLIENT_ID = 'cid'
process.env.MDV_CLIENT_SECRET = 'sec'

const c = await pool.connect()
await c.query('truncate import_run')
await c.query('delete from entity')
await c.query('delete from oauth_token'); await c.query('truncate oauth_event')
await seedRefreshToken(c, { clientId: 'cid', refreshToken: 'seed' })

/** Waits for the background run to write its outcome. */
async function settle(timeoutMs = 8_000): Promise<void> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const run = await latestRun(c)
    if (run?.finishedAt) return
    if (Date.now() > until) throw new Error('the run never finished')
    await new Promise(r => setTimeout(r, 60))
  }
}

/* ------------------------------------------------------- 1 · one at a time */

const id = await startImport(pool, { startedBy: 'reto' })
check('starting an import claims a row', Boolean(id))
const running = await latestRun(c)
check('and the row reads as running', running?.finishedAt === null)
check('with the person recorded', running?.startedBy === 'reto')

let busy = false
try { await startImport(pool) } catch (e) { busy = e instanceof ImportBusyError }
check('a second click is refused by the database, not by a check that both pass', busy)

await settle()
const done = await latestRun(c)
check('the run finishes and records its report', done?.finishedAt !== null && !done?.error,
      done?.error ?? '')
// The narrowing is itself the assertion: three importers now share one column,
// and a reader that guessed by key would read an Elev8 report as an MDV one —
// or, once PriceLabs arrived and brought its own `listings` object, a PriceLabs
// report as an Elev8 one.
const stored = done?.report ?? null
// The funnel report joined the union and carries its own tag, so the MDV shape is
// still "none of the tagged ones" — and it now nests a funnel report INSIDE
// itself rather than replacing itself with one, which is what keeps that true.
const notTagged = (r: AnyReport | null): r is MdvImportReport =>
  !isElev8Report(r) && !isPriceLabsReport(r) && !isCheckReport(r)
  && !isDiscoverReport(r) && !isFunnelReport(r)
check('the stored report is recognisably the MDV shape', notTagged(stored))
const asMdv = notTagged(stored) ? stored : null
// One Booking object arrived and no room in this fixture carries its id, so the
// honest outcome is one unresolved row and no new object. That changed when MDV
// stopped creating entities: Elev8 is the authority for what exists.
check('the report survives verbatim', asMdv?.bookingSeen === 1
      && asMdv?.unresolved === 1 && asMdv?.bookingAttached === 0, JSON.stringify(stored))
check('the page counts come out of every shape the same way',
      reportCounts(stored).created === 0 && reportCounts(stored).unresolved === 1,
      JSON.stringify(reportCounts(stored)))
const ent = await c.query<{ n: number }>(`select count(*)::int n from entity`)
check('and the channel object did NOT become a room of its own',
      ent.rows[0]!.n === 0, String(ent.rows[0]!.n))
// Filtered by id: earlier suites in the same throwaway database leave their own
// unresolved rows behind, and asserting on "the first row" would pass or fail by
// suite order rather than by behaviour.
const gap = await c.query<{ reason: string }>(
  `select reason from unresolved_alias where external_id = '91'`)
check('it is on the unresolved list with its id and a reason',
      gap.rows.length === 1 && /Elev8 is the authority/.test(gap.rows[0]!.reason),
      JSON.stringify(gap.rows))

check('once finished, another import may start',
      Boolean(await startImport(pool)))
await settle()

/* ------------------------------- 2 · a failure must not become a permanent lock */

await c.query('truncate import_run')
// A REGISTERED client now beats the variable, which is the whole point of owning
// one — so unsetting the variable is no longer enough to make this importer
// unconfigured. An earlier suite in this same throwaway database leaves a
// registration behind, and without clearing it this test silently asserted
// nothing: the run succeeded and the "it says why" check read an empty error.
await c.query(`delete from oauth_client`)
const savedId = process.env.MDV_CLIENT_ID
delete process.env.MDV_CLIENT_ID
await startImport(pool)
await settle()
const failed = await latestRun(c)
check('a run that cannot even start is still FINISHED, not left open',
      failed?.finishedAt !== null)
check('and it says why, naming both ways to configure one',
      Boolean(failed?.error?.includes('MDV_CLIENT_ID'))
      && Boolean(failed?.error?.includes('registered')), failed?.error ?? '')
process.env.MDV_CLIENT_ID = savedId
let againAfterFailure = false
try { await startImport(pool); againAfterFailure = true } catch { /* blocked */ }
check('so a failed import does not lock the door forever', againAfterFailure)
await settle()

/* ------------------------------------------ 3 · a killed process is recoverable */

await c.query('truncate import_run')
await c.query(`insert into import_run (source, started_at) values ('mdv', now() - interval '2 hours')`)
let blocked = false
try { await startImport(pool) } catch (e) { blocked = e instanceof ImportBusyError }
check('an abandoned run blocks, as designed', blocked)
const freed = await releaseAbandoned(c)
check('releasing frees exactly the abandoned row', freed === 1, String(freed))
const released = await latestRun(c)
check('and records that it was abandoned rather than pretending it succeeded',
      Boolean(released?.error?.includes('abandoned')), released?.error ?? '')
check('after which an import can start again', Boolean(await startImport(pool)))
await settle()

/* --------------- 4 · a report an older build wrote must not kill the page */

// This is the regression for a live outage. /import answered a bare "error" for
// every request because one field read out of a stored report was absent and one
// unguarded `.replace` took the whole page down — buttons, state, everything —
// while the log said only "Cannot read properties of undefined".
//
// `import_run.report` is JSON written by a PREVIOUS version of this code. Reading
// it is a compatibility surface, and it was treated as an internal call.
const OLDER: Array<[string, unknown]> = [
  ['an empty object', {}],
  ['a funnel report with no endpoints', { kind: 'mdv-funnel', snapshotRows: 4 }],
  ['a funnel endpoint with no ids', { kind: 'mdv-funnel', snapshotRows: 4,
    endpoints: [{ path: '/a/', snapshotRows: 4 }] }],
  ['an elev8 report whose listings block moved', { bedTypes: 3 }],
  ['a pricelabs report whose listings block moved', { kind: 'pricelabs' }],
  ['an mdv report with fields the writer did not have', { bookingSeen: 1 }],
]
for (const [what, report] of OLDER) {
  let threw = ''
  let counts = { created: -1, known: -1, unresolved: -1 }
  try { counts = reportCounts(report as never) } catch (e) { threw = (e as Error).message }
  check(`${what}: counting it does not throw`, threw === '', threw)
  check(`${what}: and every count is a number, not NaN`,
        [counts.created, counts.known, counts.unresolved].every(Number.isFinite),
        JSON.stringify(counts))
}

/* ------------- 5 · two reports, one key name, two entirely different meanings */

// The regression for the second outage on the same page. `/import` looked for a
// nested funnel report with `'funnel' in report`. A CHECK run also has a key
// called `funnel` — holding the funnel STATE, the string "read". The presence
// test passed, `.endpoints` was read off a string, and the page died.
//
// The rule was already written down: reports are TAGGED, not inferred. So this
// asserts the tag is what decides.
const CHECKS_WITH_STATE = { kind: 'checks', findings: 18, healthy: 18,
                            notAssessable: 37, funnel: 'read' } as never
check('a check run carrying funnel: "read" is NOT mistaken for a funnel report',
      funnelReportOf(CHECKS_WITH_STATE) === null)
check('and counting it still reads it as a check run',
      reportCounts(CHECKS_WITH_STATE).created === 18)

const MDV_WITH_NESTED = { bookingSeen: 58, bookingAttached: 0, airbnbSeen: 50,
  airbnbAttached: 0, alreadyKnown: 78, unresolved: 30, crossKind: 0, freshnessRows: 305,
  funnel: { kind: 'mdv-funnel', asOf: '2026-08-26', snapshotRows: 421, anyStored: true,
            endpoints: [] } } as never
const nested = funnelReportOf(MDV_WITH_NESTED)
check('a genuine nested funnel report is found and carries its own numbers',
      nested?.snapshotRows === 421, JSON.stringify(nested?.snapshotRows))
check('a funnel report at the top level is found too',
      funnelReportOf({ kind: 'mdv-funnel', asOf: 'x', snapshotRows: 1, anyStored: true,
                       endpoints: [] } as never)?.asOf === 'x')
check('and a report with no funnel anywhere yields null, not a guess',
      funnelReportOf({ bedTypes: 2 } as never) === null
      && funnelReportOf(null) === null)
// The nastiest variant: a key called funnel holding something object-shaped but
// untagged. Presence would pass; the tag must not.
check('an untagged object under the same key is refused',
      funnelReportOf({ alreadyKnown: 1, funnel: { asOf: 'x' } } as never) === null)

srv.close(); c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
