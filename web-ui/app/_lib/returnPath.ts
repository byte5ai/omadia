/**
 * Post-login return paths: the `?return=` value that /login and /setup
 * navigate to once the operator is signed in (or the first admin exists).
 *
 * The value comes from the URL, so anyone who can send an operator a link
 * chooses it, and the navigation fires right after the operator typed a
 * password. It may only ever lead to a path on this origin. Checking
 * `startsWith('/') && !startsWith('//')` is not enough, because the browser
 * normalises the value before it navigates:
 *
 *   - the WHATWG URL parser reads `\` as `/` in http(s) URLs, so `/\evil.com`
 *     is `//evil.com`, a different host;
 *   - it drops TAB, LF and CR anywhere in the input first, so
 *     `/<TAB>/evil.com` is `//evil.com` as well;
 *   - dot segments collapse, so `/..//evil.com` normalises to the path
 *     `//evil.com`, which is protocol-relative again once used as a link.
 *
 * `sanitiseReturnPath` checks the shape of the raw value, parses it the way
 * the browser will, and hands out only the normalised path + query +
 * fragment after that result has passed the same shape check. Anything else
 * becomes `/`. Every page that navigates to a caller-supplied return value
 * goes through here; see docs/security-architecture.md §10e.
 *
 * Not folded into `navigation.ts` on purpose: its `hasUnsafeChars` /
 * `isCanonicalInAppHref` are stricter (no query, no percent-encoding), and
 * that module also carries a server-side fetch and a dynamic `next/headers`
 * import that do not belong in the login bundle. This file has no imports,
 * so client and server components can both use it.
 *
 * The middleware has its own `sanitiseReturnPath` (`routes/auth.ts`) for the
 * OIDC round trip. Its redirects append the value to `publicBaseUrl`, so it
 * only rejects, returns `null` rather than `/`, and does not normalise.
 */

/** Where every missing or rejected value lands. */
export const DEFAULT_RETURN_PATH = '/';

/**
 * Longest value accepted, checked before and after normalisation (the parser
 * percent-encodes, which can multiply the length). The app's own producers
 * send `pathname + search` of a real page, far below this; the cap bounds
 * what a hand-crafted link can push through the OIDC state cookie.
 */
export const MAX_RETURN_PATH_LENGTH = 2048;

/**
 * Fixed base the value is resolved against. `.invalid` is reserved
 * (RFC 6761) and never names a real host, and the base never appears in the
 * result. A constant instead of `window.location.origin`: once the shape
 * check has forced a single leading `/`, the verdict is the same for every
 * http(s) origin, so the server render (no `window`) and the browser agree
 * and the OIDC link on /login hydrates with the href the server sent. It also
 * keeps working under a stubbed or opaque (`"null"`) `window.location`, where
 * parsing against the origin would throw.
 */
const PARSE_BASE = new URL('http://omadia.invalid');

/**
 * The auth pages themselves. Returning to them after a login would show the
 * login form again (a signed-in visitor on /login is forwarded straight back
 * to `?return=`, so `/login` would loop), so they send the visitor to `/`.
 */
const AUTH_PAGE_PATHS: ReadonlySet<string> = new Set(['/login', '/setup']);

/**
 * Normalise a caller-supplied return value to a same-origin
 * path + query + fragment, or `/` when it is anything else.
 */
export function sanitiseReturnPath(raw: unknown): string {
  if (typeof raw !== 'string' || !hasSafeShape(raw)) return DEFAULT_RETURN_PATH;

  let url: URL;
  try {
    url = new URL(raw, PARSE_BASE);
  } catch {
    return DEFAULT_RETURN_PATH;
  }
  // Backstop only: the shape check already keeps the host fixed.
  if (url.origin !== PARSE_BASE.origin) return DEFAULT_RETURN_PATH;

  const normalised = url.pathname + url.search + url.hash;
  // What we hand out must pass the check we applied on the way in: dot
  // segments can turn `/..//evil.com` into `//evil.com`.
  if (!hasSafeShape(normalised)) return DEFAULT_RETURN_PATH;
  if (AUTH_PAGE_PATHS.has(withoutTrailingSlashes(url.pathname))) {
    return DEFAULT_RETURN_PATH;
  }
  return normalised;
}

/**
 * A root-relative path whose host a browser cannot change:
 *
 *   - 1..MAX_RETURN_PATH_LENGTH characters;
 *   - exactly one leading `/`: `//host` is protocol-relative, and `/\host`
 *     is the same thing to a browser;
 *   - no C0 control character or DEL anywhere: the parser strips TAB/LF/CR
 *     (`/<TAB>/host` becomes `//host`), and no legitimate path carries the
 *     others.
 *
 * A backslash further in is harmless and allowed: in the path the parser
 * turns it into `/`, and in the query it is a literal character that
 * `location.search` keeps, so the app's own producers can forward one.
 */
function hasSafeShape(value: string): boolean {
  if (value.length === 0 || value.length > MAX_RETURN_PATH_LENGTH) return false;
  if (value[0] !== '/') return false;
  if (value[1] === '/' || value[1] === '\\') return false;
  return !hasControlChars(value);
}

/** C0 controls (U+0000..U+001F) and DEL (U+007F). */
function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** So `/login/` hits the auth-page guard like `/login`; `/` stays `/`. */
function withoutTrailingSlashes(pathname: string): string {
  let end = pathname.length;
  while (end > 1 && pathname[end - 1] === '/') end -= 1;
  return pathname.slice(0, end);
}
