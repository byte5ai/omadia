/**
 * Epic #470 W1 — standalone egress-entry classifier (review round-4 high finding).
 *
 * The daemon takes the job's egress allowlist from the middleware's policy
 * response — the very party the daemon-side clamp is defending against. So the
 * allowlist is treated as UNTRUSTED input and validated here with the SAME rigour
 * as the image and env: every entry must be a bare hostname (no scheme, no port,
 * no path, no userinfo, no wildcard, no CIDR, no control characters) and must NOT
 * be an IP literal (a private/metadata literal such as `169.254.169.254` or
 * `10.0.0.1` must never become effective egress policy for a sandboxed job).
 *
 * This is a faithful PORT of the middleware's own classifier
 * (`src/devplatform/deriveJobPolicy.ts` → `classifyEgressEntry`, and the
 * `src/services/ssrfGuard.ts` IP predicates it leans on). It is COPIED, not
 * imported: the daemon is a standalone sidecar (dockerode + zod + node only) and
 * must not pull the middleware's TypeScript into its runtime. The two
 * implementations are kept in lockstep by `test/netClassify.test.mjs`, whose
 * table mirrors the middleware's classification — a parity test, so a change on
 * either side that lets the two drift fails loudly.
 *
 * NOTE on internal *names*: like the middleware, an operator-chosen internal NAME
 * (e.g. `artifactory.internal`) is KEPT — that is a deliberate allowlist choice,
 * unlike a raw metadata-range IP literal, which is refused. Keeping this parity
 * is the whole point: the middleware is the authority for what a name means, and
 * the daemon must classify identically so the two can never disagree.
 */

/**
 * Reduce an IPv4-mapped IPv6 literal to its dotted-quad form so the v4 range
 * checks see it. Both spellings must be handled: `::ffff:127.0.0.1` is what a
 * human writes, but a URL parser canonicalises it to the hex form
 * `::ffff:7f00:1` — and a bypass of the loopback/RFC1918 predicates is exactly
 * what that difference used to buy. (Ported from ssrfGuard.ts `toDottedQuad`.)
 *
 * @param {string} host
 * @returns {string}
 */
export function toDottedQuad(host) {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (m) {
    const hi = Number.parseInt(m[1] ?? '0', 16);
    const lo = Number.parseInt(m[2] ?? '0', 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
}

/**
 * Classify an IP LITERAL against internal/loopback/metadata ranges. Ported
 * verbatim from ssrfGuard.ts `isInternalIp` so the daemon rejects exactly the
 * internal targets the middleware does.
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isInternalIp(ip) {
  const v = ip.toLowerCase();
  const v4 = toDottedQuad(v);
  if (/^127\./.test(v4) || v4 === '::1') return true;
  if (/^169\.254\./.test(v4) || /^fe[89ab][0-9a-f]:/.test(v)) return true;
  if (/^10\./.test(v4) || /^192\.168\./.test(v4)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(v4)) return true;
  if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(v4)) return true;
  if (v4 === '0.0.0.0' || /^fc[0-9a-f]|^fd[0-9a-f]/.test(v)) return true;
  return false;
}

/**
 * Canonicalise a hostname: lowercase, strip IPv6 brackets, and strip a SINGLE
 * trailing FQDN dot. A residual trailing dot (i.e. `..`) is left in place so the
 * caller can reject it. (Ported from deriveJobPolicy.ts `normalizeHostname`.)
 *
 * @param {string} raw
 * @returns {string}
 */
function normalizeHostname(raw) {
  const h = raw.toLowerCase().replace(/^\[|\]$/g, '');
  return h.endsWith('.') ? h.slice(0, -1) : h;
}

/** One dot-separated DNS label: 1–63 chars, alphanumerics + inner hyphens. */
const HOSTNAME_LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A valid egress-allowlist entry is a BARE hostname — no scheme, no userinfo, no
 * port, no path/query/fragment, no wildcard, no whitespace/control chars — and
 * NOT an IP literal. Returns `{ host }` (the lowercased canonical form) for a
 * valid entry, or `{ reject }` with a reason string. Ported verbatim from
 * deriveJobPolicy.ts `classifyEgressEntry` (the daemon-side copy of the same
 * predicate, kept in lockstep by the parity test).
 *
 * @param {unknown} raw
 * @returns {{ host: string } | { reject: string }}
 */
export function classifyEgressEntry(raw) {
  if (typeof raw !== 'string') return { reject: 'not a string' };
  const trimmed = raw.trim();
  if (!trimmed) return { reject: 'empty' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f]/.test(trimmed)) return { reject: 'whitespace/control char' };
  if (trimmed.includes('://') || /^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return { reject: 'has a scheme' };
  if (/[/?#@]/.test(trimmed)) return { reject: 'has a path/userinfo' };
  if (trimmed.includes('*')) return { reject: 'wildcard not supported' };
  if (trimmed.includes(':')) return { reject: 'has a port or is an IPv6 literal' };
  if (trimmed.includes('\0')) return { reject: 'embedded NUL' };
  // Same normalisation as the clone_url path: strip a single trailing FQDN dot so
  // a trailing-dot literal (`169.254.169.254.`) is caught by the IP checks below
  // and a `foo.internal.` name is validated in canonical form.
  const lower = normalizeHostname(trimmed);
  // Canonicalise the entry the way a network consumer will: parse it as a URL
  // authority and read the hostname back. WHATWG URL parsing rewrites numeric,
  // hex, octal, and short-form IPv4 spellings to dotted-quad (`2130706433` →
  // `127.0.0.1`, `0x7f.0.0.1` → `127.0.0.1`, `017700000001` → `127.0.0.1`,
  // `3232235777` → `192.168.1.1`, `127.1` → `127.0.0.1`). A label-shaped pattern
  // match would happily accept those all-digit/hex strings as a "hostname" and so
  // allowlist loopback/RFC1918 under a non-dotted spelling. So if the parser
  // rewrites the host AT ALL, it was not the plain hostname it appeared to be —
  // reject the whole class here rather than enumerate spellings.
  let canonical;
  try {
    canonical = new URL(`http://${lower}/`).hostname;
  } catch {
    return { reject: 'not a valid hostname' };
  }
  if (canonical !== lower) return { reject: `not a bare hostname (URL parser rewrote it to ${canonical})` };
  // Reject IPv4 literals outright — including internal ones (metadata/RFC1918) and
  // bracketed IPv6 literals (a `:` was already refused above, but the canonical
  // form is checked for defence in depth).
  if (/^[0-9]+(\.[0-9]+){3}$/.test(canonical) || canonical.startsWith('[') || isInternalIp(canonical))
    return { reject: 'IP literal' };
  const labels = lower.split('.');
  if (!labels.every((l) => HOSTNAME_LABEL.test(l))) return { reject: 'not a valid hostname' };
  return { host: lower };
}
