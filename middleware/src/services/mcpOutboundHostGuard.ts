/**
 * The operator outbound host rule (issues #1341 / #1342) — ONE implementation
 * for every operator-configured MCP target: registry URLs and manual MCP
 * `http`/`sse` server endpoints.
 *
 * Operator configuration is the same trust class as an SMTP relay in
 * `netAccessor.ts`: private/loopback hosts stay reachable because an intranet
 * registry or MCP server (or a Compose service name) is a legitimate setup.
 * What is refused is the link-local/cloud-metadata block — a classic SSRF
 * pivot. The check is two-layer (codex fold): the literal host string AND the
 * RESOLVED addresses, so a hostname or DNS alias that points at link-local is
 * caught too.
 *
 * Known gap, accepted: the address is resolved here and again by the transport
 * when it connects. A name whose DNS answer changes between the two lookups
 * (DNS rebinding) is not caught; closing that needs the connection pinned to
 * the checked address, which neither the registry fetch nor the MCP SDK
 * transports expose.
 */

import { isIP } from 'node:net';

import type { McpServerConfig } from '@omadia/orchestrator';

import { parseIpv6 } from '../platform/ssrfGuard.js';

/** Hostname aliases for cloud-metadata endpoints — refused even before DNS,
 *  since a name can front a link-local address (codex fold). */
const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
]);

/** IPv6 cloud-metadata endpoints: AWS IMDS on Nitro, GCP. Not link-local, so
 *  the fe80::/10 test does not cover them. */
const METADATA_IPV6 = ['fd00:ec2::254', 'fd20:ce::254'].map(ipv6Key);

function ipv6Key(ip: string): string {
  const bytes = parseIpv6(ip);
  return bytes === null ? ip : Buffer.from(bytes).toString('hex');
}

function stripBrackets(host: string): string {
  return host.toLowerCase().replace(/^\[|\]$/g, '');
}

export interface OutboundRefusal {
  readonly code: 'invalid_url' | 'blocked_host';
  readonly message: string;
}

/** `dns.promises.lookup(host, { all: true })` shape, injectable for tests. */
export type OutboundLookupFn = (
  host: string,
) => Promise<ReadonlyArray<{ readonly address: string }>>;

const defaultLookup: OutboundLookupFn = async (host) => {
  const { lookup } = await import('node:dns/promises');
  return lookup(host, { all: true });
};

/**
 * The IPv4 address an IPv6 address carries, in dotted form; any other input is
 * returned unchanged (lower-cased, brackets stripped).
 *
 * Covers IPv4-mapped (`::ffff:0:0/96`), SIIT (`::ffff:0:0:0/96`),
 * IPv4-compatible (`::/96`, except `::` and `::1`), NAT64 (`64:ff9b::/96`) and
 * 6to4 (`2002::/16`). Both spellings occur: `dns.lookup` reports
 * `::ffff:169.254.169.254`, while WHATWG `URL` normalizes the same literal in a
 * hostname to the hex form `::ffff:a9fe:a9fe` — a dotted-only check misses it.
 */
export function unmapIpv4(host: string): string {
  const h = stripBrackets(host);
  if (isIP(h) !== 6) return h;
  const b = parseIpv6(h);
  if (b === null) return h;
  const zero = (from: number, to: number): boolean => b.subarray(from, to).every((x) => x === 0);
  const v4At = (o: number): string =>
    `${String(b[o])}.${String(b[o + 1])}.${String(b[o + 2])}.${String(b[o + 3])}`;
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4At(12);
  if (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12)) return v4At(12);
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zero(4, 12)) return v4At(12);
  if (b[0] === 0x20 && b[1] === 0x02) return v4At(2);
  if (zero(0, 12) && !(zero(12, 15) && (b[15] ?? 0) <= 1)) return v4At(12);
  return h;
}

/** Sync host classification, no DNS. Returns a refusal reason or null. */
export function classifyHostSync(host: string): string | null {
  const h = stripBrackets(host);
  const v4 = unmapIpv4(h);
  if (METADATA_HOSTNAMES.has(h)) return `metadata hostname refused: ${h}`;
  if (isIP(h) === 6 && METADATA_IPV6.includes(ipv6Key(h))) {
    return `link-local/metadata address refused: ${h}`;
  }
  // Link-local (covers 169.254.169.254 IMDS) + IPv6 link-local.
  if (/^169\.254\./.test(v4) || /^fe[89ab][0-9a-f]:/.test(h)) {
    return `link-local/metadata address refused: ${h}`;
  }
  return null;
}

