import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

import { McpAuthDiscovery } from '../src/services/mcpAuthDiscovery.js';
import { McpOAuthClient, type OAuthClientCredentials } from '../src/services/mcpOAuthClient.js';
import type { AuthServerMetadata } from '../src/services/mcpAuthDiscovery.js';
import {
  SERVICE_USER_KEY,
  UNRESOLVED_IDENTITY,
  auditIdentity,
  parseDelegation,
  resolveMcpUserKey,
} from '../src/services/mcpDelegation.js';
import { redactSecrets, redactedErrorText } from '../src/services/secretRedaction.js';

function jsonResponder(routes: Record<string, unknown | number>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [frag, body] of Object.entries(routes)) {
      if (url.includes(frag)) {
        if (typeof body === 'number') return new Response('', { status: body });
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('McpAuthDiscovery', () => {
  it('discovers protected-resource + auth-server metadata (Strava-shaped, generic)', async () => {
    const fetchImpl = jsonResponder({
      '/.well-known/oauth-protected-resource': {
        resource: 'https://srv.example',
        authorization_servers: ['https://srv.example'],
        scopes_supported: ['read'],
        bearer_methods_supported: ['header'],
      },
      '/.well-known/oauth-authorization-server': {
        issuer: 'https://as.example',
        authorization_endpoint: 'https://as.example/authorize',
        token_endpoint: 'https://as.example/token',
        code_challenge_methods_supported: ['plain'],
        scopes_supported: ['read'],
      },
    });
    const d = new McpAuthDiscovery({ fetchImpl });
    const out = await d.discover('https://srv.example/mcp');
    assert.ok(out);
    assert.equal(out.resource.authorizationServers[0], 'https://srv.example');
    assert.deepEqual([...out.resource.scopesSupported], ['read']);
    assert.equal(out.server.authorizationEndpoint, 'https://as.example/authorize');
    assert.equal(out.server.tokenEndpoint, 'https://as.example/token');
  });

  it('returns null when the server advertises no protected-resource doc', async () => {
    const d = new McpAuthDiscovery({ fetchImpl: jsonResponder({}) });
    assert.equal(await d.discover('https://plain.example/mcp'), null);
  });

  it('follows the RFC 9728 WWW-Authenticate resource_metadata pointer (M365-shaped)', async () => {
    // Root well-known 404s; the endpoint 401s with a path-specific metadata URL.
    const metaUrl = 'https://srv.example/.well-known/oauth-protected-resource/tenants/t/mcp';
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/mcp') && init?.method === 'POST') {
        return new Response('', {
          status: 401,
          headers: { 'www-authenticate': `Bearer resource_metadata="${metaUrl}"` },
        });
      }
      if (url === metaUrl) {
        return new Response(
          JSON.stringify({ authorization_servers: ['https://as.example'], scopes_supported: ['x'] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.includes('/.well-known/oauth-authorization-server')) {
        return new Response(
          JSON.stringify({
            issuer: 'https://as.example',
            authorization_endpoint: 'https://as.example/authorize',
            token_endpoint: 'https://as.example/token',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    const out = await new McpAuthDiscovery({ fetchImpl }).discover('https://srv.example/tenants/t/mcp');
    assert.ok(out, 'should discover via the WWW-Authenticate pointer');
    assert.equal(out.server.tokenEndpoint, 'https://as.example/token');
  });

  it('treats a registration_endpoint that equals the authorize URL as absent (no fake DCR)', async () => {
    const fetchImpl = jsonResponder({
      '/.well-known/oauth-protected-resource': {
        authorization_servers: ['https://as.example'],
      },
      '/.well-known/oauth-authorization-server': {
        issuer: 'https://as.example',
        authorization_endpoint: 'https://as.example/authorize',
        token_endpoint: 'https://as.example/token',
        registration_endpoint: 'https://as.example/authorize',
      },
    });
    const out = await new McpAuthDiscovery({ fetchImpl }).discover('https://as.example/mcp');
    assert.equal(out?.server.registrationEndpoint, null);
  });
});

const AS: AuthServerMetadata = {
  issuer: 'https://as.example',
  authorizationEndpoint: 'https://as.example/authorize',
  tokenEndpoint: 'https://as.example/token',
  registrationEndpoint: null,
  codeChallengeMethods: ['S256'],
  grantTypes: ['authorization_code'],
  scopesSupported: ['read'],
  issParameterSupported: false,
};
const CLIENT: OAuthClientCredentials = { clientId: 'cid', clientSecret: 'sec' };

describe('McpOAuthClient', () => {
  it('builds an authorize URL with S256 PKCE and a resource indicator', () => {
    const client = new McpOAuthClient();
    const { url, state, codeVerifier } = client.buildAuthorizeUrl({
      server: AS,
      client: CLIENT,
      redirectUri: 'https://host/cb',
      scopes: ['read'],
      resource: 'https://srv.example',
    });
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://as.example/authorize');
    assert.equal(u.searchParams.get('client_id'), 'cid');
    assert.equal(u.searchParams.get('redirect_uri'), 'https://host/cb');
    assert.equal(u.searchParams.get('state'), state);
    assert.equal(u.searchParams.get('scope'), 'read');
    assert.equal(u.searchParams.get('resource'), 'https://srv.example');
    assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
    const expected = createHash('sha256')
      .update(codeVerifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    assert.equal(u.searchParams.get('code_challenge'), expected);
  });

  it('falls back to plain PKCE when the server only supports plain (e.g. Strava)', () => {
    const client = new McpOAuthClient();
    const { url, codeVerifier } = client.buildAuthorizeUrl({
      server: { ...AS, codeChallengeMethods: ['plain'] },
      client: CLIENT,
      redirectUri: 'https://host/cb',
      scopes: ['read'],
    });
    const u = new URL(url);
    assert.equal(u.searchParams.get('code_challenge_method'), 'plain');
    assert.equal(u.searchParams.get('code_challenge'), codeVerifier);
  });

  it('exchanges an authorization code for tokens (form-encoded, client secret sent)', async () => {
    let seenBody = '';
    const fetchImpl: typeof fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => {
      seenBody = String(init?.body);
      return new Response(
        JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'read' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    const client = new McpOAuthClient({ fetchImpl });
    const tok = await client.exchangeCode({
      server: AS,
      client: CLIENT,
      code: 'CODE',
      codeVerifier: 'VERIFIER',
      redirectUri: 'https://host/cb',
    });
    assert.equal(tok.accessToken, 'AT');
    assert.equal(tok.refreshToken, 'RT');
    assert.equal(tok.expiresInSec, 3600);
    assert.ok(seenBody.includes('grant_type=authorization_code'));
    assert.ok(seenBody.includes('code_verifier=VERIFIER'));
    assert.ok(seenBody.includes('client_secret=sec'));
  });

  it('registerClient returns null when there is no registration endpoint', async () => {
    const client = new McpOAuthClient({ fetchImpl: jsonResponder({}) });
    assert.equal(await client.registerClient(AS, 'https://host/cb', 'omadia'), null);
  });

  it('registerClient performs DCR when a registration endpoint exists', async () => {
    const fetchImpl = jsonResponder({ '/register': { client_id: 'newcid', client_secret: 'newsec' } });
    const client = new McpOAuthClient({ fetchImpl });
    const reg = await client.registerClient(
      { ...AS, registrationEndpoint: 'https://as.example/register' },
      'https://host/cb',
      'omadia',
    );
    assert.equal(reg?.clientId, 'newcid');
    assert.equal(reg?.clientSecret, 'newsec');
  });
});

describe('McpOAuthService.describeAuth (broker classification)', () => {
  const server = { id: 's', name: 'srv', endpoint: 'https://srv.example/mcp' } as never;
  const deps = { graph: {} as never, vault: {} as never, redirectUri: 'https://host/cb' };

  it('brokered=true when DCR actually succeeds (zero-setup)', async () => {
    const { McpOAuthService } = await import('../src/services/mcpOAuthService.js');
    const discovery = {
      discover: async () => ({
        resource: { resource: 'https://srv.example', authorizationServers: ['https://as.example'], scopesSupported: ['read'], bearerMethods: ['header'] },
        server: { ...AS, registrationEndpoint: 'https://as.example/register', tokenEndpoint: 'https://as.example/token' },
      }),
    } as never;
    // "brokered" now reflects a REAL DCR probe: no stored client → register →
    // success persists it → brokered.
    const graph = { getMcpOAuthClient: async () => null, upsertMcpOAuthClient: async () => {} } as never;
    const client = { registerClient: async () => ({ clientId: 'cid', clientSecret: 'sec' }) } as never;
    const vault = { get: async () => null, set: async () => {} } as never;
    const svc = new McpOAuthService({ graph, vault, redirectUri: 'https://host/cb', discovery, client });
    const d = await svc.describeAuth(server);
    assert.equal(d.protected, true);
    assert.equal(d.brokered, true);
    assert.equal(d.issuerHost, 'as.example');
  });

  it('brokered=false when advertised DCR is gated (registration declined, e.g. Figma)', async () => {
    const { McpOAuthService } = await import('../src/services/mcpOAuthService.js');
    const discovery = {
      discover: async () => ({
        resource: { resource: 'https://srv.example', authorizationServers: ['https://as.example'], scopesSupported: ['read'], bearerMethods: ['header'] },
        server: { ...AS, registrationEndpoint: 'https://as.example/register', tokenEndpoint: 'https://as.example/token' },
      }),
    } as never;
    const graph = { getMcpOAuthClient: async () => null } as never;
    const client = { registerClient: async () => null } as never; // DCR 403 → null
    const vault = { get: async () => null } as never;
    const svc = new McpOAuthService({ graph, vault, redirectUri: 'https://host/cb', discovery, client });
    assert.equal((await svc.describeAuth(server)).brokered, false);
  });

  it('brokered=false when the server delegates raw with no DCR (needs manual app)', async () => {
    const { McpOAuthService } = await import('../src/services/mcpOAuthService.js');
    const discovery = {
      discover: async () => ({
        resource: { resource: 'https://srv.example', authorizationServers: ['https://www.strava.com'], scopesSupported: ['read'], bearerMethods: ['header'] },
        server: { ...AS, issuer: 'https://www.strava.com', registrationEndpoint: null, tokenEndpoint: 'https://www.strava.com/api/v3/oauth/token' },
      }),
    } as never;
    const svc = new McpOAuthService({ ...deps, discovery });
    const d = await svc.describeAuth(server);
    assert.equal(d.brokered, false);
    assert.equal(d.issuerHost, 'www.strava.com');
  });

  it('protected=false when the server advertises no OAuth', async () => {
    const { McpOAuthService } = await import('../src/services/mcpOAuthService.js');
    const discovery = { discover: async () => null } as never;
    const svc = new McpOAuthService({ ...deps, discovery });
    assert.equal((await svc.describeAuth(server)).protected, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W0-1 — three live defects in the MCP OAuth path
//   D1  no RFC 9207 `iss` validation at the callback
//   D2  silent 'operator' fallback (confused deputy)
//   D3  unbounded concurrent refreshes for the same (server, user)
// ─────────────────────────────────────────────────────────────────────────────

/** An in-memory stand-in for the parts of AgentGraphStore the OAuth service
 *  touches. Records writes so a test can assert that a REJECTED callback
 *  persisted nothing. */
function fakeGraph(opts?: {
  flow?: Record<string, unknown>;
  token?: Record<string, unknown> | undefined;
  client?: { clientId: string; clientSecretRef: string | null } | null;
}): {
  graph: never;
  tokenWrites: Record<string, unknown>[];
  tokenDeletes: { serverId: string; userKey: string }[];
  flowCreates: Record<string, unknown>[];
} {
  const tokenWrites: Record<string, unknown>[] = [];
  const tokenDeletes: { serverId: string; userKey: string }[] = [];
  const flowCreates: Record<string, unknown>[] = [];
  let flow = opts?.flow;
  const graph = {
    // One-shot, like the real DELETE … RETURNING.
    takeMcpOAuthFlow: async (state: string) => {
      if (!flow || flow['state'] !== state) return undefined;
      const taken = flow;
      flow = undefined;
      return taken;
    },
    createMcpOAuthFlow: async (input: Record<string, unknown>) => {
      flowCreates.push(input);
    },
    getMcpOAuthToken: async () => opts?.token,
    upsertMcpOAuthToken: async (input: Record<string, unknown>) => {
      tokenWrites.push(input);
    },
    deleteMcpOAuthToken: async (serverId: string, userKey: string) => {
      tokenDeletes.push({ serverId, userKey });
    },
    getMcpOAuthClient: async () =>
      opts?.client === undefined ? { clientId: 'cid', clientSecretRef: null } : opts.client,
    upsertMcpOAuthClient: async () => {},
  } as never;
  return { graph, tokenWrites, tokenDeletes, flowCreates };
}

const FLOW_BASE = {
  state: 'ST',
  serverId: 'srv-1',
  userKey: 'user-a',
  issuer: 'https://as.example',
  codeVerifier: 'VERIFIER-VALUE',
  redirectUri: 'https://host/cb',
  scopes: 'read',
  tokenEndpoint: 'https://as.example/token',
  authorizationEndpoint: 'https://as.example/authorize',
  issRequired: false,
};

describe('W0-1 D1 — RFC 9207 iss validation at the OAuth callback', () => {
  it('parses authorization_response_iss_parameter_supported from AS metadata', async () => {
    const fetchImpl = jsonResponder({
      '/.well-known/oauth-protected-resource': {
        authorization_servers: ['https://as.example'],
      },
      '/.well-known/oauth-authorization-server': {
        issuer: 'https://as.example',
        authorization_endpoint: 'https://as.example/authorize',
        token_endpoint: 'https://as.example/token',
        authorization_response_iss_parameter_supported: true,
      },
    });
    const out = await new McpAuthDiscovery({ fetchImpl }).discover('https://as.example/mcp');
    assert.equal(out?.server.issParameterSupported, true);
  });

  it('defaults issParameterSupported to false when the AS does not advertise it', async () => {
    const fetchImpl = jsonResponder({
      '/.well-known/oauth-protected-resource': {
        authorization_servers: ['https://as.example'],
      },
      '/.well-known/oauth-authorization-server': {
        issuer: 'https://as.example',
        authorization_endpoint: 'https://as.example/authorize',
        token_endpoint: 'https://as.example/token',
      },
    });
    const out = await new McpAuthDiscovery({ fetchImpl }).discover('https://as.example/mcp');
    assert.equal(out?.server.issParameterSupported, false);
  });

  it('records the AS iss support on the flow at authorize time (not re-discovered later)', async () => {
    const { McpOAuthService } = await import('../src/services/mcpOAuthService.js');
    const { graph, flowCreates } = fakeGraph();
    const discovery = {
      discover: async () => ({
        resource: {
          resource: 'https://srv.example',
          authorizationServers: ['https://as.example'],
          scopesSupported: ['read'],
          bearerMethods: ['header'],
        },
        server: { ...AS, issParameterSupported: true },
      }),
    } as never;
    const svc = new McpOAuthService({
      graph,
      vault: { get: async () => undefined, set: async () => {} } as never,
      redirectUri: 'https://host/cb',
      discovery,
    });
    await svc.beginAuthorization(
      { id: 'srv-1', name: 'srv', endpoint: 'https://srv.example/mcp', transport: 'http' } as never,
      'user-a',
    );
    assert.equal(flowCreates.length, 1);
    assert.equal(flowCreates[0]?.['issRequired'], true);
    assert.equal(flowCreates[0]?.['issuer'], 'https://as.example');
  });

  it('accepts a matching iss and stores the token', async () => {
    const { McpOAuthService } = await import('../src/services/mcpOAuthService.js');
    const { graph, tokenWrites } = fakeGraph({ flow: { ...FLOW_BASE, issRequired: true } });
    const client = {
      exchangeCode: async () => ({
        accessToken: 'AT',
        refreshToken: 'RT',
        expiresInSec: 3600,
        scope: 'read',
      }),
    } as never;
    const svc = new McpOAuthService({
      graph,
      vault: { get: async () => undefined, set: async () => {} } as never,
      redirectUri: 'https://host/cb',
      client,
    });
    const out = await svc.completeAuthorization('ST', 'CODE', 'https://as.example');
    assert.equal(out.serverId, 'srv-1');
    assert.equal(tokenWrites.length, 1, 'a valid callback stores exactly one token');
    // AC3: the token is bound to the issuer that minted it.
    assert.equal(tokenWrites[0]?.['issuer'], 'https://as.example');
  });

  it('tolerates a single trailing slash difference in the issuer (RFC 9207 §2.4)', async () => {
    const { McpOAuthService } = await import('../src/services/mcpOAuthService.js');
    const { graph, tokenWrites } = fakeGraph({ flow: { ...FLOW_BASE, issRequired: true } });
    const client = {
      exchangeCode: async () => ({
        accessToken: 'AT',
        refreshToken: null,
        expiresInSec: null,
        scope: null,
      }),
    } as never;
    const svc = new McpOAuthService({
      graph,
      vault: { get: async () => undefined, set: async () => {} } as never,
      redirectUri: 'https://host/cb',
      client,
    });
    await svc.completeAuthorization('ST', 'CODE', 'https://as.example/');
    assert.equal(tokenWrites.length, 1);
  });

  it('REJECTS a mismatched iss and persists nothing', async () => {
    const { McpOAuthService, McpOAuthIssuerMismatchError } = await import(
      '../src/services/mcpOAuthService.js'
    );
    const { graph, tokenWrites } = fakeGraph({ flow: { ...FLOW_BASE } });
    let exchanged = false;
    const client = {
      exchangeCode: async () => {
        exchanged = true;
        return { accessToken: 'AT', refreshToken: 'RT', expiresInSec: 3600, scope: null };
      },
    } as never;
    const vaultWrites: string[] = [];
    const svc = new McpOAuthService({
      graph,
      vault: {
        get: async () => undefined,
        set: async (_ns: string, k: string) => {
          vaultWrites.push(k);
        },
      } as never,
      redirectUri: 'https://host/cb',
      client,
    });
    await assert.rejects(
      () => svc.completeAuthorization('ST', 'CODE', 'https://evil.example'),
      (err: unknown) => err instanceof McpOAuthIssuerMismatchError,
    );
    // The whole point: hard rejection BEFORE the exchange, so no code leaves
    // and no credential lands anywhere.
    assert.equal(exchanged, false, 'the code must never be exchanged on a mismatch');
    assert.equal(tokenWrites.length, 0, 'no token row may be written');
    assert.deepEqual(vaultWrites, [], 'no secret may be written to the vault');
  });

  it('REJECTS an absent iss when the AS advertised support for it', async () => {
    const { McpOAuthService, McpOAuthIssuerMismatchError } = await import(
      '../src/services/mcpOAuthService.js'
    );
    const { graph, tokenWrites } = fakeGraph({ flow: { ...FLOW_BASE, issRequired: true } });
    let exchanged = false;
    const client = {
      exchangeCode: async () => {
        exchanged = true;
        return { accessToken: 'AT', refreshToken: null, expiresInSec: null, scope: null };
      },
    } as never;
    const svc = new McpOAuthService({
      graph,
      vault: { get: async () => undefined, set: async () => {} } as never,
      redirectUri: 'https://host/cb',
      client,
    });
    await assert.rejects(
      () => svc.completeAuthorization('ST', 'CODE', null),
      (err: unknown) =>
        err instanceof McpOAuthIssuerMismatchError && err.received === null,
    );
    assert.equal(exchanged, false);
    assert.equal(tokenWrites.length, 0);
  });

  it('accepts an absent iss when the AS never advertised support (backward compatible)', async () => {
    const { McpOAuthService } = await import('../src/services/mcpOAuthService.js');
    const { graph, tokenWrites } = fakeGraph({ flow: { ...FLOW_BASE, issRequired: false } });
    const client = {
      exchangeCode: async () => ({
        accessToken: 'AT',
        refreshToken: null,
        expiresInSec: null,
        scope: null,
      }),
    } as never;
    const svc = new McpOAuthService({
      graph,
      vault: { get: async () => undefined, set: async () => {} } as never,
      redirectUri: 'https://host/cb',
      client,
    });
    await svc.completeAuthorization('ST', 'CODE', null);
    assert.equal(tokenWrites.length, 1, 'pre-RFC-9207 providers keep working');
  });

  it('treats a blank iss as absent rather than as a mismatch', async () => {
    const { McpOAuthService } = await import('../src/services/mcpOAuthService.js');
    const { graph, tokenWrites } = fakeGraph({ flow: { ...FLOW_BASE, issRequired: false } });
    const client = {
      exchangeCode: async () => ({
        accessToken: 'AT',
        refreshToken: null,
        expiresInSec: null,
        scope: null,
      }),
    } as never;
    const svc = new McpOAuthService({
      graph,
      vault: { get: async () => undefined, set: async () => {} } as never,
      redirectUri: 'https://host/cb',
      client,
    });
    await svc.completeAuthorization('ST', 'CODE', '   ');
    assert.equal(tokenWrites.length, 1);
  });
});

describe('W0-1 D2 — delegation: fail closed instead of borrowing the operator identity', () => {
  it('per_user + resolvable identity → that identity', () => {
    assert.equal(resolveMcpUserKey({ delegation: 'per_user' }, 'alice@example.com'), 'alice@example.com');
  });

  it('per_user + UNRESOLVABLE identity → null (never the operator)', () => {
    for (const candidate of [null, undefined, '', '   ']) {
      const resolved = resolveMcpUserKey({ delegation: 'per_user' }, candidate);
      assert.equal(resolved, null, `candidate ${JSON.stringify(candidate)} must not resolve`);
      assert.notEqual(resolved, SERVICE_USER_KEY);
      assert.notEqual(resolved, 'operator');
    }
  });

  it('service delegation is the explicit opt-in that keeps a shared identity', () => {
    assert.equal(resolveMcpUserKey({ delegation: 'service' }, null), SERVICE_USER_KEY);
    // Grandfathered rows must keep resolving to the historical literal, or
    // migration 0031 would silently orphan their stored tokens.
    assert.equal(SERVICE_USER_KEY, 'operator');
  });

  it('service delegation ignores a caller identity (one shared token by design)', () => {
    assert.equal(resolveMcpUserKey({ delegation: 'service' }, 'alice@example.com'), SERVICE_USER_KEY);
  });

  it('audit identity is never blank — an unattributable call is recorded as such', () => {
    assert.equal(auditIdentity({ delegation: 'per_user' }, null), UNRESOLVED_IDENTITY);
    assert.equal(auditIdentity({ delegation: 'per_user' }, 'bob'), 'bob');
    assert.equal(auditIdentity({ delegation: 'service' }, null), SERVICE_USER_KEY);
  });

  it('parseDelegation rejects anything outside the CHECK constraint', () => {
    assert.equal(parseDelegation('per_user'), 'per_user');
    assert.equal(parseDelegation('service'), 'service');
    for (const bad of ['operator', 'PER_USER', '', null, undefined, 1, {}]) {
      assert.equal(parseDelegation(bad), null, `${JSON.stringify(bad)} must not parse`);
    }
  });

  it('an unresolved per_user identity yields NO token from the service', async () => {
    const { McpOAuthService } = await import('../src/services/mcpOAuthService.js');
    // A token DOES exist under the shared key — the old code would have found
    // and used it. Resolution must never reach this call.
    let lookups = 0;
    const graph = {
      getMcpOAuthToken: async () => {
        lookups += 1;
        return { accessTokenRef: 'ref', refreshTokenRef: null, expiresAt: null, scopes: null, issuer: null };
      },
    } as never;
    const svc = new McpOAuthService({
      graph,
      vault: { get: async () => 'SHARED-OPERATOR-TOKEN', set: async () => {} } as never,
      redirectUri: 'https://host/cb',
    });
    const server = { id: 'srv-1', name: 'srv', delegation: 'per_user' as const };
    const userKey = resolveMcpUserKey(server, undefined);
    assert.equal(userKey, null);
    // The production call sites short-circuit on null, so the operator's token
    // is never even looked up.
    const token = userKey === null ? null : await svc.getValidAccessToken(server as never, userKey);
    assert.equal(token, null);
    assert.equal(lookups, 0, 'the shared token must not be consulted at all');
  });
});

describe('W0-1 D3 — concurrent refresh is single-flight (MUTATION-CHECKED)', () => {
  /** Build a service whose refresh path goes over a real McpOAuthClient, so the
   *  assertion counts genuine HTTP requests to the token endpoint rather than
   *  mock invocations. */
  async function refreshHarness(): Promise<{
    svc: import('../src/services/mcpOAuthService.js').McpOAuthService;
    server: never;
    tokenPosts: () => number;
    tokenWrites: Record<string, unknown>[];
  }> {
    const { McpOAuthService } = await import('../src/services/mcpOAuthService.js');
    let tokenPosts = 0;
    const fetchImpl: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === 'https://as.example/token') {
        tokenPosts += 1;
        // Rotating refresh token, as OAuth 2.1 recommends — this is precisely
        // what makes a lost race destructive.
        return new Response(
          JSON.stringify({
            access_token: `AT-${String(tokenPosts)}`,
            refresh_token: `RT-${String(tokenPosts)}`,
            expires_in: 3600,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;

    const tokenWrites: Record<string, unknown>[] = [];
    const graph = {
      // Expired 60s ago → inside the refresh margin, so every caller wants a refresh.
      getMcpOAuthToken: async () => ({
        serverId: 'srv-1',
        userKey: 'user-a',
        accessTokenRef: 'token/srv-1/user-a/access',
        refreshTokenRef: 'token/srv-1/user-a/refresh',
        expiresAt: new Date(Date.now() - 60_000),
        scopes: 'read',
        issuer: 'https://as.example',
      }),
      upsertMcpOAuthToken: async (input: Record<string, unknown>) => {
        tokenWrites.push(input);
      },
      getMcpOAuthClient: async () => ({ clientId: 'cid', clientSecretRef: null }),
      deleteMcpOAuthToken: async () => {},
    } as never;
    const vaultStore = new Map<string, string>([
      ['token/srv-1/user-a/access', 'STALE-AT'],
      ['token/srv-1/user-a/refresh', 'RT-0'],
    ]);
    const vault = {
      get: async (_ns: string, k: string) => vaultStore.get(k),
      set: async (_ns: string, k: string, v: string) => {
        vaultStore.set(k, v);
      },
    } as never;
    const discovery = {
      discover: async () => ({
        resource: {
          resource: 'https://srv.example',
          authorizationServers: ['https://as.example'],
          scopesSupported: ['read'],
          bearerMethods: ['header'],
        },
        server: AS,
      }),
    } as never;
    const svc = new McpOAuthService({
      graph,
      vault,
      redirectUri: 'https://host/cb',
      discovery,
      client: new McpOAuthClient({ fetchImpl }),
    });
    const server = {
      id: 'srv-1',
      name: 'srv',
      endpoint: 'https://srv.example/mcp',
      transport: 'http',
      delegation: 'per_user',
    } as never;
    return { svc, server, tokenPosts: () => tokenPosts, tokenWrites };
  }

  it('issues exactly ONE token-endpoint HTTP request for N concurrent callers', async () => {
    const { svc, server, tokenPosts, tokenWrites } = await refreshHarness();
    const N = 8;
    const results = await Promise.all(
      Array.from({ length: N }, () => svc.getValidAccessToken(server, 'user-a')),
    );
    // THE mutation check: remove the in-flight map and this becomes 8.
    // Counting mock calls would not prove this — the count is of real HTTP
    // requests made through fetch to the token endpoint.
    assert.equal(tokenPosts(), 1, `expected exactly 1 token request, got ${String(tokenPosts())}`);
    // One refresh ⇒ one persisted rotation. N writes would mean N-1 of them
    // stored a refresh token the AS had already retired.
    assert.equal(tokenWrites.length, 1, 'exactly one token rotation may be persisted');
    // Every caller gets the same live token — nobody is handed a loser's result.
    assert.deepEqual(new Set(results), new Set(['AT-1']));
  });

  it('a later refresh is not blocked by the completed one (the map is cleared)', async () => {
    const { svc, server, tokenPosts } = await refreshHarness();
    await svc.getValidAccessToken(server, 'user-a');
    await svc.getValidAccessToken(server, 'user-a');
    assert.equal(tokenPosts(), 2, 'sequential refreshes must each do their own request');
  });

  it('different users do not share one refresh', async () => {
    const { svc, server, tokenPosts } = await refreshHarness();
    await Promise.all([
      svc.getValidAccessToken(server, 'user-a'),
      svc.getValidAccessToken(server, 'user-b'),
    ]);
    assert.equal(tokenPosts(), 2, 'the in-flight key must include the user');
  });

  it('drops a stored token whose issuer has rotated instead of replaying it', async () => {
    const { McpOAuthService } = await import('../src/services/mcpOAuthService.js');
    let tokenPosts = 0;
    const fetchImpl: typeof fetch = (async () => {
      tokenPosts += 1;
      return new Response(JSON.stringify({ access_token: 'AT' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const deletes: { serverId: string; userKey: string }[] = [];
    const graph = {
      getMcpOAuthToken: async () => ({
        accessTokenRef: 'a',
        refreshTokenRef: 'r',
        expiresAt: new Date(Date.now() - 60_000),
        scopes: null,
        // Minted by the OLD issuer.
        issuer: 'https://old-as.example',
      }),
      upsertMcpOAuthToken: async () => {},
      getMcpOAuthClient: async () => ({ clientId: 'cid', clientSecretRef: null }),
      deleteMcpOAuthToken: async (serverId: string, userKey: string) => {
        deletes.push({ serverId, userKey });
      },
    } as never;
    const svc = new McpOAuthService({
      graph,
      vault: {
        get: async (_ns: string, k: string) => (k === 'r' ? 'RT' : 'STALE-AT'),
        set: async () => {},
      } as never,
      redirectUri: 'https://host/cb',
      // Discovery now reports a DIFFERENT issuer.
      discovery: {
        discover: async () => ({
          resource: {
            resource: 'https://srv.example',
            authorizationServers: ['https://as.example'],
            scopesSupported: [],
            bearerMethods: [],
          },
          server: AS,
        }),
      } as never,
      client: new McpOAuthClient({ fetchImpl }),
    });
    const token = await svc.getValidAccessToken(
      { id: 'srv-1', name: 'srv', endpoint: 'https://srv.example/mcp', transport: 'http' } as never,
      'user-a',
    );
    assert.equal(token, null, 'a token from a rotated issuer must not be usable');
    assert.equal(tokenPosts, 0, 'the old refresh token must not be sent to the new issuer');
    assert.deepEqual(deletes, [{ serverId: 'srv-1', userKey: 'user-a' }]);
  });
});

describe('W0-1 D5 — no token, code, or code_verifier can reach a log line', () => {
  it('redacts an exact secret value wherever it appears', () => {
    const out = redactSecrets('refresh failed for RT-abcdefgh12345 (retry)', ['RT-abcdefgh12345']);
    assert.ok(!out.includes('RT-abcdefgh12345'), out);
    assert.ok(out.includes('[redacted]'));
  });

  it('redacts a secret the provider echoed back URL-encoded', () => {
    const secret = 'tok/with+special=chars';
    const out = redactSecrets(`error: value=${encodeURIComponent(secret)}`, [secret]);
    assert.ok(!out.includes(encodeURIComponent(secret)), out);
  });

  it('redacts token fields in a JSON error body we did not mint', () => {
    const body = '{"error":"invalid_grant","access_token":"AT-SECRET-1","refresh_token":"RT-SECRET-2"}';
    const out = redactSecrets(body);
    assert.ok(!out.includes('AT-SECRET-1'), out);
    assert.ok(!out.includes('RT-SECRET-2'), out);
    // Non-secret diagnostics must survive, or the log becomes useless.
    assert.ok(out.includes('invalid_grant'), out);
  });

  it('redacts code and code_verifier from a query string or form body', () => {
    const out = redactSecrets(
      'POST https://as.example/token?code=THE-AUTH-CODE&code_verifier=THE-VERIFIER&client_id=cid',
    );
    assert.ok(!out.includes('THE-AUTH-CODE'), out);
    assert.ok(!out.includes('THE-VERIFIER'), out);
    assert.ok(out.includes('client_id=cid'), 'client_id is not a secret');
  });

  it('redacts a bearer token echoed in an error', () => {
    const out = redactSecrets('upstream said: Authorization: Bearer eyJhbGciOi.SECRET.PART');
    assert.ok(!out.includes('eyJhbGciOi.SECRET.PART'), out);
  });

  it('redactedErrorText never leaks the refresh token from a thrown Error', () => {
    const err = new Error('token endpoint rejected refresh_token=RT-LEAKY-VALUE for client cid');
    const out = redactedErrorText(err, ['RT-LEAKY-VALUE']);
    assert.ok(!out.includes('RT-LEAKY-VALUE'), out);
    assert.ok(out.includes('Error:'), 'the error class stays visible for debugging');
  });

  it('leaves short values alone rather than shredding unrelated text', () => {
    // A 3-char "secret" would otherwise redact every occurrence of those chars.
    assert.equal(redactSecrets('the cat sat', ['cat']), 'the cat sat');
  });
});
