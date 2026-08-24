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
import { seedRefreshToken } from './sources/mdv/client.js'
import { startImport, latestRun, releaseAbandoned, reportCounts, ImportBusyError }
  from './import/run.js'
import { pickLang, stringsFor, otherLang, langCookie, langCookieMaxAge, type Lang }
  from './i18n.js'
import { publicOrigin } from './public-origin.js'
import { authFromEnv, sessionState as elev8Session } from './sources/elev8/auth.js'
import { knownShapes, latestShape } from './sources/elev8/shape.js'
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

const base = publicOrigin(process.env.PUBLIC_BASE_URL)
const baseUrl = base.origin
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
    // Two ways in, and either is enough. An API key is one header and nothing to
    // store; a login is a service account that expires. Reporting only the key
    // as "missing" would tell somebody who correctly configured the login that
    // they had not.
    { name: 'Elev8', key: 'elev8' as const, reads: true,
      missing: env.ELEV8_API_TOKEN || (env.ELEV8_LOGIN_EMAIL && env.ELEV8_LOGIN_PASSWORD)
        ? need('ELEV8_API_BASE')
        : [...need('ELEV8_API_BASE'), 'ELEV8_API_TOKEN or ELEV8_LOGIN_EMAIL+ELEV8_LOGIN_PASSWORD'] },
    // reads:false is the honest state and it has to be visible. A green row for
    // a source with no adapter told somebody their data was flowing when the key
    // was read in exactly three places: the schema, this list, and nowhere else.
    { name: 'PriceLabs', key: 'pricelabs' as const, reads: false, missing: need('PRICELABS_API_KEY') },
    // Channex is deliberately NOT listed any more. Elev8 proxies it in full —
    // the same room and occupancy fields, the same channel mappings, plus the
    // rooms Elev8 holds and Channex does not. A second row would ask for a
    // second key and a second rate limit for data we already have, and a
    // readiness page that asks for something nobody should set is worse than
    // one that stays quiet. The variable stays declared in config.ts so a
    // direct connection remains possible if that ever changes.
    { name: 'MyDataValue', key: 'mdv' as const, reads: true,
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

      // A refresh token handed over out-of-band, stored ONCE. The guard lives in
      // seedRefreshToken: after the first refresh the stored token has rotated
      // while the variable still holds the original, and presenting that is what
      // MDV treats as theft. So this is safe to leave running on every boot.

      // A redeploy is exactly when a run gets killed mid-import, and an
      // unfinished row would block every later attempt for good.
      const freed = await releaseAbandoned(c)
      if (freed) console.log(`import: released ${freed} abandoned run(s)`)

      if (process.env.MDV_CLIENT_ID) {
        const outcome = await seedRefreshToken(c, {
          clientId: process.env.MDV_CLIENT_ID,
          refreshToken: process.env.MDV_SEED_REFRESH_TOKEN,
        })
        console.log(`mdv grant: ${outcome}`)
        // Both branches that STORED the value leave it spent, and a spent
        // credential sitting in the deployment config is worth nothing and
        // risks everything.
        if (outcome === 'seeded' || outcome === 'reseeded') {
          console.log('mdv grant: the seed value is now spent — clear '
            + 'MDV_SEED_REFRESH_TOKEN from the deployment config; it is a live '
            + 'credential and it is no longer read')
        }
        if (outcome === 'kept_revoked') {
          console.log('mdv grant: REVOKED and unrecoverable as configured — the '
            + 'variable still holds the token that died with it. A newly issued '
            + 'refresh token in MDV_SEED_REFRESH_TOKEN is picked up on the next boot.')
        }
      }
    } finally { c.release() }
  } catch (err) {
    db.error = (err as Error).message
    console.error(`database not ready: ${db.error}`)
  }
  const gates = [
    allowedGroups.length ? `${allowedGroups.length} allowlisted group(s)` : null,
    allowedEmails.length ? `${allowedEmails.length} allowlisted address(es)` : null,
  ].filter(Boolean)
  // Loud, because the failure it prevents is one that misleads: the provider
  // names an address nobody configured, and registering THAT address makes the
  // mistake permanent.
  if (base.note) console.error(`configuration: ${base.note}`)
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
    // Reads the grant state, never the token. "Rotation 7" says everything a
    // human needs and is useless to anybody who steals it.
    const grant = await withClient(async db => (await db.query<{
      rotation: number, revoked_at: Date | null
    }>(`select rotation, revoked_at from oauth_token where provider = 'mdv'`)).rows[0])
    const elev8State = await withClient(c => elev8Session(c))
    const grantText = !grant ? `<span class="no">${esc(t.grantNone)}</span>`
      : grant.revoked_at ? `<span class="no">${esc(t.grantRevoked)}</span>`
      : `<span class="ok">${esc(t.grantLive(grant.rotation))}</span>`
    html(res, `<!doctype html><html lang="${t.htmlLang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revenue Engine — ${esc(t.readinessHeading)}</title>
<style>:root{color-scheme:light dark;--paper:#F1F3F1;--ink:#171C1B;--mut:#5D6B69;--line:#D2DAD6;--surface:#FBFCFA;--teal:#0D615E;--rust:#97392B;--brass:#8A6A1C}
@media(prefers-color-scheme:dark){:root{--paper:#0F1312;--ink:#E7ECE9;--mut:#94A3A0;--line:#28302E;--surface:#161B1A;--teal:#58C4BC;--rust:#E28A7C;--brass:#DFB44E}}
body{margin:0;background:var(--paper);color:var(--ink);padding:2.5rem 1.25rem;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
main{max-width:56rem;margin:0 auto}h1{font-size:1.4rem;margin:0 0 .3rem}
p.s{color:var(--mut);margin:0 0 1.5rem;font-size:.9rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:1rem 1.1rem;margin-bottom:.8rem}
table{width:100%;border-collapse:collapse;font-size:.9rem}
th{text-align:left;font-size:.64rem;text-transform:uppercase;letter-spacing:.1em;color:var(--mut);padding:0 .5rem .4rem 0;border-bottom:1px solid var(--line)}
td{padding:.5rem .5rem .5rem 0;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}code{font:500 .82em ui-monospace,monospace;color:var(--teal)}
.ok{color:var(--teal);font-weight:600}.no{color:var(--rust);font-weight:600}
.part{color:var(--brass);font-weight:600}a{color:inherit}</style></head>
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
  ? x.reads
    ? `<span class="ok">${esc(t.connected)}</span>`
    : `<span class="part">${esc(t.notRead)}</span>`
  : `<span class="no">${esc(t.missing)}</span> ${x.missing.map(m => `<code>${m}</code>`).join(' ')}`}</td>
  <td style="color:var(--mut)">${esc(t.sourceNotes[x.key])}</td></tr>`).join('')}
