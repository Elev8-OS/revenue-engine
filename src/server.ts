/**
 * The service entrypoint: migrations at boot, then the dashboard behind a
 * magic-link gate.
 *
 * One deliberate degradation. The gate is enforced only when ALLOWED_EMAILS is
 * set; without it the dashboard is open and says so in a banner nobody can miss.
 * That is not laziness — it lets the thing be looked at before a mail provider
 * exists, and it makes the unprotected state visible instead of assumed. The
 * moment real portfolio numbers flow in, setting one variable closes it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { requestLink, redeem, sessionFor, destroy, sweep, cookieName, sessionMaxAgeSeconds }
  from './auth/magic.js'
import { makeMailer } from './auth/mail.js'
import * as q from './dashboard/query.js'
import { renderDashboard, renderLogin } from './dashboard/render.js'

const PORT = Number(process.env.PORT ?? 3000)
const MIGRATIONS = new URL('../migrations/', import.meta.url).pathname
const mailer = makeMailer()

const allowedEmails = (process.env.ALLOWED_EMAILS ?? '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
/** No allowlist means no gate. Stated in the UI rather than left to be discovered. */
const gateEnabled = allowedEmails.length > 0

const baseUrl = process.env.PUBLIC_BASE_URL ?? ''
const cookieSecure = baseUrl.startsWith('https://')

interface DbState {
  configured: boolean; reachable: boolean; tables: number
  migrations: string[]; error?: string
}
const db: DbState = { configured: false, reachable: false, tables: 0, migrations: [] }
let pool: Pool | undefined

function sourceStates() {
  const e = process.env
  const need = (...n: string[]) => n.filter(x => !e[x])
  return [
    { name: 'Elev8', missing: need('ELEV8_API_BASE', 'ELEV8_API_TOKEN'),
      note: 'der Moat: Reinigungsminuten, Gästevermerk, Kapazität' },
    { name: 'PriceLabs', missing: need('PRICELABS_API_KEY'),
      note: 'Marktpanel, Pickup-Gitter, Änderungsprotokoll' },
    { name: 'Channex', missing: need('CHANNEX_API_KEY'),
      note: 'Rezensionstext und Subscores, ota_commission, Steuern' },
    { name: 'MyDataValue', missing: need('MDV_CLIENT_ID'),
      note: 'direkte HTTP-API; das Refresh-Token liegt in der Datenbank' },
  ].map(s => ({ ...s, ready: s.missing.length === 0 }))
}

async function migrate(p: Pool): Promise<void> {
  const client = await p.connect()
  try {
    await client.query(`create table if not exists schema_migration (
      name text primary key, applied_at timestamptz not null default now())`)
    const files = (await readdir(MIGRATIONS)).filter(f => f.endsWith('.sql')).sort()
    for (const file of files) {
      const { rowCount } = await client.query(
        'select 1 from schema_migration where name = $1', [file])
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
    db.migrations = applied.rows.map(r => r.name)
    db.tables = Number(tables.rows[0]?.n ?? 0)
    db.reachable = true
  } finally { client.release() }
}

async function boot(): Promise<void> {
  const url = process.env.DATABASE_URL
  db.configured = Boolean(url)
  if (!url) { console.log('DATABASE_URL not set — readiness only'); return }
  pool = new Pool({ connectionString: url, max: 6 })
  try {
    await migrate(pool)
    console.log(`database ready: ${db.tables} tables, ${db.migrations.length} migrations`)
    const c = await pool.connect()
    try { await sweep(c) } finally { c.release() }
  } catch (err) {
    db.error = (err as Error).message
    console.error(`database not ready: ${db.error}`)
  }
  console.log(`auth gate ${gateEnabled ? `enabled for ${allowedEmails.length} address(es)` : 'DISABLED (ALLOWED_EMAILS unset)'}; mail mode ${mailer.mode}`)
}

/* ------------------------------------------------------------------ helpers */

const cookies = (req: IncomingMessage): Record<string, string> =>
  Object.fromEntries((req.headers.cookie ?? '').split(';').map(p => {
    const i = p.indexOf('=')
    return i < 0 ? ['', ''] : [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())]
  }).filter(([k]) => k))

async function formBody(req: IncomingMessage): Promise<Record<string, string | undefined>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 8_192) throw new Error('body too large')   // a login form is tiny
    chunks.push(chunk as Buffer)
  }
  return Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString('utf8')))
}

const html = (res: ServerResponse, body: string, status = 200) => {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}
const redirect = (res: ServerResponse, to: string, cookie?: string) => {
  const headers: Record<string, string> = { location: to }
  if (cookie) headers['set-cookie'] = cookie
  res.writeHead(302, headers); res.end()
}

async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T | undefined> {
  if (!pool) return undefined
  const c = await pool.connect()
  try { return await fn(c) } finally { c.release() }
}

