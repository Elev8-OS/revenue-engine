/**
 * Owning our own OAuth client, against a stand-in provider.
 *
 * WHY THIS EXISTS, and it was observed rather than anticipated: the engine
 * adopted a newly issued refresh token, ran an import, and rotated the chain.
 * The next call through the `mydatavalue-mcp` server answered `invalid_grant` —
 * its stored copy was a rotation behind. It works in both directions. Whichever
 * service refreshes last leaves the other holding a spent token, alternating,
 * with nothing wrong in either service.
 *
 * One grant cannot be shared. So the tests here are about the three ways owning
 * a client could still go wrong: the secret leaking out of the module, the
 * resolution preferring the shared variable after a registration exists, and a
 * provider response that carries no client_id being stored as if it did.
 */
import { createServer } from 'node:http'
import { Pool } from 'pg'
import { registerClient, clientCredentials, clientState, RegistrationError }
  from './sources/mdv/register.js'
import { resetDiscoveryCache } from './sources/mdv/oauth.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

const port = 4599
const issuer = `http://127.0.0.1:${port}`
const REDIRECT = 'https://profit.example.com/auth/mdv/callback'

let registerBody: Record<string, unknown> | null = null
let registerStatus = 201
let registerResponse: Record<string, unknown> = {
  client_id: 'own-client-1', client_secret: 'sh-should-never-leave-the-db',
  client_secret_expires_at: 0, registration_access_token: 'rat-1',
  registration_client_uri: `${issuer}/oauth/register/own-client-1`,
}
let advertiseRegistration = true

const srv = createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0]
  const json = (o: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o))
  }
  if (path === '/.well-known/oauth-authorization-server') {
    return json({
      issuer, authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      code_challenge_methods_supported: ['S256'],
      ...(advertiseRegistration ? { registration_endpoint: `${issuer}/oauth/register` } : {}),
    })
  }
  if (path === '/oauth/register') {
    const chunks: Buffer[] = []
    for await (const ch of req) chunks.push(ch as Buffer)
    registerBody = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>
    return json(registerResponse, registerStatus)
  }
  res.writeHead(404); res.end()
})
await new Promise<void>(r => srv.listen(port, r))

const c = await pool.connect()
await c.query('delete from oauth_client')

/* ------------------------------------------------------- 1 · the registration */

resetDiscoveryCache()
const reg = await registerClient(c, {
  issuer, redirectUri: REDIRECT, clientName: 'Elev8 Revenue Engine',
})
check('the client id comes back, because it is not a secret',
      reg.clientId === 'own-client-1')
check('and the secret does NOT: only whether one was issued',
      reg.confidential === true
      && !JSON.stringify(reg).includes('should-never-leave-the-db'), JSON.stringify(reg))
const asked = (registerBody ?? {}) as { redirect_uris?: string[], grant_types?: string[] }
check('exactly one redirect URI is requested, ours',
      JSON.stringify(asked.redirect_uris) === JSON.stringify([REDIRECT]))
check('the refresh_token grant is asked for, or the whole point is lost',
      (asked.grant_types ?? []).includes('refresh_token'))
check('no auth method is demanded: the provider decides whether we get a secret',
      !('token_endpoint_auth_method' in (registerBody ?? {})),
      JSON.stringify(Object.keys(registerBody ?? {})))
// RFC 7591: zero means "never expires". A date in the past would read as an
// expired secret on every screen that shows it.
check('client_secret_expires_at of 0 is stored as null, not as 1970',
      reg.secretExpiresAt === null)

/* --------------------------------------------------- 2 · resolution and custody */

const own = await clientCredentials(c, 'mdv', { MDV_CLIENT_ID: 'shared-x',
                                                MDV_CLIENT_SECRET: 'shared-secret' } as never)
check('our own registration WINS over the configured client',
      own?.origin === 'own_registration' && own?.clientId === 'own-client-1',
      JSON.stringify({ ...own, clientSecret: own?.clientSecret ? '<set>' : undefined }))