</tbody></table></div>
<div class="card"><b>Microsoft 365</b> — ${esc(t.redirectUriLabel)}
<code>${esc(entra.redirectUri)}</code> · ${esc(t.tenantLabel)} <code>${esc(entra.tenantId)}</code>
${base.note
  // Shown here rather than in a banner because this is the card that carries the
  // address the value gets confused with. Untranslated: it names a variable and
  // quotes a value, and both are the same in every language.
  ? `<br><span class="no">${esc(base.note)}</span>`
  : ''}</div>
<div class="card"><b>MyDataValue</b> — ${grantText}<br>${esc(t.redirectUriLabel)}
<code>${esc(mdvRedirectUri)}</code>${gateEnabled
  ? ` · <a href="/auth/mdv?lang=${lang}">${esc(grant && !grant.revoked_at
      ? t.grantReplace : t.authoriseNow)}</a>`
  : ` · ${esc(t.authBlockedNoAllowlist)}`}
${gateEnabled && grant && !grant.revoked_at
  // A live grant plus a prominent "authorise now" invites somebody to break a
  // working connection. Say what the link does before they find out — and only
  // where the link is actually shown, or the caution refers to nothing.
  ? `<br><span style="color:var(--mut);font-size:.85rem">${t.grantReplaceCaution}</span>`
  : ''}</div>
