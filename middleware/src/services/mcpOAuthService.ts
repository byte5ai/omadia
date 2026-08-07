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
import {
  McpAuthDiscovery,
  canonicalIssuer,
  sameIssuer,
  serverOrigin,
  type DiscoveredAuth,
} from './mcpAuthDiscovery.js';
import { McpOAuthClient, type OAuthClientCredentials } from './mcpOAuthClient.js';
import {
  CIMD_CLIENT_NAME,
  CimdReachabilityCache,
  type CimdBlockedReason,
} from './mcpCimd.js';
import { redactedErrorText } from './secretRedaction.js';
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
  /** W2-4 — the stable CIMD metadata-document URL, i.e. the `client_id` a
   *  CIMD-capable authorization server dereferences. Null/undefined disables the
   *  cimd link of the acquisition chain entirely, which is the correct state for
   *  any install without inbound https reachability. */
  readonly cimdMetadataUrl?: string | null;
  /** Injected only by tests, to drive the reachability probe without a real
   *  ingress. Production uses global fetch. */
  readonly cimdFetchImpl?: typeof fetch;
  readonly log?: (msg: string) => void;
}

/** Which link of the acquisition chain produced (or would produce) the OAuth
 *  client for an issuer — surfaced to the UI via {@link McpOAuthService.describeAuth}
 *  so an operator can see WHY a server needs setup, or why it does not. */
export type McpClientAcquisitionMode = 'stored' | 'cimd' | 'dcr' | 'manual';

export interface McpAuthDescription {
  readonly protected: boolean;
  readonly issuer: string | null;
  readonly issuerHost: string | null;
  readonly brokered: boolean;
  /** The chain link this issuer resolves through. `manual` means an operator
   *  must register an app — the Entra ID / Okta steady state, not a failure. */
  readonly acquisitionMode: McpClientAcquisitionMode;
  /** True when the AS advertised `client_id_metadata_document_supported`.
   *  Independent of whether OUR side can serve the document. */
  readonly cimdSupported: boolean;
  /** Why CIMD is unavailable despite the AS advertising it — `null` when it is
   *  available or the AS never advertised it. Drives the UI diagnostic. */
  readonly cimdBlockedReason: CimdBlockedReason | null;
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

/**
 * RFC 9207 issuer validation failed at the callback (W0-1, D1).
 *
 * The authorization response either carried an `iss` naming a DIFFERENT
 * authorization server than the one this flow was started against, or omitted
 * `iss` entirely although that AS advertised support for it. Both are the
 * mix-up signature: a malicious or compromised MCP server steering the
 * callback so a code minted by one AS is redeemed at another.
 *
 * This is thrown BEFORE the code is exchanged, so nothing is ever persisted.
 */
export class McpOAuthIssuerMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly received: string | null,
  ) {
    super(
      received === null
        ? `authorization response omitted the "iss" parameter although issuer "${expected}" advertises RFC 9207 support`
        : `authorization response issuer "${received}" does not match the issuer this flow was started against ("${expected}")`,
    );
    this.name = 'McpOAuthIssuerMismatchError';
  }
}

// `sameIssuer` now lives in `mcpAuthDiscovery`, next to the RFC 8414 §3.3 check
// that binds a metadata document to the issuer it was fetched under. Imported
// rather than re-declared so the callback's RFC 9207 comparison and discovery's
// cannot drift apart.

const DCR_PROBE_TTL_MS = 10 * 60 * 1000;

export class McpOAuthService {
  private readonly discovery: McpAuthDiscovery;
  private readonly client: McpOAuthClient;
  /** Per-issuer cache of whether Dynamic Client Registration actually works.
   *  A server can ADVERTISE a registration_endpoint yet gate it (e.g. Figma
   *  hard-403s third-party DCR), so "brokered" must reflect a real probe, not
   *  the advertised flag. Cached to avoid re-probing on every status check. */
  private readonly dcrProbeCache = new Map<string, { at: number; ok: boolean }>();

