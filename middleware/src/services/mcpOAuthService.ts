/**
 * Ties MCP OAuth together (epic #459 W9): discovery + generic OAuth client +
 * the graph store + the vault. Provider-agnostic — no server is special-cased.
 *
 *  - getValidAccessToken(server, userKey) → a live bearer token (refreshing a
 *    near-expired one), or null when the user has not authorized yet.
 *  - beginAuthorization(server, userKey) → discover, ensure an OAuth client
 *    (DCR self-registration, else an operator-provided one), build the PKCE
 *    authorize URL, persist the pending flow, return { authorizeUrl }.
 *  - completeAuthorization(state, code) → consume the flow, exchange the code,
 *    store the token in the vault. Called by the OAuth callback route.
 */
import { McpAuthDiscovery, serverOrigin, type DiscoveredAuth } from './mcpAuthDiscovery.js';
import { McpOAuthClient, type OAuthClientCredentials } from './mcpOAuthClient.js';
import { substituteMcpConfig } from '../agents/subAgentToolHydration.js';

import type { AgentGraphStore, McpServerRow } from '@omadia/orchestrator';

/** Minimal vault surface (matches SecretVault). */
interface Vault {
  get(namespace: string, key: string): Promise<string | undefined>;
  set(namespace: string, key: string, value: string): Promise<void>;
}

const VAULT_NS = '@omadia/mcp-oauth';
/** Refresh a token this many seconds before it actually expires. */
const REFRESH_MARGIN_SEC = 120;

export interface McpOAuthServiceDeps {
  readonly graph: AgentGraphStore;
  readonly vault: Vault;
  /** Absolute callback URL base, e.g. https://host — the callback path is
   *  appended. Must match what the operator registers as the redirect URI. */
  readonly redirectUri: string;
  readonly discovery?: McpAuthDiscovery;
  readonly client?: McpOAuthClient;
  readonly log?: (msg: string) => void;
}

export interface BeginAuthResult {
  readonly authorizeUrl: string;
}

export class McpOAuthNeedsClientError extends Error {
  constructor(readonly issuer: string) {
    super(
      `issuer "${issuer}" does not support dynamic client registration; an operator must register an OAuth client for it once`,
    );
    this.name = 'McpOAuthNeedsClientError';
  }
}

const DCR_PROBE_TTL_MS = 10 * 60 * 1000;

export class McpOAuthService {
  private readonly discovery: McpAuthDiscovery;
  private readonly client: McpOAuthClient;
  /** Per-issuer cache of whether Dynamic Client Registration actually works.
   *  A server can ADVERTISE a registration_endpoint yet gate it (e.g. Figma
   *  hard-403s third-party DCR), so "brokered" must reflect a real probe, not
   *  the advertised flag. Cached to avoid re-probing on every status check. */
  private readonly dcrProbeCache = new Map<string, { at: number; ok: boolean }>();

  /** The redirect URI the operator must register with the OAuth provider. */
  readonly redirectUri: string;

  constructor(private readonly deps: McpOAuthServiceDeps) {
    this.discovery = deps.discovery ?? new McpAuthDiscovery();
    this.client = deps.client ?? new McpOAuthClient();
    this.redirectUri = deps.redirectUri;
  }

  private tokenRef(serverId: string, userKey: string, kind: 'access' | 'refresh'): string {
    return `token/${serverId}/${userKey}/${kind}`;
  }

  private clientSecretRef(issuer: string): string {
    return `client/${encodeURIComponent(issuer)}/secret`;
  }

  /** The connect-ready endpoint with non-secret `{key}` config placeholders
   *  substituted (epic #459) — OAuth discovery must hit the SAME URL a tool call
   *  connects to, not the raw `.../tenants/{tenant_id}/...` template. */
  private resolveEndpoint(server: McpServerRow): string {
    return substituteMcpConfig(server.endpoint ?? '', server.config);
  }

  /** Whether a server is discoverably OAuth-protected (cheap, cached upstream). */
  async isProtected(server: McpServerRow): Promise<boolean> {
    if (!server.endpoint || server.transport === 'stdio') return false;
    try {
      return (await this.discovery.discover(this.resolveEndpoint(server))) !== null;
    } catch {
      return true; // partial advertisement still means "needs auth"
    }
  }

