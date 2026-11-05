/**
 * Generic MCP authorization discovery (epic #459 W9). Reads a server's own
 * advertised auth requirements per the MCP Authorization spec — nothing here
 * is provider-specific:
 *   1. RFC 9728  {serverOrigin}/.well-known/oauth-protected-resource
 *      → authorization_servers[], scopes_supported, bearer_methods_supported
 *   2. RFC 8414  {issuer}/.well-known/oauth-authorization-server
 *      (fallback: /.well-known/openid-configuration)
 *      → authorization_endpoint, token_endpoint, registration_endpoint,
 *        code_challenge_methods_supported, grant_types_supported
 *
 * A server that returns a usable protected-resource document is treated as
 * OAuth-protected. "No discoverable auth" (null) needs an answer that actually
 * says so: the server replied, offered no document and did not challenge. A
 * timeout, a network error or a 5xx is NOT that answer — it says nothing about
 * the server, so it surfaces as `discovery_unavailable` instead of null.
 */

import { guardedOutboundFetch, readTextCapped } from './guardedOutboundFetch.js';
import { assertPublicHttpsUrl } from './ssrfGuard.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_METADATA_BYTES = 256 * 1024;

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorizationServers: readonly string[];
  readonly scopesSupported: readonly string[];
  readonly bearerMethods: readonly string[];
}

export interface AuthServerMetadata {
  readonly issuer: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly registrationEndpoint: string | null;
  readonly codeChallengeMethods: readonly string[];
  readonly grantTypes: readonly string[];
  readonly scopesSupported: readonly string[];
  /** RFC 9207 `authorization_response_iss_parameter_supported` (W0-1, D1). When
   *  the AS advertises this, an authorization response WITHOUT `iss` is a
   *  protocol violation and must be rejected — that is what makes mix-up
   *  detection enforceable rather than best-effort. */
  readonly issParameterSupported: boolean;
  /** `client_id_metadata_document_supported` (W2-4). True when this AS accepts a
   *  Client ID Metadata Document — an https `client_id` it DEREFERENCES — in
   *  place of a pre-registered or dynamically-registered client. Only advertised
   *  by MCP-native brokers; Entra ID and Okta never set it, which is precisely
   *  why the manual client path stays permanent. */
  readonly clientIdMetadataDocumentSupported: boolean;
}

export interface DiscoveredAuth {
  readonly resource: ProtectedResourceMetadata;
  readonly server: AuthServerMetadata;
}

/** The metadata could not be read right now (timeout, network, 5xx, 429). Says
 *  nothing about whether the server is protected. */
export const DISCOVERY_UNAVAILABLE = 'discovery_unavailable';
/** The server answered 401 but offers no usable metadata: it wants a credential
 *  of some kind, and OAuth cannot be set up from what it advertises. */
export const UNADVERTISED_AUTH_CHALLENGE = 'unadvertised_auth_challenge';

export class McpAuthDiscoveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpAuthDiscoveryError';
  }
}

function strArr(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v : null;
}

/** RFC 9207 §2.4 / RFC 8414 §3.3: compare issuer identifiers exactly, modulo one
 *  trailing slash (`https://as.example` and `https://as.example/` are the same
 *  AS). Deliberately NOT a loose/normalizing comparison — that would reintroduce
 *  the mix-up the check exists to prevent.
 *
 *  Lives here, next to the metadata fetch that must apply it, and is imported by
 *  `mcpOAuthService` rather than duplicated: two copies of an identity
 *  comparison is two places for one of them to drift loose. */
export function canonicalIssuer(s: string): string {
  return s.trim().replace(/\/+$/, '');
}

export function sameIssuer(a: string, b: string): boolean {
  return canonicalIssuer(a) !== '' && canonicalIssuer(a) === canonicalIssuer(b);
}

/** Answers a retry could change. Every other status is the server's own say and
 *  stands as "no document here". */
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 425 || status === 429;
}

/** The origin an MCP server's well-known documents live under (scheme+host). */
export function serverOrigin(endpoint: string): string {
  return new URL(endpoint).origin;
}

export interface McpAuthDiscoveryDeps {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;
/** A failure is only remembered long enough to spare the remote a burst of status
 *  polls; a retry a little later must reach the server again. */
const DISCOVERY_FAILURE_CACHE_TTL_MS = 15 * 1000;

type DiscoveryCacheEntry =
  | { readonly at: number; readonly ttlMs: number; readonly value: DiscoveredAuth | null }
  | { readonly at: number; readonly ttlMs: number; readonly failure: McpAuthDiscoveryError };

/** One metadata GET. `absent` is the server's answer that there is no document;
 *  `unavailable` means no such answer was obtained. */
type MetadataFetch =
  | { readonly kind: 'doc'; readonly doc: Record<string, unknown> }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unavailable'; readonly reason: string };

/** What an unauthenticated `initialize` revealed. `challenge` is a 401 without
 *  usable metadata behind it. */
type ChallengeProbe =
  | { readonly kind: 'resource'; readonly resource: ProtectedResourceMetadata }
  | { readonly kind: 'none' }
  | { readonly kind: 'challenge' }
  | { readonly kind: 'unavailable'; readonly reason: string };

export class McpAuthDiscovery {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, DiscoveryCacheEntry>();

