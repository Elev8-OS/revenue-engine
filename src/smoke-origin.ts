/**
 * PUBLIC_BASE_URL normalisation.
 *
 * One live incident: the variable was set to the full callback address, so every
 * redirect came out as `.../auth/sso/callback/auth/sso/callback` and Microsoft
 * refused it — naming an address that appeared in nobody's configuration. The
 * dangerous part was not the failure, it was the obvious next move: register the
 * doubled address in Entra, which makes the wrong thing work permanently.
 *
 * Imported from a separate module rather than server.ts on purpose: importing
 * server.ts runs boot() and starts listening.
 */
import { publicOrigin } from './public-origin.js'

let fails = 0
const check = (n: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  — ' + extra : ''}`); if (!ok) fails++
}

check('a bare origin passes through untouched',
      publicOrigin('https://profit.elev8-suite.com').origin === 'https://profit.elev8-suite.com')
check('and says nothing about it',
      publicOrigin('https://profit.elev8-suite.com').note === undefined)
check('a trailing slash is not a path',
      publicOrigin('https://profit.elev8-suite.com/').origin === 'https://profit.elev8-suite.com')
check('and is silent too, because it is not a mistake',
      publicOrigin('https://profit.elev8-suite.com/').note === undefined)

// THE incident.
const doubled = publicOrigin('https://profit.elev8-suite.com/auth/sso/callback')
check('the full callback address is reduced to the origin',
      doubled.origin === 'https://profit.elev8-suite.com', doubled.origin)
check('and the path is named so the mistake is findable',
      Boolean(doubled.note?.includes('/auth/sso/callback')), doubled.note ?? '')
check('and the correct value is spelled out',
      Boolean(doubled.note?.includes('https://profit.elev8-suite.com')), doubled.note ?? '')

check('a port survives, since it is part of the origin',
      publicOrigin('http://localhost:3000').origin === 'http://localhost:3000')
check('a query is a mistake as well',
      publicOrigin('https://h.example/?x=1').note !== undefined)
check('unset stays unset and stays quiet',
      publicOrigin(undefined).origin === '' && publicOrigin(undefined).note === undefined)
check('whitespace only is the same as unset', publicOrigin('   ').origin === '')

// Not a URL: '' disables sign-on rather than building a broken redirect from it.
const junk = publicOrigin('profit.elev8-suite.com')
check('a bare host with no scheme is NOT silently accepted', junk.origin === '')
check('and it says why', Boolean(junk.note?.includes('not a URL')), junk.note ?? '')
const wrongScheme = publicOrigin('ftp://h.example')
check('a non-http scheme is refused', wrongScheme.origin === ''
      && Boolean(wrongScheme.note?.includes('http')), wrongScheme.note ?? '')

// The property that actually matters: appending a path can never double it.
for (const raw of ['https://h.example', 'https://h.example/', 'https://h.example/auth/sso/callback',
                   'https://h.example/some/prefix']) {
  const { origin } = publicOrigin(raw)
  const uri = `${origin}/auth/sso/callback`
  check(`'${raw}' yields exactly one callback path`,
        (uri.match(/\/auth\/sso\/callback/g) ?? []).length === 1, uri)
}

console.log(`\n${fails === 0 ? 'all green' : fails + ' FAILING'}`)
process.exit(fails ? 1 : 0)
