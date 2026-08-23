/**
 * Single sign-on, against a stand-in identity provider.
 *
 * The provider here signs with a real RSA key generated for the run, so the
 * signature path is exercised rather than mocked. That matters: every rejection
 * below is a way in if the check is wrong, and none of them can be tested by
 * trusting the same function that produced the token.
 */
import { createServer } from 'node:http'
import { createHash, generateKeyPairSync, sign as signWith } from 'node:crypto'
import { Pool } from 'pg'
import {
  discover, beginLogin, completeLogin, verifyIdToken, admits, resetCaches,
  SsoError, SCOPES, type EntraConfig, type Identity,
} from './auth/entra.js'

const pool = new Pool({ connectionString: process.env.DATABASE_URL! })
let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}
/** Asserts that a call is refused, and reports what it said if it was not. */
async function refuses(name: string, fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); check(name, false, 'it was accepted'); return '' }
  catch (e) { check(name, e instanceof SsoError, (e as Error).message); return (e as Error).message }
}

/* ------------------------------------------------------- the stand-in provider */

const TID = '11111111-2222-3333-4444-555555555555'
const CID = 'client-id-under-test'
const SECRET = 'the-client-secret'
const port = 4581
const issuer = `http://127.0.0.1:${port}/${TID}/v2.0`

const keypair = (kid: string) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>
  return { kid, privateKey, jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' } }
}
let signer = keypair('key-1')

type Claims = Record<string, unknown>
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url')

/** Mints a real, correctly signed id_token for the given claims. */
function mint(claims: Claims, kid = signer.kid, key = signer.privateKey): string {
  const head = b64({ typ: 'JWT', alg: 'RS256', kid })
  const body = b64(claims)
  const sig = signWith('RSA-SHA256', Buffer.from(`${head}.${body}`), key)
  return `${head}.${body}.${sig.toString('base64url')}`
}

const now = () => Math.floor(Date.now() / 1000)
const goodClaims = (over: Claims = {}): Claims => ({
  iss: issuer, aud: CID, tid: TID, oid: 'the-object-id',
  preferred_username: 'Reto.Wyss@Elev8-Suite.com', name: 'Reto Wyss',
  iat: now(), exp: now() + 600, ...over,
})

let mintFor: Claims = {}
let tokenCalls = 0
let seenBody = new URLSearchParams()
let omitIdToken = false

const srv = createServer(async (req, res) => {
  const path = (req.url ?? '').split('?')[0]!
  const json = (o: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(o))
  }
  const meta = (over: Record<string, unknown> = {}) => json({
    issuer,
    authorization_endpoint: `http://127.0.0.1:${port}/authorize`,
    token_endpoint: `http://127.0.0.1:${port}/token`,
    jwks_uri: `http://127.0.0.1:${port}/keys`,
    id_token_signing_alg_values_supported: ['RS256'],
    ...over,
  })
  if (path === '/discovery') return meta()
  // What the `organizations` and `common` endpoints really return: a template.
  if (path === '/discovery-multitenant') {
    return meta({ issuer: 'http://127.0.0.1/{tenantid}/v2.0' })
  }
  if (path === '/discovery-no-rs256') {
    return meta({ id_token_signing_alg_values_supported: ['PS256'] })
  }
  if (path === '/keys') return json({ keys: [signer.jwk] })
  if (path === '/token') {
    tokenCalls++
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    seenBody = new URLSearchParams(Buffer.concat(chunks).toString())
    return json(omitIdToken ? { access_token: 'AT' } : { id_token: mint(mintFor) })
  }
  res.writeHead(404); res.end()
})
await new Promise<void>(r => srv.listen(port, r))

const base = `http://127.0.0.1:${port}`
const cfg: EntraConfig = {
  tenantId: TID, clientId: CID, clientSecret: SECRET,
  redirectUri: `${base}/auth/sso/callback`,
  discoveryUrl: `${base}/discovery`,
}

const c = await pool.connect()
await c.query('truncate oauth_flow')

/* --------------------------------------------------------------- 1 · discovery */

resetCaches()
const meta = await discover(cfg)
check('discovery reads the token endpoint from the provider',
      meta.token_endpoint === `${base}/token`)
await refuses('a templated issuer is refused, because iss could not be checked',
  () => discover({ ...cfg, discoveryUrl: `${base}/discovery-multitenant` }))
await refuses('a provider that does not offer RS256 is refused',
  () => discover({ ...cfg, discoveryUrl: `${base}/discovery-no-rs256` }))

/* ------------------------------------------------------- 2 · the redirect out */

const started = await beginLogin(c, cfg)
const u = new URL(started.url)
const flow = await c.query<{ code_verifier: string, nonce: string }>(
  'select code_verifier, nonce from oauth_flow where state = $1', [started.state])