/** True for a resolved IP in a range a server-side fetch must never reach. */
export function isBlockedResolvedIp(ip: string): boolean {
  return classifyHostSync(ip) !== null;
}

/**
 * Check an operator-configured URL against the outbound host rule. Returns
 * null when the URL may be dialled, otherwise the refusal. Never throws.
 *
 * A DNS failure is NOT a refusal: the fetch/connect that follows fails loudly
 * on its own, and refusing here would only hide the real cause.
 */
export async function checkOperatorOutboundUrl(
  raw: string,
  lookup: OutboundLookupFn = defaultLookup,
): Promise<OutboundRefusal | null> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { code: 'invalid_url', message: `not a valid URL: ${raw}` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { code: 'invalid_url', message: `unsupported protocol: ${parsed.protocol}` };
  }
  const host = parsed.hostname;
  const syncReason = classifyHostSync(host);
  if (syncReason) return { code: 'blocked_host', message: syncReason };
  // Resolve and re-check: a DNS alias (metadata.google.internal, or an
  // attacker-controlled name resolving to 169.254.x) only shows its true
  // target after resolution.
  // `URL.hostname` keeps the brackets of an IPv6 literal, and `dns.lookup`
  // fails on them — which would skip this layer for every IPv6 literal.
  let results: ReadonlyArray<{ readonly address: string }>;
  try {
    results = await lookup(stripBrackets(host));
  } catch {
    return null;
  }
  for (const r of results) {
    if (isBlockedResolvedIp(r.address)) {
      return {
        code: 'blocked_host',
        message: `host "${host}" resolves to a link-local/metadata address (${r.address})`,
      };
    }
  }
  return null;
}

/** The message every stdio refusal carries — save time (HTTP 400) and connect
 *  time (discover/rescan/runtime) say the same thing. */
export const MCP_STDIO_DISABLED_MESSAGE =
  'stdio MCP servers are disabled on this installation (MCP_STDIO_ENABLED=false)';

/**
 * Thrown by the connect guard before any transport is built. Callers match on
 * `code` rather than `instanceof`, so the check survives the error crossing the
 * `@omadia/orchestrator` package boundary.
 */
export class McpEndpointRefusedError extends Error {
  constructor(
    readonly code: 'blocked_host' | 'stdio_disabled',
    message: string,
  ) {
    super(message);
    this.name = 'McpEndpointRefusedError';
  }
}

/** True for an error the connect guard raised (by `name` and `code`, see
 *  above — `McpRegistryError` uses `blocked_host` too). */
export function isMcpEndpointRefusal(
  err: unknown,
): err is { readonly code: 'blocked_host' | 'stdio_disabled'; readonly message: string } {
  if (!(err instanceof Error) || err.name !== 'McpEndpointRefusedError') return false;
  const code = (err as { code?: unknown }).code;
  return code === 'blocked_host' || code === 'stdio_disabled';
}

/**
 * The `connectGuard` for an `McpManager` (issues #1341 / #1342). Runs on the
 * config whose endpoint is actually dialled (placeholders substituted), so
 * every connect — Discover, test-call, Re-scan all, the periodic rescan and
 * runtime tool calls — is checked, including rows saved before the rule
 * existed.
 *
 * An unparseable http/sse endpoint is NOT refused here: the transport fails
 * loudly on it exactly as before, and the operator sees that real cause.
 */
export function createMcpConnectGuard(opts: {
  readonly stdioEnabled: boolean;
  readonly lookup?: OutboundLookupFn;
}): (cfg: McpServerConfig) => Promise<void> {
  return async (cfg) => {
    if (cfg.transport === 'stdio') {
      if (!opts.stdioEnabled) {
        throw new McpEndpointRefusedError('stdio_disabled', MCP_STDIO_DISABLED_MESSAGE);
      }
      return;
    }
    if (!cfg.endpoint) return;
    const refusal = await checkOperatorOutboundUrl(cfg.endpoint, opts.lookup);
    if (refusal?.code === 'blocked_host') {
      throw new McpEndpointRefusedError('blocked_host', refusal.message);
    }
  };
}