<div class="card"><b>Elev8</b> — ${(() => {
  // Which credential is LIVE, and what happened to it. Added because two
  // imports failed with `Unauthenticated` and there was no way to tell from
  // outside whether the service was presenting an API key or a login — which
  // need opposite fixes. A state nobody can read is a state nobody can repair.
  //
  // Deliberately untranslated: it names variables and reports a mode, and both
  // read the same in every language. No token, no password, no address.
  const resolved = authFromEnv()
  if (!resolved.auth) return `<span class="no">${esc(resolved.reason)}</span>`
  if (resolved.auth.mode === 'apikey') {
    return `<span class="no">using <code>ELEV8_API_TOKEN</code></span> — measured NOT to `
      + `open <code>/api/v1</code>; set <code>ELEV8_LOGIN_EMAIL</code> + `
      + `<code>ELEV8_LOGIN_PASSWORD</code>`
  }
  // Four states, and the order matters. A FAILED login writes a row too — it
  // exists to carry the error — so `present` is false with an error set, and
  // testing for the row instead of for `present` would report a login that has
  // never succeeded as "signed in, valid until ?". Which it did, until this was
  // read back.
  const st = elev8State
  if (st?.lastError) {
    return `<span class="no">login failing</span> (${st.failures}×): ${esc(st.lastError)}`
  }
  if (!st?.present) {
    return `<span class="ok">using <code>ELEV8_LOGIN_EMAIL</code></span> — not signed in yet`
  }
  return `<span class="ok">using <code>ELEV8_LOGIN_EMAIL</code></span> — signed in, `
    + `valid until ${esc(st.expiresAt?.toISOString().replace('T', ' ').slice(0, 16) ?? '?')} UTC`
})()}</div>
<div class="card"><b>${esc(t.importHeading)}</b> — <a href="/import?lang=${lang}">${esc(t.importStart)}</a>
 · <a href="/shapes">API response shapes</a></div>
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

  /* ------------------------------------------------------------------ shapes */

  /**
   * What the sources actually returned, as shapes rather than as data.
   *
   * This page is the payoff of api_shape, and it exists because of a specific
   * mistake. The importer had a rule meant to skip rows that are not rentable
   * objects, calibrated against a field called `listing_id` that was empty on 17
   * of 72 rows — measured through the MCP view. The REST endpoint names a
   * different field, so the rule never fired and a storage cupboard and an
   * office are now sitting in a revenue cohort.
   *
   * The fix is not another guess. It is looking at what the endpoint returns and
   * which of its fields is actually filled — which is exactly what got recorded
   * during the import and had nowhere to be read.
   *
   * Untranslated on purpose: field paths, JSON types and counts read the same in
   * every language, and inventing Indonesian for `rooms[].bed_type_id` would
   * make it harder to match against the API, not easier.
   */
  if (path === '/shapes') {
    const rows = await withClient(c => knownShapes(c))
    const want = url.searchParams.get('endpoint')
    const detail = want ? await withClient(c => latestShape(c, 'elev8', want)) : null
    const pct = (f: number, n: number) => n ? `${Math.round((f / n) * 100)}%` : '—'
    html(res, `<!doctype html><html lang="${t.htmlLang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Revenue Engine — API response shapes</title>
<style>:root{color-scheme:light dark;--paper:#F1F3F1;--ink:#171C1B;--mut:#5D6B69;--line:#D2DAD6;--surface:#FBFCFA;--teal:#0D615E;--rust:#97392B;--brass:#8A6A1C}
@media(prefers-color-scheme:dark){:root{--paper:#0F1312;--ink:#E7ECE9;--mut:#94A3A0;--line:#28302E;--surface:#161B1A;--teal:#58C4BC;--rust:#E28A7C;--brass:#DFB44E}}
body{margin:0;background:var(--paper);color:var(--ink);padding:2.5rem 1.25rem;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
main{max-width:60rem;margin:0 auto}h1{font-size:1.4rem;margin:0 0 .3rem}
h2{font-size:1rem;margin:1.8rem 0 .6rem}
p.s{color:var(--mut);margin:0 0 1.5rem;font-size:.9rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:1rem 1.1rem;margin-bottom:.8rem;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.88rem}
th{text-align:left;font-size:.64rem;text-transform:uppercase;letter-spacing:.1em;color:var(--mut);padding:0 .6rem .4rem 0;border-bottom:1px solid var(--line)}
td{padding:.35rem .6rem .35rem 0;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
code{font:500 .84em ui-monospace,monospace;color:var(--teal)}
.full{color:var(--teal);font-weight:600}.some{color:var(--brass);font-weight:600}.none{color:var(--rust);font-weight:600}
a{color:inherit}</style></head>
<body><main><h1>API response shapes</h1>
<p class="s">Paths, JSON types and how often each was non-empty. Values are never
recorded — a shape is safe to keep, a sample of live data is not.
 · <a href="/status?lang=${lang}">${esc(t.readiness)}</a></p>
${!rows?.length ? '<div class="card">Nothing observed yet. Run an import.</div>' : `
<div class="card"><table><thead><tr><th>Endpoint</th><th>Observed</th><th>Samples</th>
<th>Paths</th></tr></thead><tbody>
${rows.map(r => `<tr><td><a href="/shapes?endpoint=${encodeURIComponent(r.endpoint)}"><code>${esc(r.endpoint)}</code></a></td>
<td>${esc(r.observedAt.toISOString().replace('T', ' ').slice(0, 16))} UTC</td>
<td>${r.sampleCount}</td><td>${r.paths}</td></tr>`).join('')}
</tbody></table></div>`}
${detail ? `<h2><code>${esc(want ?? '')}</code> — ${detail.sampleCount} sample(s)${
  detail.note ? `, ${esc(detail.note)}` : ''}</h2>
<div class="card"><table><thead><tr><th>Path</th><th>Types</th><th>Filled</th><th></th>
</tr></thead><tbody>
${detail.shape.map(e => {
  // The fill share is the whole reason this page exists: a field that exists and
  // is empty is the failure mode reading documentation cannot catch.
  const share = e.total ? e.filled / e.total : 0
  const cls = share === 1 ? 'full' : share > 0 ? 'some' : 'none'
  return `<tr><td><code>${esc(e.path)}</code></td><td style="color:var(--mut)">${esc(e.types.join(' | '))}</td>
<td class="${cls}">${e.filled}/${e.total}</td><td class="${cls}">${pct(e.filled, e.total)}</td></tr>`
}).join('')}
</tbody></table></div>` : want ? `<div class="card">No shape recorded for <code>${esc(want)}</code>.</div>` : ''}
</main></body></html>`)
    return
  }

  /* ------------------------------------------------------------------ import */

  if (path === '/import' && req.method === 'POST') {
    if (!pool) { html(res, notice(lang, t.importHeading, t.loginFailed), 503); return }
    const form = await formBody(req).catch(() => ({} as Record<string, string | undefined>))
    // Whitelisted, not passed through. `source` reaches an importer lookup and
    // an unknown value would only ever be a mistake or a probe.
    const source = form.source === 'elev8' ? 'elev8' : 'mdv'
    try {
      await startImport(pool, { startedBy: session.email || 'open', source })
    } catch (err) {
      // Busy is not an error worth a page of its own; the import page says it.
      if (!(err instanceof ImportBusyError)) throw err
      console.log('[import] refused: already running')
    }
    redirect(res, `/import?lang=${lang}`)
    return
  }

  if (path === '/import') {
    const run = await withClient(c => latestRun(c))
    const mdvReady = Boolean(process.env.MDV_CLIENT_ID && process.env.MDV_CLIENT_SECRET)
    const demoOn = process.env.SEED_DEMO === 'true'
    const when = (d: Date) => d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    const elev8Ready = Boolean(process.env.ELEV8_API_BASE
      && (process.env.ELEV8_API_TOKEN
          || (process.env.ELEV8_LOGIN_EMAIL && process.env.ELEV8_LOGIN_PASSWORD)))
    const state = !run ? `<p>${esc(t.importNever)}</p>`
      : !run.finishedAt ? `<p>${esc(t.importRunningSince(when(run.startedAt)))}</p>`
      : run.error ? `<p class="no">${esc(t.importFailedWith(run.error))}</p>`
      : (() => {
          const n = reportCounts(run.report)
          return `<p><span class="ok">${esc(t.importFinishedAt(when(run.finishedAt)))}</span><br>`
            + `${esc(t.importCounts(n.created, n.known, n.unresolved))}</p>`
        })()
    html(res, `<!doctype html><html lang="${t.htmlLang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${run && !run.finishedAt
  // Only while something is actually running. There is no notification when an
  // import finishes, so without this the page is a state nobody is told about —
  // and reloading by hand to find out is not a design, it is a chore. A finished
  // page must NOT keep reloading: it would fight anybody reading the result.
  ? '<meta http-equiv="refresh" content="5">'
  : ''}
<title>Revenue Engine — ${esc(t.importHeading)}</title>
<style>:root{color-scheme:light dark;--paper:#F1F3F1;--ink:#171C1B;--mut:#5D6B69;--line:#D2DAD6;--surface:#FBFCFA;--teal:#0D615E;--rust:#97392B;--brass:#8A6A1C}
@media(prefers-color-scheme:dark){:root{--paper:#0F1312;--ink:#E7ECE9;--mut:#94A3A0;--line:#28302E;--surface:#161B1A;--teal:#58C4BC;--rust:#E28A7C;--brass:#DFB44E}}
body{margin:0;background:var(--paper);color:var(--ink);padding:2.5rem 1.25rem;font:15px/1.6 ui-sans-serif,system-ui,sans-serif}
main{max-width:44rem;margin:0 auto}h1{font-size:1.4rem;margin:0 0 .3rem}
p{margin:0 0 1rem}p.s{color:var(--mut);font-size:.9rem;margin-bottom:1.5rem}
.card{background:var(--surface);border:1px solid var(--line);border-radius:4px;padding:1rem 1.1rem;margin-bottom:.8rem}
.warn{border-left:3px solid var(--brass)}
button{font:inherit;font-weight:600;padding:.55rem 1rem;border-radius:3px;border:1px solid var(--ink);
background:var(--ink);color:var(--paper);cursor:pointer}
button[disabled]{opacity:.45;cursor:not-allowed}
code{font:500 .82em ui-monospace,monospace;color:var(--teal)}
.ok{color:var(--teal);font-weight:600}.no{color:var(--rust);font-weight:600}a{color:inherit}</style></head>
<body><main><h1>${esc(t.importHeading)}</h1>
<p class="s"><a href="/status?lang=${lang}">${esc(t.importBack)}</a> · <a href="/import?lang=${lang}">${esc(t.importRefresh)}</a></p>
${demoOn ? `<div class="card warn">${t.importDemoStillOn}</div>` : ''}
${mdvReady ? '' : `<div class="card warn">${t.importNeedsMdv}</div>`}
<div class="card"><p>${esc(t.importLead)}</p>${state}
<form method="post" action="/import?lang=${lang}">
  ${esc(t.importStart)}:
  <button type="submit" name="source" value="elev8"${elev8Ready && (!run || run.finishedAt) ? '' : ' disabled'}>Elev8</button>
  <button type="submit" name="source" value="mdv"${mdvReady && (!run || run.finishedAt) ? '' : ' disabled'}>MyDataValue</button>
</form>
<p style="color:var(--mut);font-size:.85rem;margin:.8rem 0 0">
  ${run ? esc(`${t.importHeading}: ${run.source}`) : ''}</p></div>
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
