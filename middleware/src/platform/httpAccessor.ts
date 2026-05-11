import {
  HttpForbiddenError,
  HttpRateLimitError,
  type HttpAccessor,
} from '@omadia/plugin-api';

/**
 * Per-plugin HTTP accessor. Built from the manifest's outbound allow-list.
 * Enforces:
 *   - Hostname whitelist with leading-wildcard support (`*.example.com`).
 *   - Per-minute rolling rate limit via a simple token bucket.
 *
 * Returns `undefined` (at the caller seam) when the manifest declares no
 * outbound hosts — in that case `ctx.http` is left unset and plugins that
 * try `ctx.http!.fetch(...)` get a runtime error at the language level
 * rather than a silent network call.
 */

const DEFAULT_RATE_LIMIT_PER_MINUTE = 60;

export function createHttpAccessor(opts: {
  agentId: string;
  outbound: readonly string[];
  /** Override the default 60 req/min cap. Tests only — not wired to manifest yet. */
  rateLimitPerMinute?: number;
}): HttpAccessor {
  const { agentId, outbound } = opts;
  const limit = opts.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const matchers = outbound.map(buildHostMatcher);
  const bucket = new TokenBucket(limit, 60_000);

  return {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      const parsed = safeParseUrl(url);
      if (!parsed) {
        throw new TypeError(`ctx.http: invalid URL '${url}'`);
      }
      const host = parsed.hostname.toLowerCase();
      if (!matchers.some((m) => m(host))) {
        throw new HttpForbiddenError(agentId, host);
      }
      if (!bucket.tryConsume()) {
        throw new HttpRateLimitError(agentId);
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
