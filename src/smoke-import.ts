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
import { startImport, latestRun, releaseAbandoned, ImportBusyError } from './import/run.js'
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
check('the report survives verbatim', done?.report?.bookingCreated === 1,
      JSON.stringify(done?.report))
const ent = await c.query<{ label: string, market: string }>(
  `select label, market::text from entity`)
check('and the object actually landed', ent.rows[0]?.label === 'Imported Flat'
  && ent.rows[0]?.market === 'ch', JSON.stringify(ent.rows))

check('once finished, another import may start',
      Boolean(await startImport(pool)))
await settle()

/* ------------------------------- 2 · a failure must not become a permanent lock */

await c.query('truncate import_run')
const savedId = process.env.MDV_CLIENT_ID
delete process.env.MDV_CLIENT_ID
await startImport(pool)
await settle()
const failed = await latestRun(c)
check('a run that cannot even start is still FINISHED, not left open',
      failed?.finishedAt !== null)
check('and it says why', Boolean(failed?.error?.includes('MDV_CLIENT_ID')), failed?.error ?? '')
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

srv.close(); c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
