/**
 * The service entrypoint.
 *
 * Deliberately boots even when nothing is configured yet. A crash-loop on a
 * missing variable tells you nothing; a page that names exactly which of the
 * four sources is still missing turns the deploy into visible progress on the
 * onboarding checklist.
 *
 * Two responsibilities and no more, for now:
 *   1. apply migrations at boot (idempotent, so a redeploy is free)
 *   2. answer /healthz and serve a readiness page
 */
import { createServer } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool } from 'pg'

const PORT = Number(process.env.PORT ?? 3000)
const MIGRATIONS = new URL('../migrations/', import.meta.url).pathname

type SourceState = { name: string, ready: boolean, missing: string[], note: string }

interface Readiness {
  bootedAt: string
  database: { configured: boolean, reachable: boolean, tables: number, migrations: string[], error?: string }
  sources: SourceState[]
}

const state: Readiness = {
  bootedAt: new Date().toISOString(),
  database: { configured: false, reachable: false, tables: 0, migrations: [] },
  sources: [],
}

/** Reports which variable NAMES are missing. Never a value, never a fragment. */
function readSources(): SourceState[] {
  const e = process.env
  const need = (...names: string[]) => names.filter(n => !e[n])
  const mdvMode = e.MDV_MODE ?? 'mcp'
  const mdvMissing = mdvMode === 'mcp' ? need('MDV_MCP_URL') : need('MDV_CLIENT_ID', 'MDV_REFRESH_TOKEN')
  return [
    {
      name: 'Elev8',
      missing: need('ELEV8_API_BASE', 'ELEV8_API_TOKEN'),
      ready: need('ELEV8_API_BASE', 'ELEV8_API_TOKEN').length === 0,
      note: 'the moat: cleaning minutes, the housekeeper guest note, capacity',
    },
    {
      name: 'PriceLabs',
      missing: need('PRICELABS_API_KEY'),
      ready: need('PRICELABS_API_KEY').length === 0,
      note: 'market panel, pickup grid, user logs for drift attribution',
    },
    {
      name: 'Channex',
      missing: need('CHANNEX_API_KEY'),
      ready: need('CHANNEX_API_KEY').length === 0,
      note: 'reviews with text and subscores, ota_commission, taxes — needs the Messages & Reviews app enabled',
    },
    {
      name: 'MyDataValue',
      missing: mdvMissing,
      ready: mdvMissing.length === 0,
      note: `mode ${mdvMode} — exactly one process may refresh the token`,
    },
  ]
}

async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(`
      create table if not exists schema_migration (
        name text primary key,
        applied_at timestamptz not null default now()
      )`)
    const files = (await readdir(MIGRATIONS)).filter(f => f.endsWith('.sql')).sort()
    for (const file of files) {
      const { rowCount } = await client.query(
        'select 1 from schema_migration where name = $1', [file],
      )
      if (rowCount) continue
      const sql = await readFile(join(MIGRATIONS, file), 'utf8')
      await client.query('begin')
      try {
        await client.query(sql)
        await client.query('insert into schema_migration (name) values ($1)', [file])
        await client.query('commit')
        console.log(`migration applied: ${file}`)
      } catch (err) {
        await client.query('rollback')
        throw new Error(`migration ${file} failed: ${(err as Error).message}`)
      }
    }
    const applied = await client.query<{ name: string }>(
      'select name from schema_migration order by name')
    const tables = await client.query<{ n: string }>(
      `select count(*) n from pg_tables where schemaname = 'public'`)
    state.database.migrations = applied.rows.map(r => r.name)
    state.database.tables = Number(tables.rows[0]?.n ?? 0)
    state.database.reachable = true
  } finally {
    client.release()
  }
}

