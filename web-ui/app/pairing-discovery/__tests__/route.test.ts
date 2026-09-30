import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * The pairing-discovery handler (`/.well-known/omadia-ui`, rewritten to
 * `/pairing-discovery`) answers a client that has no session yet.
 *
 * A desktop client fetches this descriptor BEFORE it signs in (the descriptor
 * is what tells it where to sign in), so the handler builds it from the
 * request alone: no cookie in, none out, and none sent upstream. The provider
 * list it embeds comes from the middleware's public `/api/v1/auth/providers`.
 * `app/__tests__/proxy.test.ts` pins that the login gate lets the request
 * through; these cases pin what the handler then returns.
 *
 * `MIDDLEWARE_URL` is resolved when `route.ts` loads, so each case stubs the
 * env first and imports a fresh copy of the module.
 */

const LOCAL_PROVIDER = { id: 'local', displayName: 'Local', kind: 'password' };

type UpstreamCall = { url: string | undefined; cookie: string | undefined };

let server: Server;
let middlewareUrl: string;
let upstreamCalls: UpstreamCall[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    upstreamCalls.push({ url: req.url, cookie: req.headers.cookie });
    if (req.method === 'GET' && req.url === '/api/v1/auth/providers') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ providers: [LOCAL_PROVIDER], setup_required: false }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  middlewareUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  upstreamCalls = [];
  vi.unstubAllEnvs();
});

/** A loopback URL nothing listens on: bind an ephemeral port, then free it. */
async function closedPortUrl(): Promise<string> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return `http://127.0.0.1:${port}`;
}

async function loadHandler(env: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.resetModules();
  return (await import('../route')).GET;
}

/** What reaches the handler behind the Fly edge: the internal listener in
 *  `host`, the public origin in the forwarded headers, and no cookie. */
function discoveryRequest(): Request {
  return new Request('http://internal:3300/pairing-discovery', {
    headers: {
      host: 'internal:3300',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': 'ops.example.com',
    },
  });
}

describe('GET /pairing-discovery', () => {
  it('returns the JSON descriptor without any cookie', async () => {
    const GET = await loadHandler({
      MIDDLEWARE_URL: middlewareUrl,
      OMADIA_UI_PUBLIC_WS_URL: undefined,
      OMADIA_UI_INSTANCE_NAME: undefined,
    });
    const req = discoveryRequest();
    expect(req.headers.get('cookie')).toBeNull();

    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(await res.json()).toEqual({
      name: 'ops.example.com',
      protocolVersion: '1.0',
      protocolVersions: ['1.0'],
      wsUrl: 'wss://ops.example.com/omadia-ui/canvas',
      auth: {
        mode: 'password',
        providers: [LOCAL_PROVIDER],
        loginStartUrl: 'https://ops.example.com/bot-api/v1/auth',
      },
    });
    // One server-to-server read of the public provider list, and no session
    // material travels upstream.
    expect(upstreamCalls).toEqual([{ url: '/api/v1/auth/providers', cookie: undefined }]);
  });

  it('degrades to auth.mode none when the middleware is unreachable', async () => {
    const GET = await loadHandler({
      MIDDLEWARE_URL: await closedPortUrl(),
      OMADIA_UI_PUBLIC_WS_URL: 'wss://canvas.example.com/omadia-ui/canvas',
      OMADIA_UI_INSTANCE_NAME: 'Synthetic Ops',
    });

    const res = await GET(discoveryRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({
      name: 'Synthetic Ops',
      protocolVersion: '1.0',
      protocolVersions: ['1.0'],
      wsUrl: 'wss://canvas.example.com/omadia-ui/canvas',
      auth: { mode: 'none' },
    });
  });
});
