import { afterEach, describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express from 'express';

import {
  createAgentBuilderRouter,
  type AgentBuilderRouterOptions,
} from '../src/routes/agentBuilder.js';
import {
  DISCOVERY_UNAVAILABLE,
  McpAuthDiscovery,
  McpAuthDiscoveryError,
  UNADVERTISED_AUTH_CHALLENGE,
} from '../src/services/mcpAuthDiscovery.js';
import { McpOAuthService } from '../src/services/mcpOAuthService.js';

/**
 * A failed metadata read used to come back as `null`, the same value as "this
 * server is not protected", and was cached for five minutes. Figma's metadata
 * took ~8 s from the container and `api.figma.com` answered 503: the
 * authorization section disappeared and Discover answered 502 for a server that
 * plainly wanted OAuth. "Not protected" now needs an answer that says so.
 */

const ENDPOINT = 'https://srv.example/mcp';
const WELL_KNOWN = 'https://srv.example/.well-known/oauth-protected-resource';
const RESOURCE_DOC = {
  resource: 'https://srv.example',
  authorization_servers: ['https://as.example'],
};
const AS_DOC = {
  issuer: 'https://as.example',
  authorization_endpoint: 'https://as.example/authorize',
  token_endpoint: 'https://as.example/token',
};

type FetchInput = Parameters<typeof fetch>[0];
type Answer = number | Record<string, unknown> | Error | (() => Response);

function json(doc: Record<string, unknown>): Response {
  return new Response(JSON.stringify(doc), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function challenge(metadataUrl?: string): Response {
  return new Response('', {
    status: 401,
    headers: metadataUrl
      ? { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` }
      : { 'www-authenticate': 'Bearer' },
  });
}

/** A fetch answering per URL prefix (`POST` keys the initialize probe); anything
 *  unlisted is a 404. `calls` records every URL requested. */
function responder(routes: Record<string, Answer>): typeof fetch & { calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: FetchInput, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    const key = init?.method === 'POST' ? 'POST' : url;
    const answer = routes[key];
    if (answer === undefined) return new Response('not found', { status: 404 });
    if (answer instanceof Error) throw answer;
    if (typeof answer === 'number') return new Response('', { status: answer });
    if (typeof answer === 'function') return answer();
    return json(answer);
  }) as typeof fetch & { calls: string[] };
  impl.calls = calls;
  return impl;
}

async function discoveryCode(d: McpAuthDiscovery): Promise<string> {
  const err = await d.discover(ENDPOINT).then(
    () => null,
    (e: unknown) => e,
  );
  assert.ok(err instanceof McpAuthDiscoveryError, `expected a discovery error, got ${String(err)}`);
  return err.code;
}

describe('McpAuthDiscovery: only a real answer means "not protected"', () => {
  it('a 404 without a 401 challenge is a reliable "not protected", cached for minutes', async () => {
    const fetchImpl = responder({});
    const d = new McpAuthDiscovery({ fetchImpl });
    assert.equal(await d.discover(ENDPOINT), null);
    const after = fetchImpl.calls.length;
    assert.equal(await d.discover(ENDPOINT), null);
    assert.equal(fetchImpl.calls.length, after, 'the definite answer is served from cache');
  });

  it('a 200 that is no metadata document is an answer too', async () => {
    const fetchImpl = responder({ [WELL_KNOWN]: () => new Response('<html>', { status: 200 }) });
    assert.equal(await new McpAuthDiscovery({ fetchImpl }).discover(ENDPOINT), null);
  });

  // `redirect: 'error'` rejected like a network failure, so a host that
  // redirects every unknown path would have read as permanently unavailable.
  it('a redirect is an answer, and is not followed', async () => {
    const seen: Array<RequestInit['redirect']> = [];
    const inner = responder({
      [WELL_KNOWN]: () =>
        new Response('', { status: 301, headers: { location: 'https://www.srv.example/' } }),
    });
    const fetchImpl = ((input: FetchInput, init?: RequestInit) => {
      seen.push(init?.redirect);
      return inner(input, init);
    }) as typeof fetch;
    assert.equal(await new McpAuthDiscovery({ fetchImpl }).discover(ENDPOINT), null);
    assert.ok(seen.length > 0 && seen.every((r) => r === 'manual'));
    assert.ok(!inner.calls.some((u) => u.includes('www.srv.example')));
  });

  for (const [name, answer] of [
    ['a 503', 503],
    ['a 500', 500],
    ['a 429', 429],
    ['a network error', new TypeError('fetch failed')],
  ] as ReadonlyArray<[string, Answer]>) {
    it(`${name} at the well-known URL is unavailable, not "not protected"`, async () => {
      const fetchImpl = responder({ [WELL_KNOWN]: answer });
      assert.equal(await discoveryCode(new McpAuthDiscovery({ fetchImpl })), DISCOVERY_UNAVAILABLE);
    });
  }

  it('a timeout is unavailable, not "not protected"', async () => {
    const fetchImpl = ((_input: FetchInput, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const d = new McpAuthDiscovery({ fetchImpl, timeoutMs: 5 });
    assert.equal(await discoveryCode(d), DISCOVERY_UNAVAILABLE);
  });

  it('a clean well-known 404 does not outvote a probe that failed', async () => {
    for (const probe of [502, new TypeError('fetch failed')] as const) {
      const fetchImpl = responder({ POST: probe });
      assert.equal(await discoveryCode(new McpAuthDiscovery({ fetchImpl })), DISCOVERY_UNAVAILABLE);
    }
  });

  it('a 401 whose metadata document is unreachable is unavailable', async () => {
    const pointer = 'https://srv.example/.well-known/oauth-protected-resource/mcp';
    const fetchImpl = responder({ POST: () => challenge(pointer), [pointer]: 503 });
    assert.equal(await discoveryCode(new McpAuthDiscovery({ fetchImpl })), DISCOVERY_UNAVAILABLE);
  });

  it('a readable document behind the challenge still wins over a failed well-known read', async () => {
    const pointer = 'https://srv.example/.well-known/oauth-protected-resource/mcp';
    const fetchImpl = responder({
      [WELL_KNOWN]: 503,
      POST: () => challenge(pointer),
      [pointer]: RESOURCE_DOC,
      'https://as.example/.well-known/oauth-authorization-server': AS_DOC,
    });
    const out = await new McpAuthDiscovery({ fetchImpl }).discover(ENDPOINT);
    assert.equal(out?.server.issuer, 'https://as.example');
  });

  it('a 401 with no metadata at all is not "not protected" either', async () => {
    const fetchImpl = responder({ POST: () => challenge() });
    assert.equal(
      await discoveryCode(new McpAuthDiscovery({ fetchImpl })),
      UNADVERTISED_AUTH_CHALLENGE,
    );
  });

  it('an unreachable authorization server is unavailable, a missing one stays a defect', async () => {
    const down = responder({
      [WELL_KNOWN]: RESOURCE_DOC,
      'https://as.example/.well-known/oauth-authorization-server': 503,
    });
    assert.equal(await discoveryCode(new McpAuthDiscovery({ fetchImpl: down })), DISCOVERY_UNAVAILABLE);

    const missing = responder({ [WELL_KNOWN]: RESOURCE_DOC });
    assert.equal(await discoveryCode(new McpAuthDiscovery({ fetchImpl: missing })), 'no_auth_server_metadata');
  });

  it('remembers a failure for seconds only, then reaches the server again', async () => {
    const realNow = Date.now;
    let now = realNow();
    Date.now = () => now;
    try {
      const routes: Record<string, Answer> = { [WELL_KNOWN]: 503 };
      const fetchImpl = responder(routes);
      const d = new McpAuthDiscovery({ fetchImpl });

      assert.equal(await discoveryCode(d), DISCOVERY_UNAVAILABLE);
      const after = fetchImpl.calls.length;
      assert.equal(await discoveryCode(d), DISCOVERY_UNAVAILABLE);
      assert.equal(fetchImpl.calls.length, after, 'a status poll burst must not hammer the remote');

      routes[WELL_KNOWN] = RESOURCE_DOC;
      routes['https://as.example/.well-known/oauth-authorization-server'] = AS_DOC;
      now += 60_000;
      const out = await d.discover(ENDPOINT);
      assert.equal(out?.server.issuer, 'https://as.example', 'one minute later it has recovered');
    } finally {
      Date.now = realNow;
    }
  });
});

describe('McpOAuthService.describeAuth on discovery failures', () => {
  const service = (discover: () => Promise<unknown>): McpOAuthService =>
    new McpOAuthService({
      graph: {} as never,
      vault: {} as never,
      redirectUri: 'https://host/cb',
      discovery: { discover } as never,
    });
  const server = (headers: Record<string, string> = {}) =>
    ({ id: 's', name: 'srv', transport: 'http', endpoint: ENDPOINT, config: {}, headers }) as never;
  const failing = (code: string) => () => Promise.reject(new McpAuthDiscoveryError(code, code));

  it('reports unavailable metadata as protected, flagged as not advertised', async () => {
    const d = await service(failing(DISCOVERY_UNAVAILABLE)).describeAuth(server());
    assert.equal(d.protected, true);
    assert.equal(d.discoveryUnavailable, true);
    assert.equal(d.issuer, null);
  });

  it('keeps "not protected" for a real negative answer', async () => {
    const d = await service(() => Promise.resolve(null)).describeAuth(server());
    assert.equal(d.protected, false);
    assert.equal(d.discoveryUnavailable, undefined);
  });

  it('treats an unadvertised 401 as needing authorization', async () => {
    const d = await service(failing(UNADVERTISED_AUTH_CHALLENGE)).describeAuth(server());
    assert.equal(d.protected, true);
    assert.equal(d.discoveryUnavailable, undefined);
  });

  // The probe sends none of the row's headers, so a correctly configured
  // API-key server 401s it. Offering OAuth Connect there could never work.
  it('does not read an unadvertised 401 as OAuth on a server with its own headers', async () => {
    const d = await service(failing(UNADVERTISED_AUTH_CHALLENGE)).describeAuth(
      server({ authorization: 'Bearer {api_key}' }),
    );
    assert.equal(d.protected, false);
  });
});

describe('MCP operator routes on discovery failures', () => {
  const SERVER_ID = '44444444-4444-4444-8444-444444444443';
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  /** The operator router plus a real MCP endpoint answering every request with
   *  `upstreamStatus`, so the error reaching the route is the SDK's own. */
  async function harness(opts: {
    upstreamStatus: number;
    discover: () => Promise<unknown>;
    headers?: Record<string, string>;
  }): Promise<string> {
    const upstream: Server = createServer((_req, res) => {
      res.writeHead(opts.upstreamStatus).end();
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const row = {
      id: SERVER_ID,
      name: 'figma',
      transport: 'http',
      endpoint: `http://127.0.0.1:${String((upstream.address() as AddressInfo).port)}/mcp`,
      status: 'enabled',
      lastDiscoveredAt: null,
      discoveredTools: [],
      delegation: 'service',
      source: 'manual',
      registryId: null,
      license: null,
      author: null,
      sourceUrl: null,
      privacyBypass: false,
      kgIngest: false,
      configSchema: [],
      config: {},
      headers: opts.headers ?? {},
    };
    const graph = {
      listMcpServers: () => Promise.resolve([row]),
      getMcpOAuthToken: () => Promise.resolve(undefined),
      getMcpOAuthClient: () => Promise.resolve(undefined),
    };
    const service = new McpOAuthService({
      graph: graph as never,
      vault: {} as never,
      redirectUri: 'http://localhost/cb',
      discovery: { discover: opts.discover } as never,
    });
    const options: AgentBuilderRouterOptions = {
      getConfigStore: () => ({}) as never,
      getGraphStore: () => graph as never,
      getRegistry: () => undefined,
      mcpOAuth: {
        redirectUri: service.redirectUri,
        isProtected: (s) => service.isProtected(s),
        issuerFor: (s) => service.issuerFor(s),
        describeAuth: (s) => service.describeAuth(s),
        beginAuthorization: (s, u) => service.beginAuthorization(s, u),
        completeAuthorization: () => Promise.reject(new Error('unused')),
        setManualClient: () => Promise.reject(new Error('unused')),
        getValidAccessToken: () => Promise.resolve(null),
      },
      mcpOAuthUserKey: 'operator',
    };
    const app = express();
    app.use(express.json());
    app.use('/api/v1/operator', createAgentBuilderRouter(options));
    const api: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    close = async () => {
      await new Promise<void>((resolve) => api.close(() => resolve()));
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
    };
    return `http://127.0.0.1:${String((api.address() as AddressInfo).port)}/api/v1/operator/mcp-servers/${SERVER_ID}`;
  }

  const unavailable = () =>
    Promise.reject(new McpAuthDiscoveryError(DISCOVERY_UNAVAILABLE, 'metadata timed out'));

  it('GET auth-status does not call a server unprotected while its metadata is unreadable', async () => {
    const base = await harness({ upstreamStatus: 401, discover: unavailable });
    const res = await fetch(`${base}/auth-status`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['protected'], true);
    assert.equal(body['discoveryUnavailable'], true);
    assert.equal(body['connected'], false);
    assert.equal(body['needsClient'], false);
  });

  // The Figma incident: this used to be `502 mcp_discover_failed` carrying the
  // SDK's "Version negotiation failed: the server requires authorization (HTTP 401)".
  it('POST discover answers 409 mcp_needs_auth for a 401, with the metadata unreadable', async () => {
    const base = await harness({ upstreamStatus: 401, discover: unavailable });
    const res = await fetch(`${base}/discover`, { method: 'POST' });
    assert.equal(res.status, 409);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body['error'], 'mcp_needs_auth');
    assert.equal(body['needsAuth'], true);
    assert.equal(body['serverId'], SERVER_ID);
    assert.match(String(body['message']), /401/);
  });

  it('POST discover answers 409 for a 401 from a server with no usable metadata', async () => {
    const base = await harness({
      upstreamStatus: 401,
      discover: () =>
        Promise.reject(new McpAuthDiscoveryError(UNADVERTISED_AUTH_CHALLENGE, 'no metadata')),
    });
    const res = await fetch(`${base}/discover`, { method: 'POST' });
    assert.equal(res.status, 409);
  });

  it('POST discover stays 502 for a server that is down, not a needs-auth prompt', async () => {
    const base = await harness({ upstreamStatus: 503, discover: unavailable });
    const res = await fetch(`${base}/discover`, { method: 'POST' });
    assert.equal(res.status, 502);
    assert.equal(((await res.json()) as { error: string }).error, 'mcp_discover_failed');
  });

  it('POST discover stays 502 for a rejected static API key', async () => {
    const base = await harness({
      upstreamStatus: 401,
      headers: { authorization: 'Bearer wrong' },
      discover: () =>
        Promise.reject(new McpAuthDiscoveryError(UNADVERTISED_AUTH_CHALLENGE, 'no metadata')),
    });
    const res = await fetch(`${base}/discover`, { method: 'POST' });
    assert.equal(res.status, 502);
  });

  it('POST authorize answers 503 while the metadata is unreadable', async () => {
    const base = await harness({ upstreamStatus: 401, discover: unavailable });
    const res = await fetch(`${base}/authorize`, { method: 'POST' });
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: string }).error, 'mcp_auth_discovery_unavailable');
  });
});
