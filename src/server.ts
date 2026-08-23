/**
 * The service entrypoint: migrations at boot, then the dashboard behind a gate.
 *
 * The gate is single sign-on against the Elev8-Suite Microsoft 365 tenant. It is
 * the right door for an internal tool: nobody holds a password for it, access
 * inherits whatever MFA and conditional access the tenant already enforces, and
 * it closes by itself the day an account is disabled.
 *
 * Two deliberate degradations, both visible rather than assumed:
 *
 *   1. The magic link survives as a fallback, but it RETIRES ITSELF the moment
 *      single sign-on is configured. Leaving two doors open would mean the
 *      weaker one decides how strong the door is.
 *
 *   2. With no login configured at all, the dashboard is open and says so in a
 *      banner nobody can miss. That is what lets the thing be looked at before
 *      an app registration exists — and it makes the unprotected state loud.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pool, type PoolClient } from 'pg'
import { requestLink, redeem, openSession, sessionFor, destroy, sweep, cookieName,
  sessionMaxAgeSeconds, type Session } from './auth/magic.js'
import { beginLogin, completeLogin, admits, ELEV8_TENANT_ID, SsoError,
  type Refusal } from './auth/entra.js'
import { makeMailer } from './auth/mail.js'
import { seedDemo, clearDemo, hasDemo } from './demo.js'
import { begin as mdvBegin, complete as mdvComplete, sweepFlows, DEFAULT_SCOPES }
  from './sources/mdv/oauth.js'
import { storeInitialToken } from './sources/mdv/auth.js'
import { pickLang, stringsFor, otherLang, langCookie, langCookieMaxAge, type Lang }
  from './i18n.js'
import * as q from './dashboard/query.js'
import { renderDashboard, renderLogin } from './dashboard/render.js'

const PORT = Number(process.env.PORT ?? 3000)
const MIGRATIONS = new URL('../migrations/', import.meta.url).pathname
const mailer = makeMailer()

/**
 * The allowlist narrows single sign-on rather than replacing it. Entra says who
 * someone is; this says whether this particular tool is theirs. Empty means
 * anyone in the tenant, which is a closed door but a wider one — so /status
 * reports which of the two it currently is.
 */
