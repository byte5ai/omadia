import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

import { McpAuthDiscovery } from '../src/services/mcpAuthDiscovery.js';
import { McpOAuthClient, type OAuthClientCredentials } from '../src/services/mcpOAuthClient.js';
import type { AuthServerMetadata } from '../src/services/mcpAuthDiscovery.js';

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

  it('brokered=true when the server offers DCR (zero-setup)', async () => {
    const { McpOAuthService } = await import('../src/services/mcpOAuthService.js');
    const discovery = {
      discover: async () => ({
        resource: { resource: 'https://srv.example', authorizationServers: ['https://as.example'], scopesSupported: ['read'], bearerMethods: ['header'] },
        server: { ...AS, registrationEndpoint: 'https://as.example/register', tokenEndpoint: 'https://as.example/token' },
      }),
    } as never;
    const svc = new McpOAuthService({ ...deps, discovery });
    const d = await svc.describeAuth(server);
    assert.equal(d.protected, true);
    assert.equal(d.brokered, true);
    assert.equal(d.issuerHost, 'as.example');
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