/* ------------------------------------------------------------------- routes */

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  // Liveness only. Deliberately says nothing about which integrations exist —
  // that used to be public and should not have been.
  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', database: db.reachable }))
    return
  }

  const session = gateEnabled
    ? await withClient(c => sessionFor(c, cookies(req)[cookieName]))
    : { id: 'open', email: '' }

  if (path === '/auth/request' && req.method === 'POST') {
    const body = await formBody(req).catch(() => ({} as Record<string, string | undefined>))
    const email = body.email ?? ''
    // Always the same answer, so the endpoint cannot be used to discover who
    // has access.
    await withClient(async c => {
      const out = await requestLink(c, email, allowedEmails, baseUrl || url.origin)
      if (out.link) await mailer.send(email.trim().toLowerCase(), out.link)
      else console.log(`[login] suppressed (${out.suppressed}) for a submitted address`)
    })
    html(res, renderLogin(true, baseUrl))
    return
  }

  if (path === '/auth/callback') {
    const opened = await withClient(c => redeem(c, url.searchParams.get('token') ?? ''))
    if (!opened) { html(res, renderLogin(false, baseUrl), 400); return }
    redirect(res, '/', `${cookieName}=${encodeURIComponent(opened.id)}; HttpOnly; ` +
      `SameSite=Lax; Path=/; Max-Age=${sessionMaxAgeSeconds}${cookieSecure ? '; Secure' : ''}`)
    return
  }

  if (path === '/auth/logout') {
    await withClient(c => destroy(c, cookies(req)[cookieName]))
    redirect(res, '/', `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
    return
  }

  if (!session) { html(res, renderLogin(false, baseUrl)); return }

  if (path === '/status') {
    const s = sourceStates()
    html(res, `<!doctype html><html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revenue Engine — Bereitschaft</title>
<style>:root{color-scheme:light dark;--paper:#F1F3F1;--ink:#171C1B;--mut:#5D6B69;--line:#D2DAD6;--surface:#FBFCFA;--teal:#0D615E;--rust:#97392B}
@media(prefers-color-scheme:dark){:root{--paper:#0F1312;--ink:#E7ECE9;--mut:#94A3A0;--line:#28302E;--surface:#161B1A;--teal:#58C4BC;--rust:#E28A7C}}
body{margin:0;background:var(--paper);color:var(--ink);padding:2.5rem 1.25rem;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
main{max-width:56rem;margin:0 auto}h1{font-size:1.4rem;margin:0 0 .3rem}
p.s{color:var(--mut);margin:0 0 1.5rem;font-size:.9rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:1rem 1.1rem;margin-bottom:.8rem}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th{text-align:left;font-size:.64rem;text-transform:uppercase;letter-spacing:.1em;color:var(--mut);padding:0 .5rem .4rem 0;border-bottom:1px solid var(--line)}
td{padding:.5rem .5rem .5rem 0;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}code{font:500 .82em ui-monospace,monospace;color:var(--teal)}
.ok{color:var(--teal);font-weight:600}.no{color:var(--rust);font-weight:600}a{color:inherit}</style></head>
<body><main><h1>Bereitschaft</h1>
<p class="s">Nur Variablen<em>namen</em>, niemals Werte. · <a href="/">zum Dashboard</a></p>
<div class="card"><b>Datenbank</b> — ${db.configured
  ? db.reachable ? `<span class="ok">bereit</span> — ${db.tables} Tabellen, ${db.migrations.length} Migrationen`
    : `<span class="no">nicht erreichbar</span> — ${db.error ?? 'unbekannt'}`
  : `<span class="no">nicht konfiguriert</span> — <code>DATABASE_URL</code>`}</div>
<div class="card"><table><thead><tr><th>Quelle</th><th>Zustand</th><th>Wofür</th></tr></thead><tbody>
${s.map(x => `<tr><td><b>${x.name}</b></td><td>${x.ready ? '<span class="ok">verbunden</span>'
  : `<span class="no">fehlt</span> ${x.missing.map(m => `<code>${m}</code>`).join(' ')}`}</td>
  <td style="color:var(--mut)">${x.note}</td></tr>`).join('')}
</tbody></table></div>
<div class="card">Anmeldung: ${gateEnabled
  ? `<span class="ok">aktiv</span> für ${allowedEmails.length} Adresse(n), Versand per <code>${mailer.mode}</code>`
  : `<span class="no">aus</span> — <code>ALLOWED_EMAILS</code> ist nicht gesetzt, die Seiten sind offen`}</div>
</main></body></html>`)
    return
  }

  if (path === '/') {
    if (!pool) { html(res, renderLogin(false, baseUrl), 503); return }
    const basis: q.Basis = url.searchParams.get('basis') === 'margin' ? 'margin' : 'revenue'
    const openId = url.searchParams.get('open')
    const data = await withClient(async c => {
      const rows = await q.portfolio(c, basis)
      const open = rows.find(r => r.entityId === openId)
      return {
        basis, openId: open ? openId : null, rows,
        counts: await q.counts(c),
        notAssessable: await q.notAssessable(c),
        freshness: await q.freshness(c),
        gate: open?.worstFindingId ? await q.gate(c, open.worstFindingId) : [],
        evidence: open?.worstFindingId ? await q.evidence(c, open.worstFindingId) : [],
        demo: await q.isDemo(c),
        unprotected: !gateEnabled,
        email: session.email || undefined,
      }
    })
    html(res, renderDashboard(data!))
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('nicht gefunden\n')
}

await boot()

const server = createServer((req, res) => {
  handle(req, res).catch(err => {
    // Never leak an internal message to the browser; the log is where it goes.
    console.error(`request failed: ${(err as Error).message}`)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Fehler\n')
    }
  })
})
server.listen(PORT, () => console.log(`listening on ${PORT}`))
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { server.close(() => process.exit(0)) })
}
