/** Authorisation flow. Discovery and the token endpoint are stubbed by a local
 *  server, so the PKCE, single-use and error paths are tested without touching
 *  the provider. */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { Pool } from 'pg'
import { discover, begin, complete, resetDiscoveryCache, FlowError, DEFAULT_SCOPES }
  from './sources/mdv/oauth.js'
import { storeInitialToken } from './sources/mdv/auth.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

// --- a stand-in provider
let seenVerifier = ''
let seenSecret = ''
let tokenCalls = 0
let rejectNext = false
const port = 4571
const issuer = `http://127.0.0.1:${port}`
const srv = createServer(async (req, res) => {
  if (req.url === '/.well-known/oauth-authorization-server') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post'],
    }))
    return
  }
  if (req.url === '/oauth/token') {
    tokenCalls++
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const p = new URLSearchParams(Buffer.concat(chunks).toString())
    seenVerifier = p.get('code_verifier') ?? ''
    seenSecret = p.get('client_secret') ?? ''
    if (rejectNext) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid_grant' }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }))
    return
  }
  res.writeHead(404); res.end()
})
await new Promise<void>(r => srv.listen(port, r))

const c = await pool.connect()
await c.query('truncate oauth_flow')
await c.query('truncate oauth_event'); await c.query('delete from oauth_token')

// 1 · discovery
resetDiscoveryCache()
const meta = await discover(issuer)
check('discovery reads the token endpoint from the provider',
      meta.token_endpoint === `${issuer}/oauth/token`)

// 2 · S256 refusal
resetDiscoveryCache()
const bad = createServer((_q, s) => {
  s.writeHead(200, { 'content-type': 'application/json' })
  s.end(JSON.stringify({ issuer: 'x', authorization_endpoint: 'http://x/a',
    token_endpoint: 'http://x/t', code_challenge_methods_supported: ['plain'] }))
})
await new Promise<void>(r => bad.listen(4572, r))
let refusedPlain = false
try { await discover('http://127.0.0.1:4572') } catch { refusedPlain = true }
check('a provider without S256 is refused, not downgraded', refusedPlain)
bad.close()
resetDiscoveryCache()

// 3 · the authorize URL carries a real S256 challenge for the stored verifier
const started = await begin(c, {
  issuer, clientId: 'cid', redirectUri: `${issuer}/auth/mdv/callback`, startedBy: 'reto',
})
const u = new URL(started.url)
const stored = await c.query<{ code_verifier: string }>(
  `select code_verifier from oauth_flow where state = $1`, [started.state])
const expected = createHash('sha256').update(stored.rows[0]!.code_verifier).digest('base64url')
check('code_challenge is S256 of the stored verifier',
      u.searchParams.get('code_challenge') === expected)
check('challenge method is declared', u.searchParams.get('code_challenge_method') === 'S256')
check('state travels in the URL', u.searchParams.get('state') === started.state)
check('default scopes are read-only',
      u.searchParams.get('scope') === DEFAULT_SCOPES && !DEFAULT_SCOPES.includes('write:'))

// 4 · exchange sends the verifier and the secret
const tok = await complete(c, {
  issuer, clientId: 'cid', clientSecret: 'sec', code: 'CODE', state: started.state })
check('the exchange returns a token', tok.access_token === 'AT' && tok.refresh_token === 'RT')
check('the verifier is what we stored', seenVerifier === stored.rows[0]!.code_verifier)
check('the client secret is sent', seenSecret === 'sec')

// 5 · replay gets nothing and does not reach the provider
const callsBefore = tokenCalls
let replayed = false
try {
  await complete(c, { issuer, clientId: 'cid', clientSecret: 'sec', code: 'CODE', state: started.state })
} catch (e) { replayed = e instanceof FlowError }
check('a replayed callback is refused', replayed)
check('and never reaches the provider', tokenCalls === callsBefore, `${tokenCalls - callsBefore} extra call(s)`)

// 6 · unknown and expired state
let unknown = false
try { await complete(c, { issuer, clientId: 'c', clientSecret: 's', code: 'X', state: 'nope' }) }
catch (e) { unknown = e instanceof FlowError }
check('an unknown state is refused', unknown)
const s2 = await begin(c, { issuer, clientId: 'cid', redirectUri: 'http://x/cb' })
await c.query(`update oauth_flow set expires_at = now() - interval '1 minute' where state = $1`, [s2.state])
let expired = false
try { await complete(c, { issuer, clientId: 'c', clientSecret: 's', code: 'X', state: s2.state }) }
catch (e) { expired = e instanceof FlowError }
check('an expired state is refused', expired)

// 7 · provider error surfaces its code, and no secret leaks into the message
const s3 = await begin(c, { issuer, clientId: 'cid', redirectUri: 'http://x/cb' })
rejectNext = true
let msg = ''
try { await complete(c, { issuer, clientId: 'cid', clientSecret: 'sec', code: 'C', state: s3.state }) }
catch (e) { msg = (e as Error).message }
rejectNext = false
check('the provider error code is surfaced', msg.includes('invalid_grant'), msg)
check('the error message contains no secret', !msg.includes('sec'))

// 8 · the token lands in custody
await storeInitialToken(c, 'mdv', 'cid', tok)
const row = await c.query<{ rotation: number, client_id: string }>(
  `select rotation, client_id from oauth_token where provider = 'mdv'`)
check('the token is stored at rotation 0', row.rows[0]!.rotation === 0 && row.rows[0]!.client_id === 'cid')

srv.close(); c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
