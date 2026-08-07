/**
 * Client ID Metadata Documents (CIMD) — W2-4, issue #546.
 *
 * CIMD is a THIRD client-acquisition mode alongside the two that already
 * shipped in epic #459 W9. It is not a replacement for either:
 *
 *   stored  an OAuth client already persisted for this issuer.
 *   cimd    the `client_id` IS an https URL. omadia serves a small JSON
 *           document there; the authorization server DEREFERENCES that URL to
 *           learn `redirect_uris` / `client_name`. Replaces RFC 7591 Dynamic
 *           Client Registration at MCP-native brokers (Smithery-class).
 *   dcr     RFC 7591. Deprecated by the MCP spec on a 12-month clock, kept
 *           working, warned about.
 *   manual  an operator-registered app. THE ENTRA ID / OKTA PATH — neither IdP
 *           supports CIMD — and permanently supported.
 *
 * ⚠️ The load-bearing operational fact: CIMD inverts the network direction.
 * Every other mode only needs omadia to reach OUT (a redirect the browser
 * follows, an outbound POST). CIMD needs the IdP to reach IN and GET a URL on
 * omadia's own host. Behind a corporate firewall, on an air-gapped install, or
 * on any deployment whose public origin is not actually inbound-routable, that
 * is impossible. Such installs must degrade cleanly to the manual path — never
 * break — which is why every entry point here returns a reason string rather
 * than throwing, and why the metadata route answers 501 instead of 500.
 */

import { guardedOutboundFetch } from './guardedOutboundFetch.js';
import { assertPublicHttpsUrl } from './ssrfGuard.js';

/**
 * Path the metadata document is served from. Exported as the single shared
 * constant because three places must agree on it — the express route, the
 * requireAuth allowlist (`auth/publicPaths.ts`), and the `client_id` the
 * authorization server is handed. A copy-pasted literal in any one of them is
 * the exact drift class `publicPaths.ts`'s module doc was written about.
 */
export const CIMD_METADATA_PATH = '/.well-known/omadia-mcp-client';

/** `client_name` advertised in the document and on the DCR path, so the two
 *  modes present omadia identically in a provider's consent screen. */
export const CIMD_CLIENT_NAME = 'omadia MCP';

/** How long a reachability verdict is trusted before re-probing. */
const REACHABILITY_TTL_MS = 5 * 60 * 1000;

/** Cap on the self-probe response so a misconfigured reverse proxy that streams
 *  an HTML error page cannot be read unbounded. */
const MAX_DOCUMENT_BYTES = 64 * 1024;

const PROBE_TIMEOUT_MS = 5_000;

/** The served document's shape. `token_endpoint_auth_method: 'none'` is not a
 *  shortcut — a CIMD client is inherently public (its metadata is world
 *  readable), so PKCE is the only thing protecting the exchange, and claiming a
 *  confidential method would be a lie the AS could act on. */
export interface CimdClientMetadata {
  readonly client_id: string;
  readonly client_name: string;
  readonly redirect_uris: readonly string[];
  readonly token_endpoint_auth_method: 'none';
  readonly grant_types: readonly string[];
  readonly response_types: readonly string[];
}

/**
 * The stable metadata-document URL for a public base origin, or null when no
 * base origin is configured.
 *
 * Stability across restarts matters: the URL IS the `client_id`, and stored
 * `mcp_oauth_clients` rows reference it. Deriving it from `FLOW_PUBLIC_BASE_URL`
 * (config, not request state) is what makes it stable — deriving it from an
 * inbound `Host` header would mint a different client_id per proxy hop.
 */
