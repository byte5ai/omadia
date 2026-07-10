/**
 * Shared SSRF guard for server-side fetches to URLs sourced from untrusted
 * third parties (MCP servers, OAuth authorization-server metadata) — epic #459
 * W9 codex fold. https-only, the literal host must not be internal, and the
 * RESOLVED addresses must all be public, so a public-looking hostname that
 * DNS-resolves to internal infrastructure is refused.
 */
export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.goog', 'metadata']);

/**
 * Reduce an IPv4-mapped IPv6 literal to its dotted-quad form so the v4 range
 * checks below see it. Both spellings must be handled: `::ffff:127.0.0.1` is
 * what a human writes, but `new URL('https://[::ffff:127.0.0.1]/').hostname`
 * canonicalises to the hex form `[::ffff:7f00:1]` — and a bypass of the
 * loopback/RFC1918 predicates is exactly what that difference used to buy.
 */
function toDottedQuad(host: string): string {
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (m) {
    const hi = Number.parseInt(m[1]!, 16);
    const lo = Number.parseInt(m[2]!, 16);
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
  }
  return host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
}

/** Sync host classification against internal/loopback/metadata ranges. Exported
 *  so the dev-platform job-policy derivation (epic #470 W1) rejects the same
 *  internal targets — a clone_url or egress entry pointing at RFC1918 space, the
 *  cloud-metadata endpoint, or an `.internal`/`localhost` name — with the ONE
 *  predicate the egress guard uses, so the two can never drift. */
export function isInternalHost(host: string): boolean {
  // Strip a single FQDN trailing dot BEFORE any check: `localhost.` and
  // `metadata.google.internal.` resolve to the same targets as their dotless
  // forms, so the `.internal`/`localhost`/metadata predicates must see the
  // canonical name (otherwise `…internal.` slips past `.endsWith('.internal')`).
  const stripped = host.toLowerCase().replace(/^\[|\]$/g, '');
  const h = stripped.endsWith('.') ? stripped.slice(0, -1) : stripped;
  if (METADATA_HOSTNAMES.has(h)) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.internal') || h.endsWith('.local'))
    return true;
  const v4 = toDottedQuad(h);
  if (/^127\./.test(v4) || v4 === '::1') return true;
  if (/^169\.254\./.test(v4) || /^fe[89ab][0-9a-f]:/.test(h)) return true;
  if (/^10\./.test(v4) || /^192\.168\./.test(v4)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(v4)) return true;
  if (/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./.test(v4)) return true;
  if (v4 === '0.0.0.0' || /^fc[0-9a-f]|^fd[0-9a-f]/.test(h)) return true;
  return false;
}

/** Sync classification of an IP LITERAL against internal/loopback/metadata
 *  ranges. Exported for the same reuse as {@link isInternalHost}. */
export function isInternalIp(ip: string): boolean {
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
 * Assert a URL is safe to fetch server-side: https, non-internal literal host,
 * and (via DNS) non-internal resolved addresses. Throws SsrfBlockedError
 * otherwise. Callers must ALSO pass `redirect: 'error'` to their fetch so a
 * redirect can't bounce past this check.
 */
export async function assertPublicHttpsUrl(rawUrl: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`invalid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(`refused non-https URL: ${parsed.protocol}`);
  }
  if (isInternalHost(parsed.hostname)) {
    throw new SsrfBlockedError(`refused internal host: ${parsed.hostname}`);
  }
  try {
    const { lookup } = await import('node:dns/promises');
    const results = await lookup(parsed.hostname, { all: true });
    for (const r of results) {
      if (isInternalIp(r.address)) {
        throw new SsrfBlockedError(`host ${parsed.hostname} resolves to internal ${r.address}`);
      }
    }
  } catch (err) {
    if (err instanceof SsrfBlockedError) throw err;
    // Unresolvable → the fetch fails loudly anyway; don't hard-block here.
  }
}