const row = flow.rows[0]!
check('code_challenge is S256 of the stored verifier',
      u.searchParams.get('code_challenge')
        === createHash('sha256').update(row.code_verifier).digest('base64url'))
check('the nonce in the URL is the one we stored', u.searchParams.get('nonce') === row.nonce)
check('the nonce and the state are different values', row.nonce !== started.state)
check('only identity scopes are requested', u.searchParams.get('scope') === SCOPES)
check('the response comes back in the query, not the fragment',
      u.searchParams.get('response_mode') === 'query')
check('the account chooser is forced', u.searchParams.get('prompt') === 'select_account')

/* ------------------------------------------------------- 3 · the happy path */

mintFor = goodClaims({ nonce: row.nonce })
const who = await completeLogin(c, cfg, { code: 'CODE', state: started.state })
check('the address is normalised to lower case', who.email === 'reto.wyss@elev8-suite.com')
check('the display name survives', who.name === 'Reto Wyss')
check('the stable object id is the subject, not the address', who.subjectId === 'the-object-id')
check('the exchange sent the stored verifier',
      seenBody.get('code_verifier') === row.code_verifier)
check('the exchange sent the client secret', seenBody.get('client_secret') === SECRET)

/* --------------------------------------- 4 · a replay gets nothing, and quietly */

const before = tokenCalls
await refuses('a replayed callback is refused',
  () => completeLogin(c, cfg, { code: 'CODE', state: started.state }))
check('and never reaches the provider', tokenCalls === before,
      `${tokenCalls - before} extra call(s)`)
await refuses('an unknown state is refused',
  () => completeLogin(c, cfg, { code: 'X', state: 'never-issued' }))

const stale = await beginLogin(c, cfg)
await c.query(`update oauth_flow set expires_at = now() - interval '1 minute' where state = $1`,
              [stale.state])
await refuses('an expired state is refused',
  () => completeLogin(c, cfg, { code: 'X', state: stale.state }))

/* ------------------------------------------- 5 · every claim is load-bearing */

const N = 'the-expected-nonce'
const verify = (token: string, over: Partial<Parameters<typeof verifyIdToken>[1]> = {}) =>
  verifyIdToken(token, { meta, clientId: CID, tenantId: TID, nonce: N, ...over })

check('a correct token verifies',
      (await verify(mint(goodClaims({ nonce: N })))).email === 'reto.wyss@elev8-suite.com')

await refuses('a foreign issuer is refused',
  () => verify(mint(goodClaims({ nonce: N, iss: `${base}/other/v2.0` }))))
await refuses('a token minted for another application is refused',
  () => verify(mint(goodClaims({ nonce: N, aud: 'some-other-client' }))))
await refuses('a token from another directory is refused',
  () => verify(mint(goodClaims({ nonce: N, tid: '99999999-9999-9999-9999-999999999999' }))))
await refuses('a token bound to a different login is refused',
  () => verify(mint(goodClaims({ nonce: 'a-different-nonce' }))))
await refuses('an expired token is refused',
  () => verify(mint(goodClaims({ nonce: N, exp: now() - 3600 }))))
await refuses('a token issued in the future is refused',
  () => verify(mint(goodClaims({ nonce: N, iat: now() + 3600 }))))
await refuses('a token with no address is refused',
  () => verify(mint({ iss: issuer, aud: CID, tid: TID, oid: 'o', nonce: N,
                      iat: now(), exp: now() + 600 })))
check('aud may be an array containing us',
      (await verify(mint(goodClaims({ nonce: N, aud: ['someone-else', CID] })))).subjectId === 'the-object-id')
check('the email claim wins over the UPN when both are present',
      (await verify(mint(goodClaims({ nonce: N, email: 'Reto@Elev8-Suite.com' })))).email
        === 'reto@elev8-suite.com')

/* --------------------------------------------- 6 · the signature is not decorative */

const good = mint(goodClaims({ nonce: N }))
const [h, p, s] = good.split('.') as [string, string, string]
await refuses('a tampered payload is refused',
  () => verify(`${h}.${b64(goodClaims({ nonce: N, tid: TID, oid: 'someone-else' }))}.${s}`))
await refuses('a truncated signature is refused', () => verify(`${h}.${p}.${s.slice(0, -6)}`))
await refuses('an unsigned token is refused',
  () => verify(`${b64({ typ: 'JWT', alg: 'none' })}.${p}.`))
await refuses('a token signed with a symmetric algorithm is refused',
  () => verify(`${b64({ typ: 'JWT', alg: 'HS256', kid: signer.kid })}.${p}.${s}`))
await refuses('a token with no kid is refused',
  () => verify(`${b64({ typ: 'JWT', alg: 'RS256' })}.${p}.${s}`))
await refuses('something that is not a JWS at all is refused', () => verify('not.a.jwt.really'))