  /** In-flight refreshes, keyed by (serverId, userKey) — W0-1, D3.
   *
   *  Without this, N concurrent callers whose token just expired each POST the
   *  SAME refresh token to the token endpoint. Against an AS with rotating
   *  refresh tokens (the OAuth 2.1 default) the first response invalidates the
   *  token the others are still using, so the losers get `invalid_grant` and,
   *  worse, the last writer can persist a refresh token the AS has already
   *  retired — the user silently ends up disconnected.
   *
   *  Sharing one promise makes exactly one HTTP request per (server, user)
   *  regardless of caller count. The entry is removed in a `finally` so a
   *  failed refresh never poisons later attempts. */
  private readonly refreshInFlight = new Map<string, Promise<string | null>>();

  /** The redirect URI the operator must register with the OAuth provider. */
  readonly redirectUri: string;

  /** W2-4 — reachability of our own CIMD document, cached. `url` is null when
   *  no inbound-reachable public base is configured, which permanently disables
   *  the cimd link without affecting any other mode. */
  private readonly cimd: CimdReachabilityCache;

  constructor(private readonly deps: McpOAuthServiceDeps) {
    this.discovery = deps.discovery ?? new McpAuthDiscovery();
    this.client = deps.client ?? new McpOAuthClient();
    this.redirectUri = deps.redirectUri;
    this.cimd = new CimdReachabilityCache(deps.cimdMetadataUrl ?? null, {
      ...(deps.cimdFetchImpl ? { fetchImpl: deps.cimdFetchImpl } : {}),
    });
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
   *  when the user has not authorized.
   *
   *  Concurrent callers that all need a refresh share ONE refresh (D3) — see
   *  `refreshInFlight`. */
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

    // ── single-flight (W0-1, D3) ────────────────────────────────────────────
    // Everything below runs at most once per (server, user) at a time. The
    // map is checked and populated synchronously — no `await` between the get
    // and the set — so two callers in the same tick cannot both miss.
    const key = `${server.id}${userKey}`;
    const existing = this.refreshInFlight.get(key);
    if (existing) return existing;

    const refreshRefKey = row.refreshTokenRef;
    const accessRefKey = row.accessTokenRef;
    const attempt = (async (): Promise<string | null> => {
      const refreshToken = await this.deps.vault.get(VAULT_NS, refreshRefKey);
      if (!refreshToken) return (await this.deps.vault.get(VAULT_NS, accessRefKey)) ?? null;
      try {
        const discovered = await this.discovery.discover(this.resolveEndpoint(server));
        if (!discovered) return null;
        // The issuer rotated since this token was minted (W0-1): the stored
        // token belongs to a different authorization server, so replaying it
        // here would send one AS's credential to another. Drop it and make the
        // user re-authorize against the new issuer.
        if (row.issuer !== null && !sameIssuer(row.issuer, discovered.server.issuer)) {
          this.deps.log?.(
            `[mcpOAuth] issuer rotated for ${server.name} (stored ${row.issuer} → discovered ${discovered.server.issuer}); dropping the stored token`,
          );
          await this.deps.graph.deleteMcpOAuthToken(server.id, userKey);
          return null;
        }
        const client = await this.loadClient(discovered.server.issuer);
        if (!client) return null;
        const tok = await this.client.refresh({ server: discovered.server, client, refreshToken });
        await this.persistToken(server.id, userKey, tok, discovered.server.issuer);
        return tok.accessToken;
      } catch (err) {
        // D5: an OAuth error body routinely echoes the token back — never let
        // `String(err)` reach a log line unredacted.
        this.deps.log?.(
          `[mcpOAuth] refresh failed for ${server.name}: ${redactedErrorText(err, [refreshToken])}`,
        );
        return (await this.deps.vault.get(VAULT_NS, accessRefKey)) ?? null;
      }
    })().finally(() => {
      this.refreshInFlight.delete(key);
    });

    this.refreshInFlight.set(key, attempt);
    return attempt;
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
      // RFC 9207 (W0-1, D1): remember whether THIS authorization server
      // promised to send `iss`, captured now rather than re-discovered at the
      // callback — a server that could flip the flag in between would simply
      // opt itself out of the check.
      issRequired: discovered.server.issParameterSupported,
    });
    return { authorizeUrl: url };
  }

  /** Finish the flow at the callback: exchange the code and store the token.
   *  Uses the endpoints captured when the flow started — NOT a fresh discovery
   *  (codex W9 critical fold: a malicious server could otherwise switch its
   *  token endpoint to steal the code + PKCE verifier + client secret).
   *
   *  @param iss the RFC 9207 `iss` authorization-response parameter, or null
   *  when the provider sent none. Validated against the issuer bound to the
   *  flow BEFORE the code is exchanged, so a mismatch persists nothing. */
  async completeAuthorization(
    state: string,
    code: string,
    iss?: string | null,
  ): Promise<{ serverId: string }> {
    const flow = await this.deps.graph.takeMcpOAuthFlow(state);
    if (!flow) throw new Error('unknown or expired authorization state');
    if (!flow.tokenEndpoint) throw new Error('flow is missing its bound token endpoint');
    // ── RFC 9207 issuer validation (W0-1, D1) ───────────────────────────────
    // `state` alone proves only that the response came back to a flow we
    // started; it does NOT prove WHICH authorization server issued the code.
    // A malicious MCP server can steer the browser so a code minted by one AS
    // is redeemed at another. Runs before the exchange — a rejected callback
    // must leave no token behind.
    const received = typeof iss === 'string' && iss.trim() !== '' ? iss.trim() : null;
    if (received !== null) {
      if (!sameIssuer(flow.issuer, received)) {
        throw new McpOAuthIssuerMismatchError(flow.issuer, received);
      }
    } else if (flow.issRequired) {
      // The AS advertised RFC 9207 support and then did not send `iss` —
      // either a stripped parameter or a response that never came from it.
      throw new McpOAuthIssuerMismatchError(flow.issuer, null);
    }
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
      // Irrelevant for the exchange itself; the `iss` decision was already
      // made above from the flow's persisted `issRequired`.
      issParameterSupported: flow.issRequired,
      // Also irrelevant at exchange time: whether the AS dereferences a client
      // metadata document only matters when ACQUIRING a client. The client is
      // already resolved (loadClient above), so re-asserting a capability here
      // could only mislead — pinned false rather than re-discovered, same
      // reasoning as the endpoint binding.
      clientIdMetadataDocumentSupported: false,
    };
    const tok = await this.client.exchangeCode({
      server: boundServer,
      client,
      code,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
    });
    await this.persistToken(flow.serverId, flow.userKey, tok, flow.issuer);
    return { serverId: flow.serverId };
  }

  /** Load a stored OAuth client for an issuer, resolving its secret. */
  /**
   * Client rows are keyed by the issuer STRING, but `sameIssuer` treats
   * `https://as.example` and `https://as.example/` as the same identifier. Two
   * different rules over the same value, so a client stored under one spelling
   * is invisible to a lookup using the other: rotation detection says "same
   * issuer", `loadClient` says "no client", and the install is pushed into
   * another acquisition flow — or simply cannot refresh.
   *
   * Both spellings are tried rather than normalising the key outright, because
   * normalising the READ alone would orphan every row already written with a
   * trailing slash. Exact first, so an install that has never seen the problem
   * keeps its single lookup.
   */
  private issuerKeyCandidates(issuer: string): readonly string[] {
    const canonical = canonicalIssuer(issuer);
    return [...new Set([issuer, canonical, `${canonical}/`])];
  }

  private async loadClient(issuer: string): Promise<OAuthClientCredentials | null> {
    let row: Awaited<ReturnType<typeof this.deps.graph.getMcpOAuthClient>> | null = null;
    for (const candidate of this.issuerKeyCandidates(issuer)) {
      row = await this.deps.graph.getMcpOAuthClient(candidate);
      if (row) break;
    }
    if (!row) return null;
    const secret = row.clientSecretRef
      ? ((await this.deps.vault.get(VAULT_NS, row.clientSecretRef)) ?? null)
      : null;
    return { clientId: row.clientId, clientSecret: secret };
  }

  /**
   * The client-acquisition strategy chain (W2-4):
   *
   *   stored → cimd → dcr (deprecated, warns) → manual → McpOAuthNeedsClientError
   *
   * Order is not arbitrary. `stored` first so an already-working install never
   * re-negotiates. `cimd` before `dcr` because the MCP spec deprecates DCR in
   * favour of it and CIMD costs one local document instead of a write at the
   * provider. `dcr` still runs — the deprecation is on a 12-month clock, and
   * removing it would break every broker that has not migrated. `manual` is
   * last only because it is the one link that needs a human; it is NOT a
   * fallback of last resort in the sense of being second-class. For Entra ID and
   * Okta — neither of which supports CIMD — manual is the ONLY correct path and
   * has no sunset.
   */
  private async ensureClient(discovered: DiscoveredAuth): Promise<OAuthClientCredentials> {
    const issuer = discovered.server.issuer;

    // ── stored ────────────────────────────────────────────────────────────────
    const existing = await this.loadClient(issuer);
    if (existing) return existing;

    // ── cimd ──────────────────────────────────────────────────────────────────
    const cimdClient = await this.tryCimdClient(discovered);
    if (cimdClient) return cimdClient;

    // ── dcr (deprecated, still supported) ─────────────────────────────────────
    const registered = await this.client.registerClient(
      discovered.server,
      this.deps.redirectUri,
      CIMD_CLIENT_NAME,
    );
    if (registered) {
      // Deprecation warning, not an error: the MCP spec's DCR sunset is a
      // 12-month clock, and a broker that only offers DCR must keep working
      // until it migrates.
      this.deps.log?.(
        `[mcpOAuth] issuer ${issuer} was acquired via RFC 7591 Dynamic Client Registration, which the MCP authorization spec deprecates in favour of Client ID Metadata Documents. It keeps working; nothing to do today.`,
      );
      const secretRef = registered.clientSecret ? this.clientSecretRef(issuer) : null;
      if (secretRef && registered.clientSecret) {
        await this.deps.vault.set(VAULT_NS, secretRef, registered.clientSecret);
      }
      await this.deps.graph.upsertMcpOAuthClient({
        issuer,
        clientId: registered.clientId,
        clientSecretRef: secretRef,
        registeredVia: 'dcr',
        clientMetadataUrl: null,
      });
      return registered;
    }

    // ── manual ────────────────────────────────────────────────────────────────
    // Nothing automatic applies. `setManualClient` is the operator's entry
    // point; this error is what the route turns into the client-registration
    // form, so it is a prompt, not a fault.
    throw new McpOAuthNeedsClientError(issuer);
  }

  /**
   * The `cimd` link. Returns null (never throws) whenever CIMD does not apply,
   * so the chain simply moves on:
   *
   *  - the AS never advertised `client_id_metadata_document_supported`;
   *  - no metadata URL is configured (`FLOW_PUBLIC_BASE_URL` unset);
   *  - the document is not inbound-reachable — the on-prem / firewalled reality.
   *
   * There is no HTTP call to the provider here: a CIMD `client_id` needs no
   * registration step at all. We persist the URL as the client_id and the AS
   * dereferences it at authorize time.
   */
  private async tryCimdClient(
    discovered: DiscoveredAuth,
  ): Promise<OAuthClientCredentials | null> {
    if (!discovered.server.clientIdMetadataDocumentSupported) return null;
    const metadataUrl = this.cimd.url;
    if (!metadataUrl) {
      this.deps.log?.(
        `[mcpOAuth] issuer ${discovered.server.issuer} supports Client ID Metadata Documents, but no inbound-reachable public base URL is configured (set FLOW_PUBLIC_BASE_URL) — falling through to the manual client path.`,
      );
      return null;
    }
    const reach = await this.cimd.get();
    if (!reach.reachable) {
      this.deps.log?.(
        `[mcpOAuth] issuer ${discovered.server.issuer} supports Client ID Metadata Documents, but ${metadataUrl} is not inbound-reachable (${reach.reason}) — falling through to the manual client path.`,
      );
      return null;
    }
    // A CIMD client is public by construction: the document is world-readable,
    // so there is no secret to hold and PKCE alone protects the exchange.
    // `clientSecretRef` stays null — nothing is written to the vault.
    await this.deps.graph.upsertMcpOAuthClient({
      issuer: discovered.server.issuer,
      clientId: metadataUrl,
      clientSecretRef: null,
      registeredVia: 'cimd',
      clientMetadataUrl: metadataUrl,
    });
    this.deps.log?.(
      `[mcpOAuth] issuer ${discovered.server.issuer} acquired via Client ID Metadata Document ${metadataUrl}`,
    );
    return { clientId: metadataUrl, clientSecret: null };
  }

  /**
   * Operator-provided client for an issuer, registered once by hand.
   *
   * W2-4: this is a FIRST-CLASS, PERMANENT path, not a legacy fallback. Entra ID
   * and Okta do not support Client ID Metadata Documents and never will need to
   * — they use pre-registered app registrations, which is exactly this. CIMD
   * only replaces Dynamic Client Registration at MCP-native brokers. Do not
   * deprecate or gate this behind a CIMD-unavailable check.
   */
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
      clientMetadataUrl: null,
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
   *  - brokered=true        → a client can be acquired with NO operator setup:
   *    either a Client ID Metadata Document (W2-4) or working DCR.
   *  - brokered=false       → a one-time operator OAuth app is required. For
   *    Entra ID / Okta this is the normal, permanent path — not a defect.
   *
   * `acquisitionMode` names WHICH link of the chain applies, and
   * `cimdBlockedReason` explains a CIMD-capable issuer we still cannot use
   * (almost always: no inbound https reachability on this install).
   * `issuerHost` is the human-readable host the OAuth actually goes to.
   */
  async describeAuth(server: McpServerRow): Promise<McpAuthDescription> {
    const unprotected: McpAuthDescription = {
      protected: false,
      issuer: null,
      issuerHost: null,
      brokered: false,
      acquisitionMode: 'manual',
      cimdSupported: false,
      cimdBlockedReason: null,
    };
    if (!server.endpoint) return unprotected;
    // stdio servers are local commands, not OAuth-protected HTTP endpoints —
    // never run OAuth discovery/connect for them (epic #459).
    if (server.transport === 'stdio') return unprotected;
    let discovered;
    try {
      discovered = await this.discovery.discover(this.resolveEndpoint(server));
    } catch {
      return { ...unprotected, protected: true };
    }
    if (!discovered) return unprotected;
    const issuer = discovered.server.issuer;
    let issuerHost: string | null = null;
    try {
      issuerHost = new URL(discovered.server.tokenEndpoint).host;
    } catch {
      /* keep null */
    }

    // An already-stored client short-circuits: report the mode it was acquired
    // through rather than re-probing anything.
    const storedRow = await this.deps.graph.getMcpOAuthClient(issuer);
    if (storedRow) {
      return {
        protected: true,
        issuer,
        issuerHost,
        brokered: storedRow.registeredVia !== 'manual',
        acquisitionMode: storedRow.registeredVia === 'manual' ? 'manual' : storedRow.registeredVia,
        cimdSupported: discovered.server.clientIdMetadataDocumentSupported,
        cimdBlockedReason: null,
      };
    }

    const cimdSupported = discovered.server.clientIdMetadataDocumentSupported;
    let cimdBlockedReason: CimdBlockedReason | null = null;
    if (cimdSupported) {
      const reach = await this.cimd.get();
      if (reach.reachable) {
        // CIMD is live for this issuer — zero operator setup, and the manual
        // form must NOT be shown as if it were required.
        return {
          protected: true,
          issuer,
          issuerHost,
          brokered: true,
          acquisitionMode: 'cimd',
          cimdSupported: true,
          cimdBlockedReason: null,
        };
      }
      cimdBlockedReason = reach.reason;
    }

    // "brokered" via DCR = DCR REALLY works, not just that it's advertised.
    // Probe it (result cached) so the UI never promises zero-setup for a server
    // whose registration is gated.
    const dcrWorks =
      discovered.server.registrationEndpoint !== null && (await this.canBrokerClient(discovered));
    return {
      protected: true,
      issuer,
      issuerHost,
      brokered: dcrWorks,
      acquisitionMode: dcrWorks ? 'dcr' : 'manual',
      cimdSupported,
      cimdBlockedReason,
    };
  }

  /** True when we can obtain an OAuth client for this issuer WITHOUT operator
   *  setup — either one is already stored, or the acquisition chain (cimd, then
   *  DCR) actually succeeds. A success also persists the client, so a later
   *  Connect is instant. Failure (e.g. a gated DCR endpoint) is cached as
   *  not-brokered. */
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
    /** Issuer that minted this token (W0-1) — recorded so a later issuer
     *  rotation invalidates it instead of replaying it at a different AS. */
    issuer?: string | null,
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
      issuer: issuer ?? null,
    });
  }

  /** Origin the server's well-known lives under (for logging/UI). */
  static origin(endpoint: string): string {
    return serverOrigin(endpoint);
  }
}
