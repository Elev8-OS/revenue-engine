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
import { startImport, latestRun, releaseAbandoned, reportCounts, ImportBusyError,
  isFunnelReport, type AnyReport } from './import/run.js'
import type { FunnelReport } from './sources/mdv/funnel.js'
import { pickLang, stringsFor, otherLang, langCookie, langCookieMaxAge, type Lang }
  from './i18n.js'
import { publicOrigin } from './public-origin.js'
import { authFromEnv, sessionState as elev8Session } from './sources/elev8/auth.js'
import { retire, verdictFor, candidates as retireCandidates } from './entity/retire.js'
import { knownShapes, latestShape, allShapes, renderShapesText }
  from './sources/elev8/shape.js'
import { registerClient, clientCredentials, clientState } from './sources/mdv/register.js'
import { head, THEME_CSS } from './ui/theme.js'
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
    // reads:true as of the Customer API adapter. It was false for a long time and
    // the row said so, because a green line for a source with no adapter told
    // somebody their data was flowing when the key was read in exactly three
    // places: the schema, this list, and nowhere else.
    { name: 'PriceLabs', key: 'pricelabs' as const, reads: true,
      missing: need('PRICELABS_API_KEY') },
    // A SECOND ROW, not a footnote on the first. The Revenue Estimator is a
    // different credential — the specification says so — and it is the only
    // source that answers a cohort question. One combined row would report the
    // market side as covered whenever the Customer API key was set, which is
    // precisely the false green this list already learned about once.
    { name: 'PriceLabs · market', key: 'pricelabsMarket' as const, reads: true,
      missing: need('PRICELABS_ESTIMATOR_API_KEY') },
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
        if (outcome === 'seeded' || outcome === 'reseeded'
            || outcome === 'reseeded_stale') {
          console.log('mdv grant: the seed value is now spent — clear '
            + 'MDV_SEED_REFRESH_TOKEN from the deployment config; it is a live '
            + 'credential and it is no longer read')
        }
        if (outcome === 'kept_revoked') {
          console.log('mdv grant: REVOKED — the variable still holds the token that '
            + 'died with it. A new authorisation is needed, not a new token.')
        }
        // Said differently from revoked on purpose. For weeks this line claimed
        // "unrecoverable" about a grant the provider confirmed was live, because
        // the code recorded `invalid_grant` as a revocation. It is a token that
        // is behind, and the remedy is one variable.
        if (outcome === 'kept_stale') {
          console.log('mdv grant: the stored refresh token is BEHIND the chain — '
            + 'the grant itself is live. MDV_SEED_REFRESH_TOKEN still holds the '
            + 'same stale value; a current one is adopted on the next boot.')
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
 * Plain text, deliberately. Used by `/shapes.txt`, which exists to be COPIED —
 * into a chat, into a diff, into a mapper — and every character of markup in the
 * way is a character that has to be picked back out by hand.
 */
const plainText = (res: ServerResponse, body: string, status = 200) => {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
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
<html lang="${lang}"><head>${head(`${esc(title)}`)}</head>
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

  /**
   * The stylesheet, served before the sign-in gate on purpose.
   *
   * The login page needs it, and the login page is by definition reached without
   * a session. It carries no data — it is a palette and a set of class names —
   * so serving it to anybody who asks costs nothing and gates nothing.
   *
   * Cached for five minutes rather than for a year. There is no content hash in
   * the URL, so a long cache would mean a restyle that reaches nobody until they
   * clear their browser; five minutes is short enough that a deploy is visible
   * and long enough that a click-through of six pages fetches it once.
   */
  if (path === '/theme.css') {
    res.writeHead(200, {
      'content-type': 'text/css; charset=utf-8',
      'cache-control': 'public, max-age=300',
    })
    res.end(THEME_CSS)
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
  /**
   * Registers a client of our OWN, so this service stops sharing a grant.
   *
   * Two services on one grant strand each other by design: MDV rotates the
   * refresh token on every use, so whichever refreshes last leaves the other
   * holding a spent one. Observed today between this engine and the
   * `mydatavalue-mcp` server, minutes apart, in both directions.
   *
   * A POST, gated behind sign-in, because it creates a credential at the
   * provider. Registering twice is safe — the row is replaced — but it abandons
   * the previous client, so it is not something a link should do by being
   * followed.
   */
  if (path === '/auth/mdv/register' && req.method === 'POST') {
    if (!gateEnabled) {
      html(res, notice(lang, t.noticeAuthBlocked, t.noticeAuthBlockedBody), 403)
      return
    }
    if (!process.env.PUBLIC_BASE_URL) {
      html(res, notice(lang, t.noticeMissingVars,
        t.noticeMissingVarsBody('<code>PUBLIC_BASE_URL</code>')), 400)
      return
    }
    try {
      const reg = await withClient(c => registerClient(c, {
        issuer: MDV_ISSUER,
        redirectUri: mdvRedirectUri,
        clientName: process.env.MDV_CLIENT_NAME ?? 'Elev8 Revenue Engine',
        scopes: process.env.MDV_SCOPES ?? DEFAULT_SCOPES,
      }))
      // The client id is not a secret and an operator needs it to tell one
      // registration from another. The secret is never printed anywhere.
      console.log(`mdv client registered: ${reg!.clientId} `
        + `(${reg!.confidential ? 'confidential' : 'public'})`)
      html(res, notice(lang, t.noticeClientRegistered,
        `${t.noticeClientRegisteredBody(esc(reg!.clientId))} `
        + `<a href="/auth/mdv?lang=${lang}">${esc(t.authoriseNow)}</a>`))
    } catch (err) {
      console.error(`mdv client registration failed: ${(err as Error).message}`)
      html(res, notice(lang, t.noticeRegisterFailed, esc((err as Error).message)), 502)
    }
    return
  }

  if (path === '/auth/mdv') {
    if (!gateEnabled) {
      html(res, notice(lang, t.noticeAuthBlocked, t.noticeAuthBlockedBody), 403)
      return
    }
    // Our own registration first, the shared variable second. Once a client of
    // our own exists, still preferring the variable would mean the fix was built
    // and never used.
    const creds = await withClient(c => clientCredentials(c))
    if (!creds || !process.env.PUBLIC_BASE_URL) {
      const missing = [
        creds ? null : 'MDV_CLIENT_ID (or register a client of our own)',
        process.env.PUBLIC_BASE_URL ? null : 'PUBLIC_BASE_URL',
      ].filter(Boolean) as string[]
      html(res, notice(lang, t.noticeMissingVars,
        t.noticeMissingVarsBody(missing.map(m => `<code>${m}</code>`).join(', '))), 400)
      return
    }
    try {
      const started = await withClient(c => mdvBegin(c, {
        issuer: MDV_ISSUER,
        clientId: creds.clientId,
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
        // The SAME resolution as the start of the flow. Using the variable here
        // while the authorisation was begun with our own client would exchange
        // the code against the wrong client and fail with a message about
        // credentials.
        const creds = await clientCredentials(c)
        if (!creds) throw new Error('no MDV client: none registered and none configured')
        const tok = await mdvComplete(c, {
          issuer: MDV_ISSUER,
          clientId: creds.clientId,
          clientSecret: creds.clientSecret ?? '',
          code: url.searchParams.get('code') ?? '',
          state: url.searchParams.get('state') ?? '',
        })
        await storeInitialToken(c, 'mdv', creds.clientId, tok)
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
      rotation: number, revoked_at: Date | null, stale_since: Date | null
    }>(`select rotation, revoked_at, stale_since from oauth_token
          where provider = 'mdv'`)).rows[0])
    const elev8State = await withClient(c => elev8Session(c))
    // Which client this service is actually using. The operationally important
    // fact: a shared client means every refresh strands another service.
    const mdvClient = await withClient(c => clientCredentials(c))
    const mdvOwn = await withClient(c => clientState(c))
    const grantText = !grant ? `<span class="no">${esc(t.grantNone)}</span>`
      : grant.revoked_at ? `<span class="no">${esc(t.grantRevoked)}</span>`
      // Its own state, in its own colour. "Behind" is amber because it is
      // recoverable from one variable; red said "unrecoverable" about a live
      // grant for weeks, which is the error this whole card now exists to avoid.
      : grant.stale_since ? `<span class="part">${esc(t.grantStale)}</span>`
      : `<span class="ok">${esc(t.grantLive(grant.rotation))}</span>`
    html(res, `<!doctype html><html lang="${t.htmlLang}"><head>${head(`Revenue Engine — ${esc(t.readinessHeading)}`)}</head>
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
<div class="card"><b>MyDataValue</b> — ${grantText}<br>
${(() => {
  // Untranslated ids, translated sentence. A client id is not a secret and an
  // operator needs it verbatim to tell one registration from another.
  if (!mdvClient) return `<span class="no">${esc(t.clientNone)}</span>`
  return mdvClient.origin === 'own_registration'
    ? `<span class="ok">${esc(t.clientOwn(mdvClient.clientId))}</span>`
      + (mdvOwn?.secretExpiresAt
        ? ` · secret expires ${esc(mdvOwn.secretExpiresAt.toISOString().slice(0, 10))}`
        : '')
    : `<span class="part">${esc(t.clientShared(mdvClient.clientId))}</span>`
})()}
<form method="post" action="/auth/mdv/register?lang=${lang}" style="margin:.6rem 0 .2rem">
  <button type="submit"${gateEnabled ? '' : ' disabled'}>${esc(t.clientRegisterAction)}</button>
  <div class="sub">${esc(t.clientSharedCaution)}</div>
</form>
${esc(t.redirectUriLabel)}
<code>${esc(mdvRedirectUri)}</code>${gateEnabled
  ? ` · <a href="/auth/mdv?lang=${lang}">${esc(grant && !grant.revoked_at && !grant.stale_since
      ? t.grantReplace : t.authoriseNow)}</a>`
  : ` · ${esc(t.authBlockedNoAllowlist)}`}
${gateEnabled && grant && !grant.revoked_at && !grant.stale_since
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
 · <a href="/shapes">API response shapes</a> · <a href="/objects">Objects with no PMS id</a></div>
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

  /* ----------------------------------------------------------------- objects */

  /**
   * Objects with no PMS property id, with the evidence for and against each.
   *
   * A report, not a cleanup, and the distinction was earned. Three rows looked
   * like junk by name — a storage cupboard, an office, and "1 - 3 Plunge Pool" —
   * and deleting them was agreed. Then the PriceLabs account turned out to price
   * a listing called "1 - 3 Plunge Pool" with three units. A name is not
   * evidence, and the request had been made on the strength of one.
   *
   * So this page shows what the other systems say instead: a Channex room id
   * means the channel manager gave it a bookable unit, and an OTA link means it
   * is published for sale. Either one makes it a letting whatever it is called.
   * Neither makes it safe to remove. Nothing here changes any data.
   */

  /**
   * Acts on exactly the objects named in the form, and reports every one it
   * refused. Never "everything on the previous page": the list a reader is
   * looking at is the not-assessable list, which is objects with no BAND — a
   * different set from objects nothing sells. An object can lack a band because
   * nobody set its rooms up in Elev8, which is a data gap and not a reason to
   * delete a letting.
   */
  if (path === '/objects' && req.method === 'POST') {
    if (!pool) { html(res, notice(lang, 'Objects', t.loginFailed), 503); return }
    const form = await formBody(req).catch(() => ({} as Record<string, string | undefined>))
    const labels = (form.labels ?? '').split('\n').map(x => x.trim()).filter(Boolean)
    const outcome = await withClient(c => retire(c, labels))
    console.log(`objects retired by ${session.email || 'open'}: `
      + `${outcome?.deleted.length ?? 0} deleted, ${outcome?.deactivated.length ?? 0} deactivated, `
      + `${outcome?.kept.length ?? 0} kept`)
    const list = (items: { label: string, reason?: string }[]) => items.length
      ? `<ul>${items.map(i => `<li><b>${esc(i.label)}</b>${
          i.reason ? ` — ${esc(i.reason)}` : ''}</li>`).join('')}</ul>`
      : '<p style="color:var(--mut)">none</p>'
    html(res, notice(lang, 'Objects reviewed', `
<b>Deleted</b> ${list(outcome?.deleted ?? [])}
<b>Deactivated, record kept</b> ${list(outcome?.deactivated ?? [])}
<b>Kept — something sells these</b> ${list(outcome?.kept ?? [])}
<p><a href="/objects">back to the review</a></p>`))
    return
  }

  if (path === '/objects') {
    const rows = await withClient(c => q.withoutPmsId(c))
    const all = await withClient(c => retireCandidates(c))
    const removable = (all ?? []).map(c => ({ c, v: verdictFor(c) }))
      .filter(x => x.v.action !== 'keep')
    const safe = (rows ?? []).filter(r => !r.roomIds && !r.otaLinks)
    html(res, `<!doctype html><html lang="${t.htmlLang}"><head>${head(`Revenue Engine — Objects with no PMS id`)}</head>
<body><main><h1>Objects with no PMS id</h1>
<p class="s">Nothing on this page changes any data.
 · <a href="/status?lang=${lang}">${esc(t.readiness)}</a></p>
<div class="card"><p>An object with no Channex property id is <b>probably</b> not a
letting — but a name is not evidence. These two columns are:</p>
<p><b>Room ids</b> — the channel manager gave it a bookable unit.<br>
<b>OTA links</b> — it is published for sale on an OTA.<br>
Either one means it is a real letting, whatever it is called. <b>Both zero</b>
means nothing in any connected system treats it as bookable.</p></div>
${!rows?.length
  ? '<div class="card">Every active object has a PMS property id. Nothing to review.</div>'
  : `<div class="card"><table><thead><tr><th>Object</th><th>Market</th><th>Room ids</th>
<th>OTA links</th><th>Band</th><th>Sleeps</th><th>Verdict</th></tr></thead><tbody>
${rows.map(r => {
  const bookable = r.roomIds > 0 || r.otaLinks > 0
  return `<tr><td><b>${esc(r.label)}</b></td><td>${esc(r.market)}</td>
<td class="${r.roomIds ? 'keep' : ''}">${r.roomIds}</td>
<td class="${r.otaLinks ? 'keep' : ''}">${r.otaLinks}${
  r.otaSources ? ` <span style="color:var(--mut)">${esc(r.otaSources)}</span>` : ''}</td>
<td>${r.band ? esc(r.band) : '—'}</td><td>${r.sleeps ?? '—'}</td>
<td class="${bookable ? 'keep' : 'drop'}">${bookable
  ? 'a letting — keep' : 'nothing treats it as bookable'}</td></tr>`
}).join('')}
</tbody></table></div>
<div class="card"><p><b>${rows.length}</b> object(s) without a PMS property id, of
which <b>${safe.length}</b> have no room id and no OTA link.</p></div>`}
${removable.length ? `<div class="card"><p><b>Remove these ${removable.length}?</b>
Chosen by evidence, not by name: nothing in Elev8, Channex or either OTA treats
them as bookable.</p>
<table><thead><tr><th>Object</th><th>What happens</th><th>Why</th></tr></thead><tbody>
${removable.map(x => `<tr><td><b>${esc(x.c.label)}</b></td>
<td class="${x.v.action === 'delete' ? 'drop' : ''}">${x.v.action === 'delete'
  ? 'deleted' : 'deactivated, record kept'}</td>
<td style="color:var(--mut)">${esc(x.v.reason)}</td></tr>`).join('')}
</tbody></table>
<form method="post" action="/objects" style="margin-top:1rem">
<input type="hidden" name="labels" value="${esc(removable.map(x => x.c.label).join('\n'))}">
<button type="submit" style="font:inherit;font-weight:600;padding:.55rem 1rem;border-radius:3px;
border:1px solid var(--ink);background:var(--ink);color:var(--paper);cursor:pointer">
Remove these ${removable.length}</button>
</form>
<p style="color:var(--mut);font-size:.85rem;margin-top:.8rem">Anything with a room
id, an OTA link or a PMS property id is not on this list and cannot be removed
from here, whatever it is called. An object that has been measured is
deactivated rather than deleted, so the numbers behind it survive.</p></div>` : ''}
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
  /**
   * The same shapes as `/shapes`, as text, for every endpoint of a source at once.
   *
   * The HTML page shows one endpoint per click, which suits a person exploring.
   * It does not suit the job that follows a discovery pass: writing one mapper
   * against eleven endpoints, where the field names must arrive EXACTLY. Read off
   * a rendered page, `search_to_view_rate` and `search_to_views_rate` look the
   * same, and this project has already lost a deploy and a live run to precisely
   * that class of error twice — once on an Elev8 field name, once on an assumed
   * array orientation.
   *
   * So: no markup, no truncation, sorted, greppable. Still behind the sign-in
   * gate, because which endpoints an account answers is itself account data.
   */
  if (path === '/shapes.txt') {
    const src = url.searchParams.get('source') ?? undefined
    const recorded = await withClient(c => allShapes(c, src)) ?? []
    plainText(res, renderShapesText(recorded, { source: src }))
    return
  }

  if (path === '/shapes') {
    const rows = await withClient(c => knownShapes(c))
    const want = url.searchParams.get('endpoint')
    // The source is part of the key, and hardcoding 'elev8' here meant every
    // PriceLabs endpoint in the list above led to an empty detail view — a page
    // that answers "no shape recorded" about a shape it just listed.
    const from = url.searchParams.get('source') ?? 'elev8'
    const detail = want ? await withClient(c => latestShape(c, from, want)) : null
    const pct = (f: number, n: number) => n ? `${Math.round((f / n) * 100)}%` : '—'
    html(res, `<!doctype html><html lang="${t.htmlLang}"><head>${head(`Revenue Engine — API response shapes`)}</head>
<body><main><h1>API response shapes</h1>
<p class="s">Paths, JSON types and how often each was non-empty. Values are never
recorded — a shape is safe to keep, a sample of live data is not.
 · <a href="/status?lang=${lang}">${esc(t.readiness)}</a>
 · <a href="/shapes.txt">every endpoint as plain text</a>
 · <a href="/shapes.txt?source=${encodeURIComponent(from)}">just <code>${esc(from)}</code></a></p>
${!rows?.length ? '<div class="card">Nothing observed yet. Run an import.</div>' : `
<div class="card"><table><thead><tr><th>Source</th><th>Endpoint</th><th>Observed</th>
<th>Samples</th><th>Paths</th></tr></thead><tbody>
${rows.map(r => `<tr><td>${esc(r.source)}</td>
<td><a href="/shapes?source=${encodeURIComponent(r.source)}&amp;endpoint=${
  encodeURIComponent(r.endpoint)}"><code>${esc(r.endpoint)}</code></a></td>
<td>${esc(r.observedAt.toISOString().replace('T', ' ').slice(0, 16))} UTC</td>
<td>${r.sampleCount}</td><td>${r.paths}</td></tr>`).join('')}
</tbody></table></div>`}
${detail ? `<h2><code>${esc(from)}</code> · <code>${esc(want ?? '')}</code> — ${detail.sampleCount} sample(s)${
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

  /**
   * What the funnel pass actually read, per endpoint.
   *
   * Untranslated, like `/shapes`, and for the same reason: these are field names
   * off the wire, and the whole value of the block is that they can be compared
   * character by character against the provider's own report.
   *
   * The three lines that matter are `used`, `missing` and `unclaimed`. `used`
   * says which key fed which figure, so a number on the dashboard can be traced
   * back to the field it came from. `unclaimed` says which keys were present that
   * nothing asked for — which is the difference between "the funnel is empty" and
   * "the funnel is there under a name we did not anticipate", and the only reason
   * this build did not need another round trip to find out.
   */
  const funnelDetail = (report: AnyReport | null): string => {
    const fr = isFunnelReport(report) ? report
      : report && 'funnel' in report ? (report as { funnel?: FunnelReport }).funnel
      : undefined
    if (!fr) return ''
    const row = (label: string, value: string) =>
      `<tr><td class="mut">${esc(label)}</td><td><code>${esc(value)}</code></td></tr>`
    return `<div class="card"><h2 style="margin-top:0">Funnel pass \u00b7 ${
      esc(fr.asOf)}</h2>
<p class="s">${fr.snapshotRows} value(s) stored across ${fr.endpoints.length} endpoint(s).</p>
${fr.endpoints.map(ep => `<h3><code>${esc(ep.path)}</code></h3>
<table><tbody>
${row('status', String(ep.status))}
${row('rows', `${ep.rows} under ${ep.envelope || 'n/a'}`)}
${row('used', Object.entries(ep.resolution.used).map(([k, v]) => `${k}=${v}`).join('  ') || 'nothing matched')}
${row('missing', ep.resolution.missing.join(', ') || 'none')}
${row('unclaimed', ep.resolution.unclaimed.join(', ') || 'none')}
${row('stored', `${ep.snapshotRows} row(s) over ${ep.matched} object(s)`)}
${row('withheld', String(ep.withheld))}
${row('rate scale', ep.rateUnit)}
${ep.unresolvedIds.length ? row('ids matching nothing', ep.unresolvedIds.join(', ')) : ''}
${ep.note ? row('note', ep.note) : ''}
</tbody></table>`).join('')}</div>`
  }

  /* ------------------------------------------------------------------ import */

  if (path === '/import' && req.method === 'POST') {
    if (!pool) { html(res, notice(lang, t.importHeading, t.loginFailed), 503); return }
    const form = await formBody(req).catch(() => ({} as Record<string, string | undefined>))
    // Whitelisted, not passed through. `source` reaches an importer lookup and
    // an unknown value would only ever be a mistake or a probe.
    const source = form.source === 'elev8' ? 'elev8'
      : form.source === 'pricelabs' ? 'pricelabs'
      : form.source === 'checks' ? 'checks'
      : form.source === 'mdv-discover' ? 'mdv-discover'
      : form.source === 'mdv-funnel' ? 'mdv-funnel' : 'mdv'
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
    // The Customer API key alone. The Estimator key is optional by design: its
    // stage reports itself as not run, so gating the whole button on it would
    // withhold the price archive over a missing market benchmark.
    const priceLabsReady = Boolean(process.env.PRICELABS_API_KEY)
    const state = !run ? `<p>${esc(t.importNever)}</p>`
      : !run.finishedAt ? `<p>${esc(t.importRunningSince(when(run.startedAt)))}</p>`
      : run.error ? `<p class="no">${esc(t.importFailedWith(run.error))}</p>`
      : (() => {
          const n = reportCounts(run.report)
          return `<p><span class="ok">${esc(t.importFinishedAt(when(run.finishedAt)))}</span><br>`
            + `${esc(t.importCounts(n.created, n.known, n.unresolved))}</p>`
        })()
    html(res, `<!doctype html><html lang="${t.htmlLang}"><head>${head(`Revenue Engine — ${esc(t.importHeading)}`, { refresh: run && !run.finishedAt ? 5 : undefined })}</head>
<body><main><h1>${esc(t.importHeading)}</h1>
<p class="s"><a href="/status?lang=${lang}">${esc(t.importBack)}</a> · <a href="/import?lang=${lang}">${esc(t.importRefresh)}</a></p>
${demoOn ? `<div class="card warn">${t.importDemoStillOn}</div>` : ''}
${mdvReady ? '' : `<div class="card warn">${t.importNeedsMdv}</div>`}
<div class="card"><p>${esc(t.importLead)}</p>${state}
<form class="actions" method="post" action="/import?lang=${lang}">
  <span class="label">${esc(t.importStart)}</span>
  <button type="submit" name="source" value="elev8"${elev8Ready && (!run || run.finishedAt) ? '' : ' disabled'}>Elev8</button>
  <button type="submit" name="source" value="pricelabs"${priceLabsReady && (!run || run.finishedAt) ? '' : ' disabled'}>PriceLabs</button>
  <button type="submit" name="source" value="mdv"${mdvReady && (!run || run.finishedAt) ? '' : ' disabled'}>MyDataValue</button>
</form>
<form class="actions" method="post" action="/import?lang=${lang}">
  <span class="label">${esc(t.discoverStart)}</span>
  <button type="submit" name="source" value="mdv-discover"${mdvReady && (!run || run.finishedAt) ? '' : ' disabled'}>${esc(t.discoverRun)}</button>
</form>
<p class="sub">${esc(t.discoverNote)}</p>
<form class="actions" method="post" action="/import?lang=${lang}">
  <span class="label">${esc(t.funnelStart)}</span>
  <button type="submit" name="source" value="mdv-funnel"${mdvReady && (!run || run.finishedAt) ? '' : ' disabled'}>${esc(t.funnelRun)}</button>
</form>
<p class="sub">${esc(t.funnelNote)}</p>
<form class="actions" method="post" action="/import?lang=${lang}">
  <span class="label">${esc(t.checksStart)}</span>
  <button type="submit" name="source" value="checks"${!run || run.finishedAt ? '' : ' disabled'}>${esc(t.checksRun)}</button>
</form>
<p class="sub">${esc(t.checksNote)}</p>
<p class="sub">${run ? esc(t.lastRun(run.source)) : ''}</p></div>
${funnelDetail(run?.report ?? null)}
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
        signals: await q.signals(c),
        // The same measured state the checks use, so the macro block on a page
        // and the gate note inside a finding can never disagree.
        funnel: (await q.funnelState(c)).kind,
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