const stranger = keypair(signer.kid)          // right kid, wrong key
await refuses('a token signed by the wrong key is refused',
  () => verify(mint(goodClaims({ nonce: N }), stranger.kid, stranger.privateKey)))

/* ------------------------------------------------- 7 · the provider rotates keys */

// The cached key set now holds key-1. Microsoft rotates on its own schedule, and
// a cache that cannot miss is a cache that locks everyone out for an hour.
signer = keypair('key-2')
const afterRotation = await verify(mint(goodClaims({ nonce: N })))
check('a rotated signing key is fetched rather than assumed missing',
      afterRotation.email === 'reto.wyss@elev8-suite.com')

/* ----------------------------------------------------- 8 · a truthful failure */

omitIdToken = true
const s4 = await beginLogin(c, cfg)
const msg = await refuses('a token response without an id_token is refused',
  () => completeLogin(c, cfg, { code: 'C', state: s4.state }))
check('no failure message leaks the client secret', !msg.includes(SECRET))
omitIdToken = false

/* ------------------------------------------------------------- 9 · admission */

const G1 = 'aaaaaaaa-1111-1111-1111-aaaaaaaaaaaa'
const G2 = 'bbbbbbbb-2222-2222-2222-bbbbbbbbbbbb'
const person = (over: Partial<Identity> = {}): Identity => ({
  email: 'reto.wyss@elev8-suite.com', name: 'R', subjectId: 'o', tenantId: TID,
  groups: [], groupsEmitted: true, groupsOverage: false, ...over,
})
const verdict = (id: Identity, groups: string[] = [], emails: string[] = []) =>
  admits(id, { tenantId: TID, groups, emails })

// nothing configured: a closed door, but a wide one
check('with nothing configured, any member of the tenant is admitted',
      verdict(person()).ok)
check('a foreign tenant is refused even so',
      !verdict(person({ tenantId: 'another-tenant' })).ok)

// addresses
check('an allowlisted address is admitted',
      verdict(person(), [], ['reto.wyss@elev8-suite.com']).ok)
check('an authenticated address outside the allowlist is not',
      !verdict(person(), [], ['someone.else@elev8-suite.com']).ok)

// groups
check('a member of the permitted group is admitted',
      verdict(person({ groups: [G1] }), [G1]).ok)
check('a member of one of several permitted groups is admitted',
      verdict(person({ groups: [G2] }), [G1, G2]).ok)
check('group ids match regardless of case',
      verdict(person({ groups: [G1.toUpperCase()] }), [G1]).ok)
check('somebody in no permitted group is refused',
      verdict(person({ groups: ['cccccccc-3333-3333-3333-cccccccccccc'] }), [G1])
        .ok === false)

// the two failures that are OURS, not the person's, and must be distinguishable
const notEmitted = verdict(person({ groups: [], groupsEmitted: false }), [G1])
check('a groups claim that was never configured is refused as a configuration fault',
      !notEmitted.ok && notEmitted.reason === 'groups_not_emitted',
      notEmitted.ok ? 'admitted' : notEmitted.reason)
const emptyClaim = verdict(person({ groups: [], groupsEmitted: true }), [G1])
check('an EMPTY groups claim is refused as a real non-membership, not a fault',
      !emptyClaim.ok && emptyClaim.reason === 'not_in_group',
      emptyClaim.ok ? 'admitted' : emptyClaim.reason)
const overage = verdict(person({ groups: [], groupsOverage: true }), [G1])
check('more than 200 memberships is refused with its own reason',
      !overage.ok && overage.reason === 'groups_overage',
      overage.ok ? 'admitted' : overage.reason)

// every configured gate applies, so configuration can only ever narrow
check('group member with a non-allowlisted address is refused',
      !verdict(person({ groups: [G1] }), [G1], ['someone.else@elev8-suite.com']).ok)
check('allowlisted address outside the group is refused',
      !verdict(person({ groups: [] }), [G1], ['reto.wyss@elev8-suite.com']).ok)
check('both gates satisfied is admitted',
      verdict(person({ groups: [G1] }), [G1], ['reto.wyss@elev8-suite.com']).ok)

// and the claim actually survives the token
const withGroups = await verify(mint(goodClaims({ nonce: N, groups: [G1, G2] })))
check('the groups claim is read off a real signed token',
      withGroups.groups.length === 2 && withGroups.groups[0] === G1)
check('and the token is marked as having carried one', withGroups.groupsEmitted)
const noClaim = await verify(mint(goodClaims({ nonce: N })))
check('a token without the claim is marked as not carrying one', !noClaim.groupsEmitted)
const over = await verify(mint(goodClaims({ nonce: N, _claim_names: { groups: 'src1' } })))
check('the overage pointer is recognised as overage, not as no groups',
      over.groupsOverage && !over.groupsEmitted)

srv.close(); c.release(); await pool.end()
console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
