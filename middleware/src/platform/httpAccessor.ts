import { isIP } from 'node:net';

import { fetch as undiciFetch } from 'undici';

import {
  HttpForbiddenError,
  HttpRateLimitError,
  type HttpAccessor,
} from '@omadia/plugin-api';

import {
  HttpBlockedAddressError,
  createGuardedAgent,
  isPublicIp,
} from './ssrfGuard.js';

/**
 * Per-plugin HTTP accessor. Enforces:
 *   - An effective outbound allow-list resolved from the manifest plus the
 *     operator-selected audit mode (#91).
 *   - A per-minute rolling rate limit via a simple token bucket.
 *   - http(s) only — other URL schemes are rejected.
 *
 * #91 audit modes (only honoured when the manifest declares
 * `permissions.network.web_scanner`):
 *   - `single-host`  — manifest `network.outbound[]` only (the default; also
 *                      the forced mode for every non-web_scanner plugin).
 *   - `allowlist`    — manifest hosts ∪ operator-curated `host_list` hosts.
 *   - `public-web`   — any public host; the SSRF guard (see ssrfGuard.ts)
 *                      hard-blocks private / loopback / link-local / metadata
 *                      addresses at connect time.
 *
 * Returns `undefined` (at the caller seam) when the plugin declares neither
 * outbound hosts nor `web_scanner` — in that case `ctx.http` is left unset.
 */

const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

export type AuditMode = 'single-host' | 'allowlist' | 'public-web';

export function isAuditMode(value: unknown): value is AuditMode {
  return (
    value === 'single-host' ||
    value === 'allowlist' ||
    value === 'public-web'
  );
}

export function createHttpAccessor(opts: {
  agentId: string;
  outbound: readonly string[];
  /** #91 — true iff the manifest declares `permissions.network.web_scanner`.
   *  A non-web_scanner plugin is always confined to `single-host`. */
  webScanner?: boolean;
  /** #91 — operator-selected audit mode. Honoured only when `webScanner`. */
  auditMode?: AuditMode;
  /** #91 — operator-curated extra hosts (from `host_list` setup fields).
   *  Unioned into the effective allow-list only in `allowlist` mode. */
  extraHosts?: readonly string[];
  /** Override the default 60 req/min cap. Tests only — not wired to manifest yet. */
  rateLimitPerMinute?: number;
  /** Test seam: the fetch used for the guarded public-web path. Production
   *  uses undici's OWN fetch — it must match the guarded undici `Agent`, or
   *  the global (version-skewed) fetch throws "invalid onRequestStart method". */
  guardedFetch?: (url: string, init: Record<string, unknown>) => Promise<Response>;
}): HttpAccessor {
  const { agentId, outbound } = opts;
  const limit = opts.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;

  // A non-web_scanner plugin is always confined to its manifest allow-list,
  // whatever an `audit_mode` config entry might say.
  const mode: AuditMode = opts.webScanner
    ? (opts.auditMode ?? 'single-host')
    : 'single-host';

  // Effective static allow-list: manifest outbound, plus operator-curated
  // extras only in `allowlist` mode.
  const staticHosts =
    mode === 'allowlist'
      ? [...outbound, ...(opts.extraHosts ?? [])]
      : [...outbound];
  const matchers = staticHosts.map(buildHostMatcher);

  const bucket = new TokenBucket(limit, 60_000);

  // The rebinding-safe dispatcher is built once and reused. Only public-web
  // mode needs it — the static-allow-list modes trust the named hosts.
  const guardedAgent = mode === 'public-web' ? createGuardedAgent() : undefined;

  // The guarded path MUST use undici's own fetch (see `guardedFetch` doc).
  const guardedFetch =
    opts.guardedFetch ??
    ((url: string, init: Record<string, unknown>): Promise<Response> =>
      undiciFetch(url, init as Parameters<typeof undiciFetch>[1]) as unknown as Promise<Response>);

  return {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      const parsed = safeParseUrl(url);
      if (!parsed) {
        throw new TypeError(`ctx.http: invalid URL '${url}'`);
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new HttpBlockedAddressError(
          agentId,
          parsed.protocol,
          'only http and https URLs are permitted via ctx.http',
        );
      }
      // `URL.hostname` brackets IPv6 literals (`[::1]`); strip them so the
      // host is a bare address for matching and SSRF classification.
      const rawHost = parsed.hostname.toLowerCase();
      const host =
        rawHost.startsWith('[') && rawHost.endsWith(']')
          ? rawHost.slice(1, -1)
          : rawHost;

      if (mode === 'public-web') {
        // Any public host is permitted; the guarded dispatcher enforces the
        // private-range blocklist at connect time. A literal-IP host never
        // triggers DNS, so reject non-public literal IPs here, up front.
        if (isIP(host) !== 0 && !isPublicIp(host)) {
          throw new HttpBlockedAddressError(
            agentId,
            host,
            'is a private, loopback, link-local or otherwise non-public address',
          );
        }
      } else if (!matchers.some((m) => m(host))) {
        throw new HttpForbiddenError(agentId, host);
      }

      if (!bucket.tryConsume()) {
        throw new HttpRateLimitError(agentId);
      }

      if (guardedAgent) {
        // undici's own fetch + the undici guarded Agent (see `guardedFetch`).
        return guardedFetch(url, { ...(init as Record<string, unknown>), dispatcher: guardedAgent });
      }
      return fetch(url, init);
    },
  };
}

function buildHostMatcher(pattern: string): (host: string) => boolean {
  const p = pattern.trim().toLowerCase();
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    return (host: string): boolean => {
      if (host === suffix) return false;
      if (!host.endsWith('.' + suffix)) return false;
      const sub = host.slice(0, host.length - suffix.length - 1);
      // Leading-wildcard matches one label only — `*.example.com` accepts
      // `api.example.com` but rejects `a.b.example.com`. Tightens the
      // blast radius if a typo puts too-broad a wildcard in a manifest.
      return sub.length > 0 && !sub.includes('.');
    };
  }
  return (host: string): boolean => host === p;
}

function safeParseUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** Simple rolling-window token bucket. Not wall-clock accurate (uses a
 *  fixed window rather than a sliding one), but good enough to prevent
 *  runaway loops from a broken plugin. */
class TokenBucket {
  private count = 0;
  private windowStart = Date.now();

  constructor(
    private readonly capacity: number,
    private readonly windowMs: number,
  ) {}

  tryConsume(): boolean {
    const now = Date.now();
    if (now - this.windowStart >= this.windowMs) {
      this.count = 0;
      this.windowStart = now;
    }
    if (this.count >= this.capacity) return false;
    this.count++;
    return true;
  }
}