export function cimdMetadataUrl(publicBaseUrl: string | null | undefined): string | null {
  if (!publicBaseUrl) return null;
  try {
    // `new URL(path, base)` normalises a trailing slash on the base, so
    // `https://h` and `https://h/` both yield one canonical URL.
    return new URL(CIMD_METADATA_PATH, publicBaseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Build the document served at {@link CIMD_METADATA_PATH}.
 *
 * `redirectUri` MUST be the value `McpOAuthService.redirectUri` holds. If the
 * two ever diverge, the AS validates the authorize request's `redirect_uri`
 * against this document, finds no match, and EVERY code exchange fails — a
 * failure that surfaces at the provider, far from its cause. `mcpOAuth.test.ts`
 * asserts the equality directly for that reason.
 */
export function buildCimdDocument(input: {
  readonly metadataUrl: string;
  readonly redirectUri: string;
  readonly clientName?: string;
}): CimdClientMetadata {
  return {
    // Self-referential by definition: the client_id a CIMD-aware AS receives is
    // the URL of this very document.
    client_id: input.metadataUrl,
    client_name: input.clientName ?? CIMD_CLIENT_NAME,
    redirect_uris: [input.redirectUri],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };
}

export interface CimdReachability {
  readonly reachable: boolean;
  /** Machine-readable reason when `reachable` is false. Null when reachable. */
  readonly reason: CimdBlockedReason | null;
}

export type CimdBlockedReason =
  | 'no_public_base_url'
  | 'not_public_https'
  | 'fetch_failed'
  | 'document_mismatch';

/**
 * Can an authorization server actually FETCH our metadata document?
 *
 * The honest answer cannot be known from inside the process — only the IdP's
 * own network can answer it. What IS knowable, and what this checks, are the
 * conditions that make the answer definitely "no":
 *
 *  1. no public base origin configured at all;
 *  2. the origin is not a public https host — `assertPublicHttpsUrl` rejects
 *     plain http, RFC1918 / loopback / link-local / CGNAT literals, `.internal`
 *     and `.local` names, and hostnames that DNS-resolve into those ranges.
 *     This is the same guard the discovery chain uses; a second validator would
 *     be a second thing to keep correct.
 *  3. the URL does not serve OUR document — fetched over the public name, so a
 *     reverse proxy that never routes `/.well-known/*` to the middleware, or a
 *     DNS name pointing somewhere else entirely, is caught.
 *
 * A "yes" is therefore a strong necessary condition, not a guarantee; a "no" is
 * conclusive, and the caller degrades to the manual path on it.
 */
export async function probeCimdReachable(input: {
  readonly metadataUrl: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}): Promise<CimdReachability> {
  const { metadataUrl } = input;
  if (!metadataUrl) return { reachable: false, reason: 'no_public_base_url' };
  try {
    await assertPublicHttpsUrl(metadataUrl);
  } catch {
    return { reachable: false, reason: 'not_public_https' };
  }
  // Guarded by default (see `guardedOutboundFetch`): this probe dereferences a
  // URL derived from operator config, and the pre-flight `assertPublicHttpsUrl`
  // above cannot bind its answer to the connection this fetch opens.
  const fetchImpl = input.fetchImpl ?? guardedOutboundFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? PROBE_TIMEOUT_MS);
  try {
    const res = await fetchImpl(metadataUrl, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
      // Same rule as every other guarded fetch: a redirect could bounce past
      // the SSRF check that was applied to the pre-redirect URL.
      redirect: 'error',
    });
    if (!res.ok) return { reachable: false, reason: 'fetch_failed' };
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_DOCUMENT_BYTES) {
      return { reachable: false, reason: 'document_mismatch' };
    }
    const doc = JSON.parse(text) as unknown;
    if (!doc || typeof doc !== 'object') {
      return { reachable: false, reason: 'document_mismatch' };
    }
    // The document must claim the very URL we fetched. A generic 200 from a
    // catch-all proxy route otherwise reads as success.
    if ((doc as { client_id?: unknown }).client_id !== metadataUrl) {
      return { reachable: false, reason: 'document_mismatch' };
    }
    return { reachable: true, reason: null };
  } catch {
    return { reachable: false, reason: 'fetch_failed' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * TTL cache around {@link probeCimdReachable}. The probe is one outbound HTTPS
 * request; `describeAuth` runs on every status poll of the MCP Control Center,
 * so an uncached probe would put the admin UI's refresh rate on our own
 * ingress.
 */
export class CimdReachabilityCache {
  private cached: { at: number; value: CimdReachability } | null = null;
  private inFlight: Promise<CimdReachability> | null = null;

  constructor(
    private readonly metadataUrl: string | null,
    private readonly deps: { fetchImpl?: typeof fetch; ttlMs?: number } = {},
  ) {}

  /** The metadata URL this cache probes (null when CIMD is unconfigured). */
  get url(): string | null {
    return this.metadataUrl;
  }

  async get(): Promise<CimdReachability> {
    const ttl = this.deps.ttlMs ?? REACHABILITY_TTL_MS;
    const hit = this.cached;
    if (hit && Date.now() - hit.at < ttl) return hit.value;
    // Single-flight: concurrent status polls otherwise each fire their own
    // probe against our own ingress.
    const existing = this.inFlight;
    if (existing) return existing;
    const attempt = probeCimdReachable({
      metadataUrl: this.metadataUrl,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    })
      .then((value) => {
        this.cached = { at: Date.now(), value };
        return value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = attempt;
    return attempt;
  }
}
