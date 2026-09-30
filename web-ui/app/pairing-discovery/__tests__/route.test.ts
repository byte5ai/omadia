import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
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
 * Because anyone can call it, the handler must neither hang on the middleware
 * nor guess. A provider list it cannot read in time is a retryable `503`,
 * never `auth.mode: 'none'`: the pairing protocol reads `none` as "this host
 * accepts unauthenticated connects", which an outage cannot establish.
 *
 * `MIDDLEWARE_URL` is resolved when `route.ts` loads, so each case stubs the
 * env first and imports a fresh copy of the module.
 */

const LOCAL_PROVIDER = { id: 'local', displayName: 'Local', kind: 'password' };

type UpstreamCall = { url: string | undefined; cookie: string | undefined };
type Upstream = (req: IncomingMessage, res: ServerResponse) => void;

/** Answers `/api/v1/auth/providers` with `body` as JSON. */
function providersAnswer(body: unknown, status = 200): Upstream {
  return (req, res) => {
    if (req.method === 'GET' && req.url === '/api/v1/auth/providers') {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
      return;
    }
    res.statusCode = 404;
    res.end();
  };
}

/** A healthy middleware with one password provider. */
const HEALTHY: Upstream = providersAnswer({ providers: [LOCAL_PROVIDER], setup_required: false });

let server: Server;
let middlewareUrl: string;
let upstream: Upstream = HEALTHY;
let upstreamCalls: UpstreamCall[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    upstreamCalls.push({ url: req.url, cookie: req.headers.cookie });
    upstream(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  middlewareUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  // The stalled-middleware case leaves its socket open; close() alone would
  // wait for it.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

afterEach(() => {
  upstream = HEALTHY;
  upstreamCalls = [];
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
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

/** The answer when the providers cannot be determined: a retryable 503 that
 *  carries no descriptor at all, so no `auth` block a client could act on. */
async function expectAuthUnavailable(res: Response): Promise<void> {
  expect(res.status).toBe(503);
  expect(res.headers.get('content-type')).toContain('application/json');
  expect(res.headers.get('retry-after')).toBe('5');
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(await res.json()).toEqual({
    code: 'pairing.auth_unavailable',
    message: expect.any(String),
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

  it('marks the descriptor no-store, because it echoes the caller host', async () => {
    // `force-dynamic` only switches off Next's own caching. Without this
    // header a shared cache in front could replay one caller's reflected
    // `loginStartUrl` to the next caller.
    const GET = await loadHandler({ MIDDLEWARE_URL: middlewareUrl });

    const res = await GET(discoveryRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('reports auth.mode none only when the middleware lists no providers', async () => {
    // A determined answer, not a guess: the same reading the middleware's own
    // `buildPairingDescriptor` gives an empty provider list.
    upstream = providersAnswer({ providers: [], setup_required: false });
    const GET = await loadHandler({
      MIDDLEWARE_URL: middlewareUrl,
      OMADIA_UI_PUBLIC_WS_URL: 'wss://canvas.example.com/omadia-ui/canvas',
      OMADIA_UI_INSTANCE_NAME: 'Synthetic Ops',
    });

    const res = await GET(discoveryRequest());

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      name: 'Synthetic Ops',
      protocolVersion: '1.0',
      protocolVersions: ['1.0'],
      wsUrl: 'wss://canvas.example.com/omadia-ui/canvas',
      auth: { mode: 'none' },
    });
  });
});

describe('GET /pairing-discovery — providers cannot be determined', () => {
  it('answers 503, not auth.mode none, when the middleware is unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const GET = await loadHandler({ MIDDLEWARE_URL: await closedPortUrl() });

    await expectAuthUnavailable(await GET(discoveryRequest()));
    // The operator learns why pairing fails; the client only learns to retry.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    // What a middleware without Postgres answers on every `/api/v1/auth/*`.
    [
      'an error status',
      providersAnswer({ code: 'auth.not_configured', message: 'no graph pool' }, 503),
    ],
    ['a body without a provider list', providersAnswer({ setup_required: false })],
    ['a body that is not JSON', ((_req, res) => res.end('<html>maintenance</html>')) as Upstream],
  ])('answers 503, not auth.mode none, when the middleware sends %s', async (_label, answer) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    upstream = answer;
    const GET = await loadHandler({ MIDDLEWARE_URL: middlewareUrl });

    await expectAuthUnavailable(await GET(discoveryRequest()));
    expect(upstreamCalls).toHaveLength(1);
  });

  it('stops waiting for a middleware that accepts the connection and never answers', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Stand-in for the deadline. The real one is seconds long; this one fires
    // the moment the stalled middleware holds the request. That proves the
    // signal the handler asked `AbortSignal.timeout` for is the one wired
    // into the fetch, without waiting out the budget or racing a short timer.
    // Without a deadline on the fetch, this case hangs until the test timeout.
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    upstream = () => {
      deadline.abort(new DOMException('synthetic deadline', 'TimeoutError'));
      // ...and never answer.
    };
    const GET = await loadHandler({ MIDDLEWARE_URL: middlewareUrl });

    await expectAuthUnavailable(await GET(discoveryRequest()));
    expect(upstreamCalls).toHaveLength(1);
    // The budget the handler asked for: a few seconds, far above a healthy
    // call on the private network and far below undici's own minutes.
    expect(timeout).toHaveBeenCalledTimes(1);
    const [budgetMs] = timeout.mock.calls[0] ?? [];
    expect(budgetMs).toBeGreaterThanOrEqual(1_000);
    expect(budgetMs).toBeLessThanOrEqual(10_000);
  });
});