  constructor(deps?: McpAuthDiscoveryDeps) {
    // Guarded by default (see `guardedOutboundFetch`): discovery follows a URL
    // the REMOTE MCP server chose, so the connect-time address check is the
    // boundary. Tests still inject their own.
    this.fetchImpl = deps?.fetchImpl ?? guardedOutboundFetch;
    this.timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Full discovery from a server endpoint URL. Returns null only when the
   *  server answered that it is not discoverably auth-protected. Throws
   *  `McpAuthDiscoveryError` on a malformed/partial advertisement, on a 401 with
   *  no usable metadata, and (`discovery_unavailable`) when the answer could not
   *  be obtained. Results are cached per endpoint for 5 min so a per-call auth
   *  check is cheap; failures only for a few seconds. */
  async discover(serverEndpoint: string): Promise<DiscoveredAuth | null> {
    // Only http(s) endpoints have discoverable OAuth. A stdio command
    // ("npx …") or any non-URL endpoint is not OAuth-protected — don't throw
    // on `new URL(...)` downstream (epic #459).
    if (!/^https?:\/\//i.test(serverEndpoint)) return null;
    // Cache by the FULL endpoint, not just origin: RFC 9728 metadata can be
    // path-specific (e.g. M365 exposes one resource-metadata doc per server).
    const cached = this.cache.get(serverEndpoint);
    if (cached && Date.now() - cached.at < cached.ttlMs) {
      if ('failure' in cached) throw cached.failure;
      return cached.value;
    }
    return await this.discoverUncached(serverEndpoint)
      .then((value) => {
        this.cache.set(serverEndpoint, { at: Date.now(), ttlMs: DISCOVERY_CACHE_TTL_MS, value });
        return value;
      })
      .catch((err: unknown) => {
        if (err instanceof McpAuthDiscoveryError) {
          this.cache.set(serverEndpoint, {
            at: Date.now(),
            ttlMs: DISCOVERY_FAILURE_CACHE_TTL_MS,
            failure: err,
          });
        }
        throw err;
      });
  }

  private async discoverUncached(serverEndpoint: string): Promise<DiscoveredAuth | null> {
    const origin = serverOrigin(serverEndpoint);
    // (1) Well-known at the origin root, then (2) the RFC 9728 pointer the server
    // returns in its 401 `WWW-Authenticate: Bearer resource_metadata="…"` header
    // (M365 serves a path-specific metadata doc there, not at the root).
    const resource = await this.resolveProtectedResource(origin, serverEndpoint);
    if (!resource) return null;
    const issuer = resource.authorizationServers[0];
    if (!issuer) {
      throw new McpAuthDiscoveryError(
        'no_authorization_server',
        `protected-resource metadata at ${origin} lists no authorization server`,
      );
    }
    const server = await this.fetchAuthServer(issuer);
    return { resource, server };
  }

  private async resolveProtectedResource(
    origin: string,
    serverEndpoint: string,
  ): Promise<ProtectedResourceMetadata | null> {
    const wellKnown = await this.getJson(`${origin}/.well-known/oauth-protected-resource`);
    const atRoot =
      wellKnown.kind === 'doc' ? this.parseProtectedResource(wellKnown.doc, origin) : null;
    if (atRoot) return atRoot;
    // Probed even when the well-known read failed: the challenge can still point
    // at a readable path-specific document.
    const probe = await this.probeChallenge(serverEndpoint);
    if (probe.kind === 'resource') return probe.resource;
    const unavailable =
      wellKnown.kind === 'unavailable' ? wellKnown : probe.kind === 'unavailable' ? probe : null;
    if (unavailable) {
      throw new McpAuthDiscoveryError(
        DISCOVERY_UNAVAILABLE,
        `auth metadata for ${origin} is unavailable right now: ${unavailable.reason}`,
      );
    }
    if (probe.kind === 'challenge') {
      throw new McpAuthDiscoveryError(
        UNADVERTISED_AUTH_CHALLENGE,
        `${origin} answered 401 but advertises no usable protected-resource metadata`,
      );
    }
    return null;
  }

  /** RFC 9728: read the `resource_metadata` URL the server advertises in the
   *  `WWW-Authenticate: Bearer resource_metadata="…"` header of its 401, then
   *  fetch the protected-resource doc from there. Handles servers (e.g. M365)
   *  that expose a path-specific metadata doc rather than the origin root. */
  private async probeChallenge(serverEndpoint: string): Promise<ChallengeProbe> {
    try {
      await assertPublicHttpsUrl(serverEndpoint);
    } catch {
      return { kind: 'none' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let metadataUrl: string | null = null;
    let status: number;
    try {
      const res = await this.fetchImpl(serverEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'omadia', version: '1' },
          },
        }),
        signal: controller.signal,
        redirect: 'manual',
      });
      status = res.status;
      const wa = res.headers.get('www-authenticate');
      if (wa) {
        const m = /resource_metadata="?([^",\s]+)"?/i.exec(wa);
        if (m?.[1]) metadataUrl = m[1];
      }
    } catch (err) {
      return { kind: 'unavailable', reason: `initialize probe failed: ${String(err)}` };
    } finally {
      clearTimeout(timer);
    }
    if (metadataUrl) {
      const fetched = await this.getJson(metadataUrl);
      if (fetched.kind === 'unavailable') return fetched;
      const resource =
        fetched.kind === 'doc' ? this.parseProtectedResource(fetched.doc, serverEndpoint) : null;
      if (resource) return { kind: 'resource', resource };
    }
    if (status === 401) return { kind: 'challenge' };
    if (isRetryableStatus(status)) {
      return { kind: 'unavailable', reason: `initialize probe answered HTTP ${String(status)}` };
    }
    return { kind: 'none' };
  }

  private parseProtectedResource(
    doc: Record<string, unknown>,
    fallbackResource: string,
  ): ProtectedResourceMetadata | null {
    const authServers = strArr(doc['authorization_servers']);
    if (authServers.length === 0) return null;
    return {
      resource: str(doc['resource']) ?? fallbackResource,
      authorizationServers: authServers,
      scopesSupported: strArr(doc['scopes_supported']),
      bearerMethods: strArr(doc['bearer_methods_supported']),
    };
  }

  private async fetchAuthServer(issuer: string): Promise<AuthServerMetadata> {
    const fetched = await this.fetchAuthServerDoc(issuer);
    if (fetched.kind === 'unavailable') {
      throw new McpAuthDiscoveryError(
        DISCOVERY_UNAVAILABLE,
        `authorization-server metadata for issuer ${issuer} is unavailable right now: ${fetched.reason}`,
      );
    }
    if (fetched.kind === 'absent') {
      throw new McpAuthDiscoveryError(
        'no_auth_server_metadata',
        `no authorization-server metadata for issuer ${issuer}`,
      );
    }
    const { doc } = fetched;
    const authorizationEndpoint = str(doc['authorization_endpoint']);
    const tokenEndpoint = str(doc['token_endpoint']);
    if (!authorizationEndpoint || !tokenEndpoint) {
      throw new McpAuthDiscoveryError(
        'incomplete_auth_server_metadata',
        `issuer ${issuer} metadata is missing authorization or token endpoint`,
      );
    }
    // RFC 8414 §3.3 — the document MUST claim the issuer it was fetched under.
    //
    // Without this check the metadata is self-certifying, and the claimed value
    // is not inert: `McpOAuthService.ensureClient` calls `loadClient(issuer)`
    // with it, and `tokenRequest` then POSTs that client's `client_secret` to
    // the `token_endpoint` from THIS SAME untrusted document. So a hostile MCP
    // server advertises its own authorization server; that AS answers with
    // `issuer: https://login.company.example` — an issuer this install already
    // holds a pre-registered enterprise client secret for — plus its own
    // `token_endpoint`. omadia loads the enterprise secret and hands it to the
    // attacker. Binding the claim to the URL we actually fetched closes it.
    //
    // ABSENT is tolerated: some deployed ASes omit the field, and a claim that
    // was never made is not a claim an attacker can forge — the fallback below
    // keeps the issuer we asked for. A claim that is PRESENT and different is
    // refused outright; there is no legitimate reason for it.
    const claimedIssuer = str(doc['issuer']);
    if (claimedIssuer !== null && !sameIssuer(claimedIssuer, issuer)) {
      throw new McpAuthDiscoveryError(
        'issuer_mismatch',
        `authorization-server metadata fetched for ${issuer} claims a different issuer (${claimedIssuer}) — refusing it, because the claimed issuer selects which stored client secret is sent to this document's token endpoint`,
      );
    }
    // A registration_endpoint that merely points at the authorize URL is not a
    // real RFC 7591 DCR endpoint — treat it as absent so we don't POST junk.
    const registration = str(doc['registration_endpoint']);
    const registrationEndpoint =
      registration && registration !== authorizationEndpoint ? registration : null;
    return {
      // The issuer we FETCHED, not the string the document echoed back. The
      // guard above has already proven they are the same identifier, so the
      // only thing the claimed spelling can still differ in is trailing
      // slashes — and that spelling is what keys `loadClient()` and the stored
      // token rows. Taking the canonical one means a document answering
      // `https://as.example/` cannot miss a client stored under
      // `https://as.example`, and removes the question of how many trailing
      // slashes `sameIssuer` should tolerate from everything downstream.
      issuer,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
      codeChallengeMethods: strArr(doc['code_challenge_methods_supported']),
      grantTypes: strArr(doc['grant_types_supported']),
      scopesSupported: strArr(doc['scopes_supported']),
      issParameterSupported: doc['authorization_response_iss_parameter_supported'] === true,
      // Strict `=== true`: an AS that omits the flag, or sends a truthy-ish
      // string, has NOT promised to dereference a metadata document. Guessing
      // here would send a client_id the AS cannot resolve and fail the whole
      // authorize round-trip instead of falling through to manual.
      clientIdMetadataDocumentSupported: doc['client_id_metadata_document_supported'] === true,
    };
  }

  /**
   * Fetch an issuer's authorization-server metadata, trying every well-known
   * form. For an issuer WITH a path component (e.g.
   * `https://auth.smithery.ai/smithery/notion`) RFC 8414 §3.1 INSERTS the
   * well-known segment between host and path
   * (`…/.well-known/oauth-authorization-server/smithery/notion`), whereas OIDC
   * Discovery APPENDS it. Path-less issuers make the two forms identical. We try
   * the RFC 8414 insertion form first (it's what path-scoped brokers like
   * Smithery actually serve), then the appended fallbacks.
   */
  private async fetchAuthServerDoc(issuer: string): Promise<MetadataFetch> {
    const base = issuer.replace(/\/+$/, '');
    const candidates: string[] = [];
    try {
      const u = new URL(base);
      const path = u.pathname.replace(/\/+$/, ''); // '' or '/smithery/notion'
      if (path) {
        // RFC 8414 §3.1 — well-known segment inserted before the issuer path.
        candidates.push(`${u.origin}/.well-known/oauth-authorization-server${path}`);
        candidates.push(`${u.origin}/.well-known/openid-configuration${path}`);
      }
    } catch {
      /* malformed issuer — fall back to the appended forms below */
    }
    // OIDC-style path-appended forms (also correct for path-less issuers).
    candidates.push(`${base}/.well-known/oauth-authorization-server`);
    candidates.push(`${base}/.well-known/openid-configuration`);
    const seen = new Set<string>();
    // A candidate that could not be read leaves the outcome open: only when
    // every form answered "not here" is the issuer's metadata really absent.
    let unavailable: MetadataFetch | null = null;
    for (const url of candidates) {
      if (seen.has(url)) continue;
      seen.add(url);
      const fetched = await this.getJson(url);
      if (fetched.kind === 'doc') return fetched;
      if (fetched.kind === 'unavailable') unavailable ??= fetched;
    }
    return unavailable ?? { kind: 'absent' };
  }

  private async getJson(url: string): Promise<MetadataFetch> {
    // SSRF guard (codex W9 fold): the well-known chain + endpoints are
    // attacker-influenced; refuse internal hosts and do not follow redirects.
    try {
      await assertPublicHttpsUrl(url);
    } catch {
      return { kind: 'absent' };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let text: string | null;
    try {
      // `manual`, not `error`: nothing is followed either way, but a 3xx stays
      // visible as the answer it is. `error` would reject exactly like a network
      // failure, and a host that redirects everything would then read as down.
      const res = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
        redirect: 'manual',
      });
      if (isRetryableStatus(res.status)) {
        return { kind: 'unavailable', reason: `${url} answered HTTP ${String(res.status)}` };
      }
      if (!res.ok) return { kind: 'absent' };
      // Metered while reading, not measured after: `res.text()` would have the
      // whole body resident before the cap could reject it.
      text = await readTextCapped(res, MAX_METADATA_BYTES);
    } catch (err) {
      return { kind: 'unavailable', reason: `${url} failed: ${String(err)}` };
    } finally {
      clearTimeout(timer);
    }
    if (text === null) return { kind: 'absent' };
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object'
        ? { kind: 'doc', doc: parsed as Record<string, unknown> }
        : { kind: 'absent' };
    } catch {
      return { kind: 'absent' };
    }
  }
}
