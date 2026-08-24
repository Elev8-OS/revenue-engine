/**
 * The public ORIGIN, and only the origin.
 *
 * Every redirect URI in this service is built by appending a path to this value,
 * so a PUBLIC_BASE_URL that already carries one produces a doubled path:
 * `https://host/auth/sso/callback/auth/sso/callback`. That fails at the identity
 * provider with a redirect-URI mismatch, and the mismatch names an address that
 * exists nowhere in anyone's configuration — so the natural next move is to
 * register the doubled address, which "fixes" it by making the wrong thing work.
 *
 * It happened. The variable is named BASE_URL, the readiness page displays the
 * full callback address right next to it, and copying the one into the other is
 * the obvious mistake to make. Stripping is safe because this app serves its
 * routes from the root: a path here can only ever be an error, never an intent.
 *
 * A value that is not a URL at all yields '' — the same state as unset, which
 * disables single sign-on rather than building a broken redirect out of it. The
 * note is what makes that visible instead of mysterious.
 */
export function publicOrigin(raw: string | undefined): { origin: string, note?: string } {
  const value = (raw ?? '').trim()
  if (!value) return { origin: '' }
  let url: URL
  try { url = new URL(value) } catch {
    return { origin: '', note: `PUBLIC_BASE_URL is not a URL, so no redirect can be built from it` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { origin: '', note: `PUBLIC_BASE_URL must be http or https, not ${url.protocol}` }
  }
  const extra = url.pathname !== '/' ? url.pathname : ''
  return extra || url.search || url.hash
    ? { origin: url.origin,
        note: `PUBLIC_BASE_URL carried a path (${extra || url.search || url.hash}) and it was `
          + `ignored — set it to the origin only: ${url.origin}` }
    : { origin: url.origin }
}
