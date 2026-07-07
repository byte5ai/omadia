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
 * OAuth-protected; anything else is "no discoverable auth" and the caller
 * falls back to the raw error.
 */

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
}

export interface DiscoveredAuth {
  readonly resource: ProtectedResourceMetadata;
  readonly server: AuthServerMetadata;
}

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

/** The origin an MCP server's well-known documents live under (scheme+host). */
export function serverOrigin(endpoint: string): string {
  return new URL(endpoint).origin;
}

export interface McpAuthDiscoveryDeps {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DISCOVERY_CACHE_TTL_MS = 5 * 60 * 1000;

export class McpAuthDiscovery {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, { at: number; value: DiscoveredAuth | null }>();

  constructor(deps?: McpAuthDiscoveryDeps) {
    this.fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = deps?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Full discovery from a server endpoint URL. Returns null when the server
   *  advertises no OAuth-protected-resource document (i.e. not discoverably
   *  auth-protected). Throws only on a malformed/partial advertisement.
   *  Cached per origin (5 min) so a per-call auth check is cheap. */
  async discover(serverEndpoint: string): Promise<DiscoveredAuth | null> {
    // Cache by the FULL endpoint, not just origin: RFC 9728 metadata can be
    // path-specific (e.g. M365 exposes one resource-metadata doc per server).
    const cached = this.cache.get(serverEndpoint);
    if (cached && Date.now() - cached.at < DISCOVERY_CACHE_TTL_MS) return cached.value;
    const value = await this.discoverUncached(serverEndpoint);
    this.cache.set(serverEndpoint, { at: Date.now(), value });
    return value;
  }

  private async discoverUncached(serverEndpoint: string): Promise<DiscoveredAuth | null> {
    const origin = serverOrigin(serverEndpoint);
    // (1) Well-known at the origin root, then (2) the RFC 9728 pointer the server
    // returns in its 401 `WWW-Authenticate: Bearer resource_metadata="…"` header
    // (M365 serves a path-specific metadata doc there, not at the root).
    const resource =
      (await this.fetchProtectedResource(origin)) ??
      (await this.fetchProtectedResourceViaChallenge(serverEndpoint));
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

  private async fetchProtectedResource(
    origin: string,
  ): Promise<ProtectedResourceMetadata | null> {
    const doc = await this.getJson(`${origin}/.well-known/oauth-protected-resource`);
    return this.parseProtectedResource(doc, origin);
  }

  /** RFC 9728: read the `resource_metadata` URL the server advertises in the
   *  `WWW-Authenticate: Bearer resource_metadata="…"` header of its 401, then
   *  fetch the protected-resource doc from there. Handles servers (e.g. M365)
   *  that expose a path-specific metadata doc rather than the origin root. */
  private async fetchProtectedResourceViaChallenge(
    serverEndpoint: string,
  ): Promise<ProtectedResourceMetadata | null> {
    try {
      await assertPublicHttpsUrl(serverEndpoint);
    } catch {
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let metadataUrl: string | null = null;
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
        redirect: 'error',
      });
      const wa = res.headers.get('www-authenticate');
      if (wa) {
        const m = /resource_metadata="?([^",\s]+)"?/i.exec(wa);
        if (m?.[1]) metadataUrl = m[1];
      }
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
    if (!metadataUrl) return null;
    const doc = await this.getJson(metadataUrl);
    return this.parseProtectedResource(doc, serverEndpoint);
  }

  private parseProtectedResource(
    doc: Record<string, unknown> | null,
    fallbackResource: string,
  ): ProtectedResourceMetadata | null {
    if (!doc) return null;
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
    const base = issuer.replace(/\/+$/, '');
    const doc =
      (await this.getJson(`${base}/.well-known/oauth-authorization-server`)) ??
      (await this.getJson(`${base}/.well-known/openid-configuration`));
    if (!doc) {
      throw new McpAuthDiscoveryError(
        'no_auth_server_metadata',
        `no authorization-server metadata for issuer ${issuer}`,
      );
    }
    const authorizationEndpoint = str(doc['authorization_endpoint']);
    const tokenEndpoint = str(doc['token_endpoint']);
    if (!authorizationEndpoint || !tokenEndpoint) {
      throw new McpAuthDiscoveryError(
        'incomplete_auth_server_metadata',
        `issuer ${issuer} metadata is missing authorization or token endpoint`,
      );
    }
    // A registration_endpoint that merely points at the authorize URL is not a
    // real RFC 7591 DCR endpoint — treat it as absent so we don't POST junk.
    const registration = str(doc['registration_endpoint']);
    const registrationEndpoint =
      registration && registration !== authorizationEndpoint ? registration : null;
    return {
      issuer: str(doc['issuer']) ?? issuer,
      authorizationEndpoint,
      tokenEndpoint,
      registrationEndpoint,
      codeChallengeMethods: strArr(doc['code_challenge_methods_supported']),
      grantTypes: strArr(doc['grant_types_supported']),
      scopesSupported: strArr(doc['scopes_supported']),
    };
  }

  private async getJson(url: string): Promise<Record<string, unknown> | null> {
    // SSRF guard (codex W9 fold): the well-known chain + endpoints are
    // attacker-influenced; refuse internal hosts and disable redirects.
    try {
      await assertPublicHttpsUrl(url);
    } catch {
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
        redirect: 'error',
      });
      if (res.status === 404) return null;
      if (!res.ok) return null;
      const text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_METADATA_BYTES) return null;
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