  /** A live access token for (server, user), refreshing if near expiry, or null
   *  when the user has not authorized. */
  async getValidAccessToken(server: McpServerRow, userKey: string): Promise<string | null> {
    const row = await this.deps.graph.getMcpOAuthToken(server.id, userKey);
    if (!row) return null;
    const stillValid =
      !row.expiresAt || row.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_SEC * 1000;
    if (stillValid) {
      return (await this.deps.vault.get(VAULT_NS, row.accessTokenRef)) ?? null;
    }
    // Expired/near-expiry: refresh if we have a refresh token.
    if (!row.refreshTokenRef || !server.endpoint) {
      return (await this.deps.vault.get(VAULT_NS, row.accessTokenRef)) ?? null;
    }
    const refreshToken = await this.deps.vault.get(VAULT_NS, row.refreshTokenRef);
    if (!refreshToken) return (await this.deps.vault.get(VAULT_NS, row.accessTokenRef)) ?? null;
    try {
      const discovered = await this.discovery.discover(this.resolveEndpoint(server));
      if (!discovered) return null;
      const client = await this.loadClient(discovered.server.issuer);
      if (!client) return null;
      const tok = await this.client.refresh({ server: discovered.server, client, refreshToken });
      await this.persistToken(server.id, userKey, tok);
      return tok.accessToken;
    } catch (err) {
      this.deps.log?.(`[mcpOAuth] refresh failed for ${server.name}: ${String(err)}`);
      return (await this.deps.vault.get(VAULT_NS, row.accessTokenRef)) ?? null;
    }
  }

  /** Start the authorization flow: returns the URL to send the user to. */
  async beginAuthorization(server: McpServerRow, userKey: string): Promise<BeginAuthResult> {
    if (!server.endpoint) throw new Error('server has no endpoint');
    if (server.transport === 'stdio') throw new Error('stdio servers do not use OAuth');
    const discovered = await this.discovery.discover(this.resolveEndpoint(server));
    if (!discovered) throw new Error('server does not advertise OAuth protected-resource metadata');
    const client = await this.ensureClient(discovered);
    const scopes =
      discovered.resource.scopesSupported.length > 0
        ? discovered.resource.scopesSupported
        : discovered.server.scopesSupported;
    const { url, state, codeVerifier } = this.client.buildAuthorizeUrl({
      server: discovered.server,
      client,
      redirectUri: this.deps.redirectUri,
      scopes,
      resource: discovered.resource.resource,
    });
    await this.deps.graph.createMcpOAuthFlow({
      state,
      serverId: server.id,
      userKey,
      issuer: discovered.server.issuer,
      codeVerifier,
      redirectUri: this.deps.redirectUri,
      scopes: scopes.length > 0 ? scopes.join(' ') : null,
      // Persist the authorize-time endpoints (codex W9 critical fold): the
      // callback exchanges against THESE, never a re-discovered token endpoint
      // that a malicious server could have switched in the meantime.
      tokenEndpoint: discovered.server.tokenEndpoint,
      authorizationEndpoint: discovered.server.authorizationEndpoint,
    });
    return { authorizeUrl: url };
  }

  /** Finish the flow at the callback: exchange the code and store the token.
   *  Uses the endpoints captured when the flow started — NOT a fresh discovery
   *  (codex W9 critical fold: a malicious server could otherwise switch its
   *  token endpoint to steal the code + PKCE verifier + client secret). */
  async completeAuthorization(state: string, code: string): Promise<{ serverId: string }> {
    const flow = await this.deps.graph.takeMcpOAuthFlow(state);
    if (!flow) throw new Error('unknown or expired authorization state');
    if (!flow.tokenEndpoint) throw new Error('flow is missing its bound token endpoint');
    const client = await this.loadClient(flow.issuer);
    if (!client) throw new McpOAuthNeedsClientError(flow.issuer);
    // Reconstruct the minimal server metadata from the FLOW-BOUND values.
    const boundServer = {
      issuer: flow.issuer,
      authorizationEndpoint: flow.authorizationEndpoint ?? '',
      tokenEndpoint: flow.tokenEndpoint,
      registrationEndpoint: null,
      codeChallengeMethods: [] as string[],
      grantTypes: [] as string[],
      scopesSupported: [] as string[],
    };
    const tok = await this.client.exchangeCode({
      server: boundServer,
      client,
      code,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
    });
    await this.persistToken(flow.serverId, flow.userKey, tok);
    return { serverId: flow.serverId };
  }

  /** Load a stored OAuth client for an issuer, resolving its secret. */
  private async loadClient(issuer: string): Promise<OAuthClientCredentials | null> {
    const row = await this.deps.graph.getMcpOAuthClient(issuer);
    if (!row) return null;
    const secret = row.clientSecretRef
      ? ((await this.deps.vault.get(VAULT_NS, row.clientSecretRef)) ?? null)
      : null;
    return { clientId: row.clientId, clientSecret: secret };
  }

  /** Return an OAuth client for the issuer: an existing one, a fresh DCR
   *  registration, or throw McpOAuthNeedsClientError when neither is possible. */
  private async ensureClient(discovered: DiscoveredAuth): Promise<OAuthClientCredentials> {
    const issuer = discovered.server.issuer;
    const existing = await this.loadClient(issuer);
    if (existing) return existing;
    // Try dynamic client registration (RFC 7591) — zero-config path.
    const registered = await this.client.registerClient(
      discovered.server,
      this.deps.redirectUri,
      'omadia MCP',
    );
    if (registered) {
      const secretRef = registered.clientSecret ? this.clientSecretRef(issuer) : null;
      if (secretRef && registered.clientSecret) {
        await this.deps.vault.set(VAULT_NS, secretRef, registered.clientSecret);
      }
      await this.deps.graph.upsertMcpOAuthClient({
        issuer,
        clientId: registered.clientId,
        clientSecretRef: secretRef,
        registeredVia: 'dcr',
      });
      return registered;
    }
    throw new McpOAuthNeedsClientError(issuer);
  }