const allowedEmails = (process.env.ALLOWED_EMAILS ?? '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

/**
 * Entra group object IDs. This is the gate we actually want long-term: access
 * then ends when somebody leaves the group in the directory, rather than when
 * a person remembers to edit a Railway variable.
 *
 * Object IDs rather than names, because a display name is mutable and reusable
 * — rename a group and an address list would silently keep working while this
 * would silently stop, which is the wrong failure of the two.
 */
const allowedGroups = (process.env.ALLOWED_GROUPS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)

const baseUrl = process.env.PUBLIC_BASE_URL ?? ''
const cookieSecure = baseUrl.startsWith('https://')

const entra = {
  // The tenant id is public — resolvable from the domain — so it has a default
  // and only a second tenant would need the variable.
  tenantId: process.env.ENTRA_TENANT_ID ?? ELEV8_TENANT_ID,
  clientId: process.env.ENTRA_CLIENT_ID ?? '',
  clientSecret: process.env.ENTRA_CLIENT_SECRET ?? '',
  redirectUri: `${baseUrl}/auth/sso/callback`,
}
const ssoEnabled = Boolean(entra.clientId && entra.clientSecret && baseUrl)

/**
 * The mail fallback stands only while single sign-on does not, unless someone
 * asks for it explicitly. So it disappears on its own when the better door
 * opens, instead of quietly staying the weakest way in.
 */
const magicEnabled = allowedEmails.length > 0
  && (!ssoEnabled || process.env.MAGIC_LINK === 'true')

const gateEnabled = ssoEnabled || magicEnabled

const MDV_ISSUER = new URL(process.env.MDV_BASE_URL
  ?? 'https://app.mydatavalue.com/api/v1').origin
const mdvRedirectUri = `${baseUrl}/auth/mdv/callback`

interface DbState {
  configured: boolean; reachable: boolean; tables: number
  migrations: string[]; error?: string
}
const db: DbState = { configured: false, reachable: false, tables: 0, migrations: [] }
let pool: Pool | undefined

function sourceStates() {
  const env = process.env
  const need = (...n: string[]) => n.filter(x => !env[x])
  return [
    { name: 'Elev8', key: 'elev8' as const, missing: need('ELEV8_API_BASE', 'ELEV8_API_TOKEN') },
    { name: 'PriceLabs', key: 'pricelabs' as const, missing: need('PRICELABS_API_KEY') },
    { name: 'Channex', key: 'channex' as const, missing: need('CHANNEX_API_KEY') },
    { name: 'MyDataValue', key: 'mdv' as const,
      missing: need('MDV_CLIENT_ID', 'MDV_CLIENT_SECRET') },
  ].map(x => ({ ...x, ready: x.missing.length === 0 }))
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
    try {
      await sweep(c)
      await sweepFlows(c)
      // SEED_DEMO declares the DESIRED state rather than triggering an action,
      // so setting or clearing one variable is enough and nobody needs a shell.
      const want = process.env.SEED_DEMO === 'true'
      const have = await hasDemo(c)
      if (want && !have) console.log(`demo data seeded: ${await seedDemo(c)} entities`)
      if (!want && have) console.log(`demo data removed: ${await clearDemo(c)} entities`)
    } finally { c.release() }
  } catch (err) {
    db.error = (err as Error).message
    console.error(`database not ready: ${db.error}`)
  }
  const gates = [
    allowedGroups.length ? `${allowedGroups.length} allowlisted group(s)` : null,
    allowedEmails.length ? `${allowedEmails.length} allowlisted address(es)` : null,
  ].filter(Boolean)
  console.log(`auth gate: ${gateEnabled
    ? [ssoEnabled ? `Entra SSO (tenant ${entra.tenantId})` : null,
       magicEnabled ? `magic link via ${mailer.mode}` : null].filter(Boolean).join(' + ')
      + (gates.length ? `, ${gates.join(' AND ')}` : ', any member of the tenant')
    : 'DISABLED — no login configured, pages are open'}`)
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
/**
 * Appends rather than assigns. A redirect that opens a session while the reader
 * also just picked a language has two cookies to set, and the second must not
 * silently drop the first.
 */
const addCookie = (res: ServerResponse, cookie: string) => {
  const prev = res.getHeader('set-cookie')
  const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : []
  res.setHeader('set-cookie', [...list, cookie])
}
const redirect = (res: ServerResponse, to: string) => {
  res.writeHead(302, { location: to }); res.end()
}

const sessionCookie = (id: string) =>
  `${cookieName}=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/; `
  + `Max-Age=${sessionMaxAgeSeconds}${cookieSecure ? '; Secure' : ''}`

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** Small standalone page for the authorisation outcomes. */
const notice = (lang: Lang, title: string, body: string) => `<!doctype html>
<html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>:root{color-scheme:light dark;--paper:#F1F3F1;--ink:#171C1B;--mut:#5D6B69;--line:#D2DAD6;--surface:#FBFCFA;--teal:#0D615E}
@media(prefers-color-scheme:dark){:root{--paper:#0F1312;--ink:#E7ECE9;--mut:#94A3A0;--line:#28302E;--surface:#161B1A;--teal:#58C4BC}}
body{margin:0;background:var(--paper);color:var(--ink);display:grid;place-items:center;min-height:100vh;
padding:1.5rem;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
.card{background:var(--surface);border:1px solid var(--line);border-radius:5px;padding:1.8rem;max-width:34rem}
h1{font-size:1.15rem;margin:0 0 .5rem}p{color:var(--mut);margin:0}
code{font:500 .85em ui-monospace,monospace;color:var(--teal)}a{color:inherit}</style></head>
<body><div class="card"><h1>${esc(title)}</h1><p>${body}</p></div></body></html>`

async function withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T | undefined> {
  if (!pool) return undefined
  const c = await pool.connect()
  try { return await fn(c) } finally { c.release() }
}

/* ------------------------------------------------------------------- routes */

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const path = url.pathname

  // English or Bahasa Indonesia, in that order of fallback. An explicit ?lang
  // is remembered so the Bali team picks once rather than on every visit.
  const lang = pickLang({
    query: url.searchParams.get('lang'),
    cookie: cookies(req)[langCookie],
    acceptLanguage: req.headers['accept-language'],
  })
  const t = stringsFor(lang)
  const loginView = () => ({ lang, sso: ssoEnabled, magic: magicEnabled })
  if (url.searchParams.get('lang')) {
    addCookie(res, `${langCookie}=${lang}; SameSite=Lax; Path=/; `
      + `Max-Age=${langCookieMaxAge}${cookieSecure ? '; Secure' : ''}`)
  }

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
    // Retired doors do not answer. Otherwise switching on single sign-on would
    // leave the mail path quietly usable.
    if (!magicEnabled) { html(res, renderLogin(loginView()), 404); return }
    const body = await formBody(req).catch(() => ({} as Record<string, string | undefined>))
    const email = body.email ?? ''
    // Always the same answer, so the endpoint cannot be used to discover who
    // has access.
    const formLang = pickLang({ query: body.lang ?? null, cookie: lang })
    await withClient(async c => {
      const out = await requestLink(c, email, allowedEmails, baseUrl || url.origin)
      if (out.link) await mailer.send(email.trim().toLowerCase(), out.link)
      else console.log(`[login] suppressed (${out.suppressed}) for a submitted address`)
    })
    html(res, renderLogin({ ...loginView(), lang: formLang, sent: true }))
    return
  }

  if (path === '/auth/callback') {
    const opened = await withClient(c => redeem(c, url.searchParams.get('token') ?? ''))
    if (!opened) {
      html(res, renderLogin({ ...loginView(), error: t.loginLinkDead }), 400)
      return
    }
    addCookie(res, sessionCookie(opened.id))
    redirect(res, '/')
    return
  }

  /* ---------------------------------------------------------- single sign-on */

  if (path === '/auth/sso') {
    if (!ssoEnabled) {
      html(res, notice(lang, t.noticeSsoUnconfigured, t.noticeSsoUnconfiguredBody), 400)
      return
    }
    try {
      const started = await withClient(c => beginLogin(c, entra))
      redirect(res, started!.url)
    } catch (err) {
      console.error(`sso could not start: ${(err as Error).message}`)
      html(res, notice(lang, t.noticeStartFailed, t.noticeStartFailedBody), 502)
    }
    return
  }

  if (path === '/auth/sso/callback') {
    const denied = url.searchParams.get('error')
    if (denied) {
      // Microsoft's own refusal — consent withdrawn, user cancelled, blocked by
      // a conditional-access policy. Their code, not their prose.
      console.log(`[sso] provider declined: ${denied}`)
      html(res, renderLogin({ ...loginView(),
        error: t.loginProviderDeclined(esc(denied)) }), 400)
      return
    }
    try {
      // Tagged explicitly rather than distinguished by which key is present:
      // a tag narrows reliably, and this is the branch that decides who gets in.
      type Outcome =
        | { kind: 'refused', reason: Refusal }
        | { kind: 'admitted', session: Session }
      const out = await withClient<Outcome>(async c => {
        const who = await completeLogin(c, entra, {
          code: url.searchParams.get('code') ?? '',
          state: url.searchParams.get('state') ?? '',
        })
        const verdict = admits(who, {
          tenantId: entra.tenantId, groups: allowedGroups, emails: allowedEmails,
        })
        if (!verdict.ok) return { kind: 'refused', reason: verdict.reason }
        return { kind: 'admitted', session: await openSession(c, who.email) }
      })
      // Checked apart from the refusal below, so a database that is simply not
      // there cannot be reported to somebody as "you are not allowed in".
      if (!out) {
        console.log('[sso] signed in, but no database to open a session in')
        html(res, renderLogin({ ...loginView(), error: t.loginFailed }), 503)
        return
      }
      if (out.kind === 'refused') {
        // The reason goes in the log, never the address: the address belongs to a
        // real person, and the reason is what anybody debugging this needs.
        const why = out.reason
        console.log(`[sso] refused: ${why}`)
        // Two of these are OUR configuration failing, not the person failing.
        // Saying which is not a hint to an attacker, and it is the difference
        // between a five-minute fix and an evening of guessing.
        const ours = why === 'groups_not_emitted'
        const message = ours ? t.loginGroupsNotEmitted
          : why === 'groups_overage' ? t.loginTooManyGroups
          : t.loginNotAdmitted
        html(res, renderLogin({ ...loginView(), error: message }), ours ? 500 : 403)
        return
      }
      console.log('[sso] session opened for an allowlisted account')
      addCookie(res, sessionCookie(out.session.id))
      redirect(res, '/')
    } catch (e) {
      // The browser gets one sentence and no diagnosis. Which check failed — a
      // bad signature, a foreign tenant, a replayed state — is exactly the
      // feedback an attacker would tune against, so it goes to the log only.
      console.error(`sso callback failed${e instanceof SsoError ? '' : ' unexpectedly'}: `
        + (e as Error).message)
      html(res, renderLogin({ ...loginView(), error: t.loginFailed }), 400)
    }
    return
  }

  if (path === '/auth/logout') {
    await withClient(c => destroy(c, cookies(req)[cookieName]))
    addCookie(res, `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`)
    redirect(res, '/')
    return
  }

  if (!session) { html(res, renderLogin(loginView())); return }

  /**
   * Starting an authorisation is gated even when the dashboard is not. Without a
   * gate anyone with the URL could complete a flow against THEIR MyDataValue
   * account, and we would store their grant as ours.
   */
  if (path === '/auth/mdv') {
    if (!gateEnabled) {
      html(res, notice(lang, t.noticeAuthBlocked, t.noticeAuthBlockedBody), 403)
      return
    }
    const missing = ['MDV_CLIENT_ID', 'MDV_CLIENT_SECRET', 'PUBLIC_BASE_URL']
      .filter(n => !process.env[n])
    if (missing.length) {
      html(res, notice(lang, t.noticeMissingVars,
        t.noticeMissingVarsBody(missing.map(m => `<code>${m}</code>`).join(', '))), 400)
      return
    }
    try {
      const started = await withClient(c => mdvBegin(c, {
        issuer: MDV_ISSUER,
        clientId: process.env.MDV_CLIENT_ID!,
        redirectUri: mdvRedirectUri,
        scopes: process.env.MDV_SCOPES ?? DEFAULT_SCOPES,
        startedBy: session.email || 'open',
      }))
      redirect(res, started!.url)
    } catch (err) {
      console.error(`mdv authorisation could not start: ${(err as Error).message}`)
      html(res, notice(lang, t.noticeStartFailed, t.noticeStartFailedBody), 502)
    }
    return
  }

  if (path === '/auth/mdv/callback') {
    const err = url.searchParams.get('error')
    if (err) {
      html(res, notice(lang, t.noticeMdvRefused, t.noticeMdvRefusedBody(esc(err))), 400)
      return
    }
    try {
      const token = await withClient(async c => {
        // Named `tok`, not `t`: `t` is the language table in this scope, and a
        // shadow that happens to work today is a trap for the next edit.
        const tok = await mdvComplete(c, {
          issuer: MDV_ISSUER,
          clientId: process.env.MDV_CLIENT_ID!,
          clientSecret: process.env.MDV_CLIENT_SECRET!,
          code: url.searchParams.get('code') ?? '',
          state: url.searchParams.get('state') ?? '',
        })
        await storeInitialToken(c, 'mdv', process.env.MDV_CLIENT_ID!, tok)
        return tok
      })
      // Never the token. The fact that one exists is the whole message.
      console.log(`mdv grant stored, expires_in ${token?.expires_in}s`)
      html(res, notice(lang, t.noticeMdvConnected,
        `${t.noticeMdvConnectedBody} <a href="/status?lang=${lang}">${esc(t.readiness)}</a>`))
    } catch (e) {
      console.error(`mdv callback failed: ${(e as Error).message}`)
      html(res, notice(lang, t.noticeAuthFailed, t.noticeAuthFailedBody), 400)
    }
    return
  }

  if (path === '/status') {
    const srcs = sourceStates()
    html(res, `<!doctype html><html lang="${t.htmlLang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revenue Engine — ${esc(t.readinessHeading)}</title>
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
<body><main><h1>${esc(t.readinessHeading)}</h1>
<p class="s">${t.readinessLead} · <a href="/?lang=${lang}">${esc(t.toDashboard)}</a>
 · <a href="/status?lang=${otherLang(lang)}" hreflang="${otherLang(lang)}">${esc(t.otherLangName)}</a></p>
<div class="card"><b>${esc(t.database)}</b> — ${db.configured
  ? db.reachable
    ? `<span class="ok">${esc(t.dbReady(db.tables, db.migrations.length))}</span>`
    : `<span class="no">${esc(t.dbUnreachable)}</span> — ${esc(db.error ?? '?')}`
  : `<span class="no">${esc(t.dbUnconfigured)}</span> — <code>DATABASE_URL</code>`}</div>
<div class="card"><table><thead><tr><th>${esc(t.colSource)}</th><th>${esc(t.colState)}</th>
<th>${esc(t.colWhatFor)}</th></tr></thead><tbody>
${srcs.map(x => `<tr><td><b>${x.name}</b></td><td>${x.ready
  ? `<span class="ok">${esc(t.connected)}</span>`
  : `<span class="no">${esc(t.missing)}</span> ${x.missing.map(m => `<code>${m}</code>`).join(' ')}`}</td>
  <td style="color:var(--mut)">${esc(t.sourceNotes[x.key])}</td></tr>`).join('')}
</tbody></table></div>
<div class="card"><b>Microsoft 365</b> — ${esc(t.redirectUriLabel)}
<code>${esc(entra.redirectUri)}</code> · ${esc(t.tenantLabel)} <code>${esc(entra.tenantId)}</code></div>
<div class="card"><b>MyDataValue</b> — ${esc(t.redirectUriLabel)}
<code>${esc(mdvRedirectUri)}</code>${gateEnabled
  ? ` · <a href="/auth/mdv?lang=${lang}">${esc(t.authoriseNow)}</a>`
  : ` · ${esc(t.authBlockedNoAllowlist)}`}</div>
<div class="card"><b>${esc(t.signIn)}</b> — ${gateEnabled
  ? `<span class="ok">${esc(t.signInActive)}</span>: ${[
      ssoEnabled ? esc(t.signInMicrosoft) : null,
      magicEnabled ? t.signInMailLink(esc(mailer.mode)) : null,
    ].filter(Boolean).join(' + ')}. ${(() => {
      const gates = [
        allowedGroups.length ? esc(t.admittedGroups(allowedGroups.length)) : null,
        allowedEmails.length ? esc(t.admittedCount(allowedEmails.length)) : null,
      ].filter(Boolean)
      if (!gates.length) return t.admittedWholeTenant
      return esc(t.admittedLead(gates.join(` ${t.admittedAnd} `)))
        + (gates.length > 1 ? ` ${t.admittedEveryGateApplies}` : '')
    })()}`
  : `<span class="no">${esc(t.signInOff)}</span> — ${t.loginNoMethod}`}</div>
</main></body></html>`)
    return
  }

  if (path === '/') {
    if (!pool) { html(res, renderLogin(loginView()), 503); return }
    const basis: q.Basis = url.searchParams.get('basis') === 'margin' ? 'margin' : 'revenue'
    const openId = url.searchParams.get('open')
    const data = await withClient(async c => {
      const rows = await q.portfolio(c, basis, lang)
      const open = rows.find(r => r.entityId === openId)
      return {
        lang, basis, openId: open ? openId : null, rows,
        counts: await q.counts(c),
        notAssessable: await q.notAssessable(c, lang),
        freshness: await q.freshness(c),
        gate: open?.worstFindingId ? await q.gate(c, open.worstFindingId, lang) : [],
        evidence: open?.worstFindingId ? await q.evidence(c, open.worstFindingId, lang) : [],
        demo: await q.isDemo(c),
        unprotected: !gateEnabled,
        email: session.email || undefined,
      }
    })
    html(res, renderDashboard(data!))
    return
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
  res.end('not found\n')
}

await boot()

const server = createServer((req, res) => {
  handle(req, res).catch(err => {
    // Never leak an internal message to the browser; the log is where it goes.
    console.error(`request failed: ${(err as Error).message}`)
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('error\n')
    }
  })
})
server.listen(PORT, () => console.log(`listening on ${PORT}`))
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => { server.close(() => process.exit(0)) })
}
