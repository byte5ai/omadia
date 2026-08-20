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

/**
 * Splits `?query`/`#fragment` off a raw path, ensures a leading `/`, and
 * resolves `.`/`..` segments via `path.posix.normalize` (which clamps at the
 * root — see the module header). Also refuses:
 *
 *  - an embedded scheme (`http://`, `//host/…`) — a path field must never
 *    smuggle a full URL past a same-host check via `path.resolve`-style
 *    reinterpretation downstream, so this is refused outright rather than
 *    normalised.
 *  - a NUL byte — defence in depth against a truncation trick some HTTP
 *    stacks are still vulnerable to.
 *
 * Both refusals throw; the broker turns that into a denial with a specific
 * reason rather than passing a hostile string through as "just another
 * mismatch".
 */
export function normalizePathForMatch(rawPath: string): NormalizedPath {
  if (rawPath.includes('\0')) {
    throw new Error('path must not contain a NUL byte');
  }
  const hashIndex = rawPath.indexOf('#');
  const withoutHash = hashIndex === -1 ? rawPath : rawPath.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf('?');
  const pathOnly = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const search = queryIndex === -1 ? '' : withoutHash.slice(queryIndex);

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(pathOnly) || pathOnly.startsWith('//')) {
    throw new Error('path must not embed a scheme or authority');
  }

  const withLeadingSlash = pathOnly.startsWith('/') ? pathOnly : `/${pathOnly}`;
  const normalized = path.posix.normalize(withLeadingSlash);
  return { pathname: normalized, search };
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
