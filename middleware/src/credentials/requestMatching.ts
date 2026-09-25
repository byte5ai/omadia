import path from 'node:path';

/**
 * #578 Phase 2 — the broker's request-matching primitives, split out from
 * `broker.ts` because these are the functions a traversal attack targets and
 * they need to be independently, exhaustively testable.
 *
 * ## The trap this file exists to close
 *
 * A credential's `pathPrefixes` (e.g. `/v1/messages`) are meaningless unless
 * every comparison against them happens on a NORMALISED path. Two ways an
 * unnormalised comparison fails, both real:
 *
 *  - **Traversal**: a request for `/v1/messages/../../admin` naively
 *    "starts with" `/v1/messages`, but resolves to `/admin` once traversed —
 *    a completely different resource the credential was never declared for.
 *  - **Boundary**: a naive `path.startsWith('/v1')` also matches
 *    `/v1extra/steal-data`, because `startsWith` has no concept of a path
 *    segment boundary.
 *
 * `matchPath` normalises BOTH sides (the declared prefix and the incoming
 * path) the same way, then requires the boundary to land on a `/` — closing
 * both holes with the same function so they cannot drift apart.
 *
 * Node's `path.posix.normalize` is doing the actual traversal-safety work
 * here: called on an absolute path, it clamps `..` at the root rather than
 * escaping above it (`path.posix.normalize('/a/../../b')` is `/b`, not
 * `/../b`) — so `/v1/messages/../../../admin` normalises to `/admin`, which
 * then correctly fails the `/v1/messages` prefix check.
 *
 * `path.posix` alone is not enough, though: fetch re-parses the URL with the
 * WHATWG parser, which ALSO resolves `%2e%2e`, reads `\` as `/` and strips
 * tab/LF/CR. The broker therefore matches the path {@link resolveWirePath}
 * returns — the one that actually goes on the wire (#778 S3a).
 */

/** Uppercased, trimmed HTTP method — `'get'` and `'GET'` must compare equal. */
export function normalizeMethod(rawMethod: string): string {
  return rawMethod.trim().toUpperCase();
}

/**
 * Lower-cased, trimmed host. DNS names are case-insensitive
 * (`API.Example.com` and `api.example.com` are the same host), so the
 * broker's declared `host` and an incoming request's host must fold the same
 * way or a differently-cased request would be wrongly refused — the safe
 * direction to get wrong, but still a bug worth closing here rather than
 * leaving it to be "discovered" as a confusing false-negative.
 *
 * Deliberately does NOT strip a `:port` suffix: `internal-api:8443` and
 * `internal-api` are different declared hosts, and collapsing them would
 * let a credential scoped to one port reach every port on that host.
 */
export function normalizeHost(rawHost: string): string {
  return rawHost.trim().toLowerCase();
}

export interface NormalizedPath {
  /** The path portion only, normalised and traversal-safe. Always starts
   *  with `/`. */
  readonly pathname: string;
  /** Everything from `?` onward (including the `?`), or `''` if none. Never
   *  itself matched against a prefix — a query string is not part of the
   *  resource path. */
  readonly search: string;
}

/** C0 controls and DEL. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/** Characters that would end or re-shape the authority of
 *  `https://${host}` instead of being part of the host. */