  /** Operator-provided client for an issuer that lacks DCR (one-time). */
  async setManualClient(issuer: string, clientId: string, clientSecret: string | null): Promise<void> {
    let secretRef: string | null = null;
    if (clientSecret) {
      secretRef = this.clientSecretRef(issuer);
      await this.deps.vault.set(VAULT_NS, secretRef, clientSecret);
    }
    await this.deps.graph.upsertMcpOAuthClient({
      issuer,
      clientId,
      clientSecretRef: secretRef,
      registeredVia: 'manual',
    });
  }

  /** Resolve the issuer for a server (for the manual-client UI to know which
   *  issuer to register against). Null when not discoverable. */
  async issuerFor(server: McpServerRow): Promise<string | null> {
    if (!server.endpoint) return null;
    try {
      const d = await this.discovery.discover(this.resolveEndpoint(server));
      return d?.server.issuer ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Classify a server's auth so the UI can explain the tradeoff:
   *  - protected=false      → no authorization needed.
   *  - brokered=true        → the server offers Dynamic Client Registration,
   *    so connecting is zero-setup (it holds its own downstream app).
   *  - brokered=false       → the server delegates raw to its issuer with no
   *    DCR, so a one-time operator OAuth app is required (a weaker server).
   * `issuerHost` is the human-readable host the OAuth actually goes to.
   */
  async describeAuth(
    server: McpServerRow,
  ): Promise<{ protected: boolean; issuer: string | null; issuerHost: string | null; brokered: boolean }> {
    if (!server.endpoint) return { protected: false, issuer: null, issuerHost: null, brokered: false };
    // stdio servers are local commands, not OAuth-protected HTTP endpoints —
    // never run OAuth discovery/connect for them (epic #459).
    if (server.transport === 'stdio') {
      return { protected: false, issuer: null, issuerHost: null, brokered: false };
    }
    let discovered;
    try {
      discovered = await this.discovery.discover(this.resolveEndpoint(server));
    } catch {
      return { protected: true, issuer: null, issuerHost: null, brokered: false };
    }
    if (!discovered) return { protected: false, issuer: null, issuerHost: null, brokered: false };
    const issuer = discovered.server.issuer;
    let issuerHost: string | null = null;
    try {
      issuerHost = new URL(discovered.server.tokenEndpoint).host;
    } catch {
      /* keep null */
    }
    return {
      protected: true,
      issuer,
      issuerHost,
      // "brokered" = DCR REALLY works, not just that it's advertised. Probe it
      // (result cached) so the UI never promises zero-setup for a server whose
      // registration is gated.
      brokered:
        discovered.server.registrationEndpoint !== null &&
        (await this.canBrokerClient(discovered)),
    };
  }

  /** True when we can obtain an OAuth client for this issuer WITHOUT operator
   *  setup — either one is already stored, or Dynamic Client Registration
   *  actually succeeds. A success also persists the client, so a later Connect
   *  is instant. Failure (e.g. a gated DCR endpoint) is cached as not-brokered. */
  private async canBrokerClient(discovered: DiscoveredAuth): Promise<boolean> {
    const issuer = discovered.server.issuer;
    try {
      if (await this.loadClient(issuer)) return true;
    } catch {
      /* fall through to a probe */
    }
    const cached = this.dcrProbeCache.get(issuer);
    if (cached && Date.now() - cached.at < DCR_PROBE_TTL_MS) return cached.ok;
    try {
      await this.ensureClient(discovered); // registers + persists on success
      this.dcrProbeCache.set(issuer, { at: Date.now(), ok: true });
      return true;
    } catch {
      this.dcrProbeCache.set(issuer, { at: Date.now(), ok: false });
      return false;
    }
  }

  private async persistToken(
    serverId: string,
    userKey: string,
    tok: { accessToken: string; refreshToken: string | null; expiresInSec: number | null; scope: string | null },
  ): Promise<void> {
    const accessRef = this.tokenRef(serverId, userKey, 'access');
    await this.deps.vault.set(VAULT_NS, accessRef, tok.accessToken);
    let refreshRef: string | null = null;
    if (tok.refreshToken) {
      refreshRef = this.tokenRef(serverId, userKey, 'refresh');
      await this.deps.vault.set(VAULT_NS, refreshRef, tok.refreshToken);
    }
    await this.deps.graph.upsertMcpOAuthToken({
      serverId,
      userKey,
      accessTokenRef: accessRef,
      refreshTokenRef: refreshRef,
      expiresAt: tok.expiresInSec ? new Date(Date.now() + tok.expiresInSec * 1000) : null,
      scopes: tok.scope,
    });
  }

  /** Origin the server's well-known lives under (for logging/UI). */
  static origin(endpoint: string): string {
    return serverOrigin(endpoint);
  }
}