check('and the secret is handed to the caller that must present it',
      own?.clientSecret === 'sh-should-never-leave-the-db')

const state = await clientState(c)
check('the state view says a secret exists without saying what it is',
      state?.confidential === true
      && !JSON.stringify(state).includes('should-never-leave-the-db'), JSON.stringify(state))
check('and it carries the registration date, so an operator can date the client',
      state?.registeredAt instanceof Date)

await c.query('delete from oauth_client')
const shared = await clientCredentials(c, 'mdv', { MDV_CLIENT_ID: 'shared-x',
                                                  MDV_CLIENT_SECRET: 'shared-secret' } as never)
// Flaky beats dead — as long as the page says which one is in use.
check('with no registration it falls back to configuration and SAYS so',
      shared?.origin === 'configuration' && shared?.clientId === 'shared-x')
check('and with neither, it returns nothing rather than a half client',
      await clientCredentials(c, 'mdv', {} as never) === null)

/* ------------------------------------------------------------- 3 · the refusals */

registerStatus = 400
registerResponse = { error: 'invalid_redirect_uri',
                     error_description: 'redirect_uris must be https' }
resetDiscoveryCache()
let refused: unknown = null
try {
  await registerClient(c, { issuer, redirectUri: 'http://x/cb', clientName: 'X' })
} catch (e) { refused = e }
check('a refusal surfaces the provider’s own reason',
      refused instanceof RegistrationError
      && (refused as Error).message.includes('must be https'), String(refused))
check('and nothing was stored', (await clientState(c)) === null)

registerStatus = 201
registerResponse = { client_secret: 'orphan' }
resetDiscoveryCache()
let noId: unknown = null
try {
  await registerClient(c, { issuer, redirectUri: REDIRECT, clientName: 'X' })
} catch (e) { noId = e }
check('a response with no client_id is refused, not stored',
      noId instanceof RegistrationError, String(noId))
check('and the error names the keys it DID see, so the shape is debuggable',
      (noId as Error).message.includes('client_secret'), (noId as Error).message)
check('still nothing stored', (await clientState(c)) === null)

advertiseRegistration = false
resetDiscoveryCache()
let noEndpoint: unknown = null
try {
  await registerClient(c, { issuer, redirectUri: REDIRECT, clientName: 'X' })
} catch (e) { noEndpoint = e }
check('a provider that advertises no registration endpoint is said so plainly',
      noEndpoint instanceof RegistrationError
      && (noEndpoint as Error).message.includes('registration_endpoint'), String(noEndpoint))

/* ------------------------------------------------ 4 · a public client is allowed */

advertiseRegistration = true
registerResponse = { client_id: 'public-1' }
resetDiscoveryCache()
const pub = await registerClient(c, { issuer, redirectUri: REDIRECT, clientName: 'P' })
check('a client with no secret registers as public rather than failing',
      pub.confidential === false)
const pubCreds = await clientCredentials(c, 'mdv', {} as never)
check('and its credentials carry no secret to present',
      pubCreds?.clientId === 'public-1' && pubCreds?.clientSecret === undefined)

/* -------------------------------------------- 5 · re-registering replaces, once */

registerResponse = { client_id: 'own-client-2', client_secret: 's2' }
resetDiscoveryCache()
await registerClient(c, { issuer, redirectUri: REDIRECT, clientName: 'Again' })
const rows = await c.query<{ n: number }>(`select count(*)::int n from oauth_client`)
check('there is exactly one client per provider, never a spare with a live grant',
      rows.rows[0]!.n === 1, String(rows.rows[0]!.n))
check('and it is the newest one', (await clientState(c))?.clientId === 'own-client-2')

srv.close(); c.release(); await pool.end()
console.log(fails ? `\n${fails} FAILED` : '\nall green')
process.exit(fails ? 1 : 0)
