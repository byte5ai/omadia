/**
 * Generic OAuth 2.1 client for MCP authorization (epic #459 W9). Provider-
 * agnostic: everything is driven by the discovered authorization-server
 * metadata (see mcpAuthDiscovery.ts). Supports PKCE (S256 preferred, plain
 * fallback where a server only advertises plain, e.g. Strava), RFC 7591
 * dynamic client registration, the authorization-code exchange, and refresh.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { AuthServerMetadata } from './mcpAuthDiscovery.js';

export interface OAuthClientCredentials {
  readonly clientId: string;
  readonly clientSecret: string | null;
}

export interface AuthorizeUrlResult {
  readonly url: string;
  readonly state: string;
  readonly codeVerifier: string;
}

export interface TokenResult {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSec: number | null;
  readonly scope: string | null;
}

export class McpOAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'McpOAuthError';
  }
}

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Pick the strongest PKCE method the server supports; default to S256 when it
 *  advertises none (S256 is the OAuth 2.1 default). */
function pkceMethod(server: AuthServerMetadata): 'S256' | 'plain' {
  const m = server.codeChallengeMethods;
  if (m.length === 0 || m.includes('S256')) return 'S256';
  return 'plain';
}

export interface McpOAuthClientDeps {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class McpOAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(deps?: McpOAuthClientDeps) {
    this.fetchImpl = deps?.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = deps?.timeoutMs ?? 15_000;
  }

  /** RFC 7591 dynamic client registration. Returns null when the server has no
   *  usable registration endpoint (the caller then needs a manual client). */
  async registerClient(
    server: AuthServerMetadata,
    redirectUri: string,
    clientName: string,
  ): Promise<OAuthClientCredentials | null> {
    if (!server.registrationEndpoint) return null;
    const body = {
      client_name: clientName,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
    };
    const doc = await this.postJson(server.registrationEndpoint, body, {});
    const clientId = typeof doc['client_id'] === 'string' ? doc['client_id'] : null;
    if (!clientId) return null;
    return {
      clientId,
      clientSecret: typeof doc['client_secret'] === 'string' ? doc['client_secret'] : null,
    };
  }

  /** Build the authorization-code URL with PKCE. The returned state +
   *  codeVerifier are persisted by the caller and matched at the callback. */
  buildAuthorizeUrl(input: {
    readonly server: AuthServerMetadata;
    readonly client: OAuthClientCredentials;
    readonly redirectUri: string;
    readonly scopes: readonly string[];
    readonly resource?: string;
  }): AuthorizeUrlResult {
    const state = base64url(randomBytes(24));
    const codeVerifier = base64url(randomBytes(48));
    const method = pkceMethod(input.server);
    const challenge =
      method === 'S256' ? base64url(createHash('sha256').update(codeVerifier).digest()) : codeVerifier;
    const u = new URL(input.server.authorizationEndpoint);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', input.client.clientId);
    u.searchParams.set('redirect_uri', input.redirectUri);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', method);
    if (input.scopes.length > 0) u.searchParams.set('scope', input.scopes.join(' '));
    // RFC 8707 resource indicator — ties the token to this MCP resource.
    if (input.resource) u.searchParams.set('resource', input.resource);
    return { url: u.toString(), state, codeVerifier };
  }

  /** Exchange an authorization code for tokens. */
  async exchangeCode(input: {
    readonly server: AuthServerMetadata;
    readonly client: OAuthClientCredentials;
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): Promise<TokenResult> {
    return this.tokenRequest(input.server, input.client, {
      grant_type: 'authorization_code',
      code: input.code,
      code_verifier: input.codeVerifier,
      redirect_uri: input.redirectUri,
    });
  }

  /** Refresh an access token. */
  async refresh(input: {
    readonly server: AuthServerMetadata;
    readonly client: OAuthClientCredentials;
    readonly refreshToken: string;
  }): Promise<TokenResult> {
    return this.tokenRequest(input.server, input.client, {
      grant_type: 'refresh_token',
      refresh_token: input.refreshToken,
    });
  }

  private async tokenRequest(
    server: AuthServerMetadata,
    client: OAuthClientCredentials,
    params: Record<string, string>,
  ): Promise<TokenResult> {
    const form = new URLSearchParams(params);
    form.set('client_id', client.clientId);
    if (client.clientSecret) form.set('client_secret', client.clientSecret);
    const doc = await this.postForm(server.tokenEndpoint, form);
    const accessToken = typeof doc['access_token'] === 'string' ? doc['access_token'] : null;
    if (!accessToken) {
      throw new McpOAuthError(
        'no_access_token',
        `token endpoint returned no access_token${
          typeof doc['error'] === 'string' ? ` (${doc['error']})` : ''
        }`,
      );
    }
    const expiresIn = typeof doc['expires_in'] === 'number' ? doc['expires_in'] : null;
    return {
      accessToken,
      refreshToken: typeof doc['refresh_token'] === 'string' ? doc['refresh_token'] : null,
      expiresInSec: expiresIn,
      scope: typeof doc['scope'] === 'string' ? doc['scope'] : null,
    };
  }

  private async postForm(url: string, form: URLSearchParams): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
        signal: controller.signal,
      });
      const text = await res.text();
      let doc: Record<string, unknown> = {};
      try {
        doc = JSON.parse(text) as Record<string, unknown>;
      } catch {
        /* non-JSON body */
      }
      if (!res.ok && !doc['access_token']) {
        throw new McpOAuthError('token_request_failed', `${url} → ${String(res.status)}: ${text.slice(0, 200)}`);
      }
      return doc;
    } finally {
      clearTimeout(timer);
    }
  }

  private async postJson(
    url: string,
    body: unknown,
    headers: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      try {
        return JSON.parse(text) as Record<string, unknown>;
      } catch {
        return {};
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
