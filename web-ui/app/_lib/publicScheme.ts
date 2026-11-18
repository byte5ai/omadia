/**
 * The scheme this web-ui is reached over (`WEB_UI_PUBLIC_SCHEME`; issue #1310,
 * security-architecture §10o).
 *
 * A DECLARATION, not a derivation, because a Next Route Handler cannot observe
 * its own TLS state. There is no socket on `NextRequest`/`Request`, and
 * `req.url` / `req.nextUrl.protocol` are no help: next builds the request URL's
 * protocol FROM the header in question (`next/dist/server/next-server.js`:
 * `req.headers['x-forwarded-proto']?.includes('https') ? 'https' : 'http'`,
 * with `base-server.js` only `??=`-defaulting it when absent). Reading either
 * puts the browser's own value back in the answer.
 *
 * That mattered twice. The `/bot-api` proxy passes `X-Forwarded-Proto` to the
 * middleware, which decides the auth cookies' `Secure` flag from it; and the
 * pairing descriptor hands a desktop client the `wss://` canvas URL and the
 * `https://` login base it will use. Both were the caller's to pick.
 *
 * One function so the two readers cannot drift: a mismatch would mean the
 * cookie flag and the advertised scheme disagreed on the same deployment.
 */

/** `http` unless the operator declared otherwise — the safe end of the guess. */
export type PublicScheme = 'http' | 'https';

/**
 * `WEB_UI_PUBLIC_SCHEME`, read per request so a prebuilt image honours it
 * (same reason `MIDDLEWARE_URL` is resolved per request, never at module
 * scope). Anything other than `https` — unset, blank, a typo — reads as
 * `http`: this is the value that decides whether a cookie is marked TLS-only,
 * so an unrecognised setting must not resolve to the permissive answer.
 */
export function publicScheme(): PublicScheme {
  return process.env['WEB_UI_PUBLIC_SCHEME']?.trim().toLowerCase() === 'https'
    ? 'https'
    : 'http';
}

/** `wss` behind TLS, else `ws` — for the canvas URL in the pairing descriptor. */
export function publicWsScheme(): 'ws' | 'wss' {
  return publicScheme() === 'https' ? 'wss' : 'ws';
}
