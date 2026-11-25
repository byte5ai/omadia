import { McpOAuthClient } from '../../src/services/mcpOAuthClient.js';
import { McpOAuthService } from '../../src/services/mcpOAuthService.js';
import type { AuthServerMetadata } from '../../src/services/mcpAuthDiscovery.js';

/**
 * A stateful stand-in for what `McpOAuthService` stores: token rows in memory,
 * vault values in a map, and a real `McpOAuthClient` whose requests land in
 * `opts.respond`. Stateful so a test can read back what a call left behind,
 * which is the question the status and disconnect paths are about.
 */

export const HARNESS_ISSUER = 'https://as.example';
export const HARNESS_SERVER_ID = 'srv-1';

export interface HarnessTokenRow {
  serverId: string;
  userKey: string;
  accessTokenRef: string;
  refreshTokenRef: string | null;
  expiresAt: Date | null;
  scopes: string | null;
  issuer: string | null;
  invalidReason: 'refresh_failed' | 'rejected' | null;
}

export interface HarnessRequest {
  readonly url: string;
  readonly form: URLSearchParams;
}

const AUTH_SERVER: AuthServerMetadata = {
  issuer: HARNESS_ISSUER,
  authorizationEndpoint: `${HARNESS_ISSUER}/authorize`,
  tokenEndpoint: `${HARNESS_ISSUER}/token`,
  registrationEndpoint: null,
  revocationEndpoint: `${HARNESS_ISSUER}/revoke`,
  codeChallengeMethods: ['S256'],
  grantTypes: ['authorization_code', 'refresh_token'],
  scopesSupported: ['read'],
  issParameterSupported: false,
  clientIdMetadataDocumentSupported: false,
};

/** A token row for `userKey` with both vault refs, valid for another hour
 *  unless `over` says otherwise. */
export function tokenRow(userKey: string, over: Partial<HarnessTokenRow> = {}): HarnessTokenRow {
  return {
    serverId: HARNESS_SERVER_ID,
    userKey,
    accessTokenRef: `token/${HARNESS_SERVER_ID}/${userKey}/access`,
    refreshTokenRef: `token/${HARNESS_SERVER_ID}/${userKey}/refresh`,
    expiresAt: new Date(Date.now() + 3_600_000),
    scopes: 'read',
    issuer: HARNESS_ISSUER,
    invalidReason: null,
    ...over,
  };
}

export function mcpOAuthHarness(opts: {
  readonly rows?: readonly HarnessTokenRow[];
  /** Answers every request the OAuth client makes. Default: 404. */
  readonly respond?: (req: HarnessRequest) => Response | Promise<Response>;
  /** Overrides on the discovered authorization-server metadata. */
  readonly authServer?: Partial<AuthServerMetadata>;
}): {
  svc: McpOAuthService;
  /** The graph stub, for a router under test. */
  graph: never;
  server: never;
  row: (userKey: string) => HarnessTokenRow | undefined;
  vault: Map<string, string>;
  requests: HarnessRequest[];
  logs: string[];
} {
  const rows = new Map<string, HarnessTokenRow>();
  const vault = new Map<string, string>();
  for (const r of opts.rows ?? []) {
    rows.set(r.userKey, { ...r });
    vault.set(r.accessTokenRef, `AT-${r.userKey}`);
    if (r.refreshTokenRef) vault.set(r.refreshTokenRef, `RT-${r.userKey}`);
  }
  const requests: HarnessRequest[] = [];
  const logs: string[] = [];

  const fetchImpl: typeof fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const req = { url: String(input), form: new URLSearchParams(String(init?.body ?? '')) };
    requests.push(req);
    return opts.respond ? opts.respond(req) : new Response('not found', { status: 404 });
  }) as typeof fetch;

  const server = {
    id: HARNESS_SERVER_ID,
    name: 'srv',
    endpoint: 'https://srv.example/mcp',
    transport: 'http',
    delegation: 'per_user',
    headers: {},
    config: {},
  };

  const graph = {
    listMcpServers: async () => [server],
    getMcpOAuthToken: async (_serverId: string, userKey: string) => rows.get(userKey),
    // Mirrors the SQL upsert: a newly stored token carries no mark.
    upsertMcpOAuthToken: async (input: Omit<HarnessTokenRow, 'invalidReason'>) => {
      rows.set(input.userKey, { ...input, invalidReason: null });
    },
    markMcpOAuthTokenInvalid: async (
      _serverId: string,
      userKey: string,
      reason: 'refresh_failed' | 'rejected',
    ) => {
      // Mirrors the SQL update: the first mark wins.
      const row = rows.get(userKey);
      if (row && row.invalidReason === null) row.invalidReason = reason;
    },
    deleteMcpOAuthToken: async (_serverId: string, userKey: string) => {
      rows.delete(userKey);
    },
    listMcpOAuthTokenUserKeys: async () => [...rows.keys()],
    getMcpOAuthClient: async () => ({
      clientId: 'cid',
      clientSecretRef: null,
      registeredVia: 'dcr',
    }),
  } as never;

  const svc = new McpOAuthService({
    graph,
    vault: {
      get: async (_ns: string, key: string) => vault.get(key),
      set: async (_ns: string, key: string, value: string) => {
        vault.set(key, value);
      },
      listKeys: async () => [...vault.keys()].sort(),
      deleteKey: async (_ns: string, key: string) => {
        vault.delete(key);
      },
    } as never,
    redirectUri: 'https://host/cb',
    discovery: {
      discover: async () => ({
        resource: {
          resource: 'https://srv.example',
          authorizationServers: [HARNESS_ISSUER],
          scopesSupported: ['read'],
          bearerMethods: ['header'],
        },
        server: { ...AUTH_SERVER, ...opts.authServer },
      }),
    } as never,
    client: new McpOAuthClient({ fetchImpl }),
    log: (m) => logs.push(m),
  });

  return {
    svc,
    graph,
    server: server as never,
    row: (userKey) => rows.get(userKey),
    vault,
    requests,
    logs,
  };
}

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