async function boot(): Promise<void> {
  state.sources = readSources()
  const url = process.env.DATABASE_URL
  state.database.configured = Boolean(url)
  if (!url) {
    console.log('DATABASE_URL not set — serving readiness only, no migrations')
    return
  }
  const pool = new Pool({ connectionString: url, max: 4 })
  try {
    await migrate(pool)
    console.log(`database ready: ${state.database.tables} tables, ${state.database.migrations.length} migrations`)
  } catch (err) {
    state.database.error = (err as Error).message
    console.error(`database not ready: ${state.database.error}`)
  } finally {
    await pool.end()
  }
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function page(): string {
  const ready = state.sources.filter(s => s.ready).length
  const rows = state.sources.map(s => `
    <tr>
      <td class="n">${esc(s.name)}</td>
      <td>${s.ready
        ? '<span class="ok">verbunden</span>'
        : `<span class="no">fehlt</span> <code>${s.missing.map(esc).join('</code> <code>')}</code>`}</td>
      <td class="note">${esc(s.note)}</td>
    </tr>`).join('')

  const db = state.database.configured
    ? state.database.reachable
      ? `<span class="ok">bereit</span> — ${state.database.tables} Tabellen, ${state.database.migrations.length} Migrationen`
      : `<span class="no">nicht erreichbar</span> — ${esc(state.database.error ?? 'unbekannt')}`
    : `<span class="no">nicht konfiguriert</span> — <code>DATABASE_URL</code>`

  return `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Revenue Engine — Bereitschaft</title>
<style>
  :root { color-scheme: light dark;
    --paper:#F1F3F1; --ink:#171C1B; --muted:#5D6B69; --line:#D2DAD6;
    --brass:#8A6A1C; --teal:#0D615E; --rust:#97392B; --surface:#FBFCFA; }
  @media (prefers-color-scheme: dark) { :root {
    --paper:#0F1312; --ink:#E7ECE9; --muted:#94A3A0; --line:#28302E;
    --brass:#DFB44E; --teal:#58C4BC; --rust:#E28A7C; --surface:#161B1A; } }
  body { margin:0; background:var(--paper); color:var(--ink); padding:3rem 1.25rem 5rem;
    font:15px/1.6 ui-sans-serif,system-ui,sans-serif; }
  main { max-width:62rem; margin:0 auto; }
  h1 { font-size:1.6rem; margin:0 0 .3rem; letter-spacing:-.01em; }
  p.sub { color:var(--muted); margin:0 0 2rem; }
  .card { background:var(--surface); border:1px solid var(--line); border-radius:4px;
    padding:1.1rem 1.2rem; margin-bottom:1rem; }
  table { width:100%; border-collapse:collapse; font-size:.92rem; }
  th { text-align:left; font-size:.68rem; text-transform:uppercase; letter-spacing:.1em;
    color:var(--muted); font-weight:600; padding:0 .6rem .5rem 0; border-bottom:1px solid var(--line); }
  td { padding:.6rem .6rem .6rem 0; border-bottom:1px solid var(--line); vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  td.n { font-weight:600; white-space:nowrap; }
  td.note { color:var(--muted); font-size:.85rem; }
  code { font:500 .82em ui-monospace,monospace; color:var(--teal); }
  .ok { color:var(--teal); font-weight:600; }
  .no { color:var(--rust); font-weight:600; }
  .count { font-variant-numeric:tabular-nums; }
  footer { color:var(--muted); font-size:.85rem; margin-top:1.5rem; }
</style></head>
<body><main>
  <h1>Revenue Engine</h1>
  <p class="sub">Bereitschaft des Dienstes. Diese Seite nennt nur Variablen<em>namen</em>, niemals Werte.</p>
  <div class="card"><strong>Datenbank</strong> — ${db}</div>
  <div class="card">
    <table>
      <thead><tr><th>Quelle</th><th>Zustand</th><th>Wofür</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <footer>
    <span class="count">${ready} von 4</span> Quellen verbunden ·
    gestartet ${esc(state.bootedAt)} ·
    <a href="/healthz">/healthz</a>
  </footer>
</main></body></html>`
}

await boot()

const server = createServer((req, res) => {
  if (req.url === '/healthz') {
    // Healthy means the process is up. A missing source is a configuration
    // state, not a failure — otherwise Railway would restart us forever while
    // waiting for a credential that only a human can supply.
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(state, null, 2))
    return
  }
  if (req.url === '/' ) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page())
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' })
  res.end('not found\n')
})

server.listen(PORT, () => console.log(`listening on ${PORT}`))

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { server.close(() => process.exit(0)) })
}