const NON_HOST_CHARACTER = /[/?#@\\\s]/;

/**
 * Splits `?query`/`#fragment` off a raw path, ensures a leading `/`, and
 * resolves `.`/`..` segments via `path.posix.normalize` (which clamps at the
 * root — see the module header). Also refuses:
 *
 *  - an embedded scheme (`http://`, `//host/…`) — a path field must never
 *    smuggle a full URL past a same-host check via `path.resolve`-style
 *    reinterpretation downstream, so this is refused outright rather than
 *    normalised.
 *  - a control character (C0 or DEL) anywhere — a NUL is a truncation trick
 *    some HTTP stacks are still vulnerable to, and the WHATWG URL parser
 *    fetch uses silently STRIPS tab, LF and CR, so `/v1/.\t./admin` would
 *    reach the wire as `/v1/../admin` (#778 S3a).
 *  - a backslash in the path — the WHATWG parser reads it as `/` for an
 *    `https` URL, so `..\..\admin` is a traversal that `path.posix` never
 *    sees. No caller can put a literal backslash on the wire anyway.
 *
 * Every refusal throws; the broker turns that into a denial with a specific
 * reason rather than passing a hostile string through as "just another
 * mismatch".
 *
 * Percent-encoded dot segments (`%2e%2e`, `.%2E`) are NOT handled here: this
 * is a string-level pre-check. {@link resolveWirePath} resolves what the
 * wire actually carries, and the broker matches that.
 */
export function normalizePathForMatch(rawPath: string): NormalizedPath {
  if (CONTROL_CHARACTER.test(rawPath)) {
    throw new Error('path must not contain a control character');
  }
  const hashIndex = rawPath.indexOf('#');
  const withoutHash = hashIndex === -1 ? rawPath : rawPath.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  const pathOnly = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const search = queryIndex === -1 ? '' : withoutHash.slice(queryIndex);

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pathOnly) || pathOnly.startsWith('//')) {
    throw new Error('path must not embed a scheme or authority');
  }
  if (pathOnly.includes('\\')) {
    throw new Error('path must not contain a backslash');
  }

  const withLeadingSlash = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`;
  const normalized = path.posix.normalize(withLeadingSlash);
  return { pathname: normalized, search };
}

/**
 * The path and query exactly as fetch will put them on the wire (#778 S3a).
 *
 * fetch parses the URL with the WHATWG parser, which resolves
 * percent-encoded dot segments (`%2e%2e`, `.%2E`, `%2E.` …) that
 * `path.posix.normalize` treats as ordinary names. So
 * `/v1/messages/%2e%2e/%2e%2e/admin` passes a string-level prefix check
 * against `/v1/messages` and then leaves as `GET /admin` with the secret
 * attached. The broker therefore matches `pathPrefixes` against THIS
 * result, audits it, and sends it — the checked path, the audited path and
 * the sent path are one string.
 *
 * The URL is built absolute (`https://host` + path), never resolved
 * relative to a base: a relative `/\evil.example.com` would re-target the
 * authority. `host` is the operator's declaration; anything that is not a
 * plain `host[:port]` (userinfo, a path, whitespace) or that the parser
 * rejects throws, and the broker denies it as `invalid-broker-declaration`.
 *
 * Serialising the result and parsing it again (as fetch does) is stable:
 * dot segments are gone and every other character is already in its
 * serialised form.
 */
export function resolveWirePath(host: string, pathname: string, search: string): NormalizedPath {
  if (host === '' || NON_HOST_CHARACTER.test(host)) {
    throw new Error('declared host is not a plain host[:port]');
  }
  const url = new URL(`https://${host}${pathname}${search}`);
  return { pathname: url.pathname, search: url.search };
}

/**
 * Whether `pathname` (already normalised) is covered by a declared
 * `prefix` — with a segment boundary, not a bare string prefix.
 *
 * `prefix` is normalised here too (a declaration author may write
 * `/v1/messages` or `/v1/messages/`; both must mean the same thing), and the
 * comparison requires either an exact match or the next character in
 * `pathname` after the prefix to be `/` — so a prefix of `/v1` matches
 * `/v1/anything` but NOT `/v1extra`.
 */
export function matchPath(pathname: string, prefix: string): boolean {
  const normalizedPrefix = path.posix.normalize(prefix.startsWith('/') ? prefix : `/${prefix}`);
  const withoutTrailingSlash =
    normalizedPrefix.length > 1 && normalizedPrefix.endsWith('/')
      ? normalizedPrefix.slice(0, -1)
      : normalizedPrefix;

  if (pathname === withoutTrailingSlash) return true;
  const boundary = withoutTrailingSlash === '/' ? '/' : `${withoutTrailingSlash}/`;
  return pathname.startsWith(boundary);
}

/** Whether `pathname` matches ANY of the declared prefixes. */
export function matchesAnyPrefix(pathname: string, prefixes: readonly string[]): boolean {
  return prefixes.some((prefix) => matchPath(pathname, prefix));
}
