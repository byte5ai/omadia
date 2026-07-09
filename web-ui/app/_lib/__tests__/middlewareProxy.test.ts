import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMiddlewareProxy } from '../middlewareProxy';

/**
 * Regression tests for the /bot-api and /p runtime proxies.
 *
 * The bug pattern being locked down: the proxy target froze at build time
 * (rewrites in next.config.ts), so the published image ignored the runtime
 * MIDDLEWARE_URL and every browser call 500'd on any host that wasn't the
 * compose network. The core assertion here is that the handler resolves
 * MIDDLEWARE_URL **per request** — see "re-reads MIDDLEWARE_URL on every
 * request" below.
 */

type Captured = {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
};

let server: Server;
let baseUrl: string;
let captured: Captured | undefined;
let respond: (res: ServerResponse) => void;
const savedEnv = process.env.MIDDLEWARE_URL;

function ctx(path: string[]) {
  return { params: Promise.resolve({ path }) };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      captured = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      respond(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  process.env.MIDDLEWARE_URL = savedEnv;
});

afterEach(() => {
  captured = undefined;
  respond = (res) => {
    res.statusCode = 200;
    res.end('{}');
  };
});

describe('createMiddlewareProxy', () => {
  it('forwards method, mapped path, query string, and headers to ${MIDDLEWARE_URL}/api', async () => {
    process.env.MIDDLEWARE_URL = baseUrl;
    respond = (res) => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{"providers":[]}');
    };

    const proxy = createMiddlewareProxy('/api');
    const req = new NextRequest('http://web-ui.local/bot-api/v1/auth/providers?verbose=1', {
      headers: { cookie: 'session=abc', 'x-custom': 'kept' },
    });
    const res = await proxy(req, ctx(['v1', 'auth', 'providers']));

    expect(captured?.method).toBe('GET');
    expect(captured?.url).toBe('/api/v1/auth/providers?verbose=1');
    expect(captured?.headers.cookie).toBe('session=abc');
    expect(captured?.headers['x-custom']).toBe('kept');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ providers: [] });
  });

  it('re-reads MIDDLEWARE_URL on every request (the frozen-at-build regression)', async () => {
    const proxy = createMiddlewareProxy('/api');

    process.env.MIDDLEWARE_URL = baseUrl;
    await proxy(new NextRequest('http://web-ui.local/bot-api/v1/ping'), ctx(['v1', 'ping']));
    expect(captured?.url).toBe('/api/v1/ping');

    // Same handler instance, new env — the target must follow. With the old
    // build-time rewrite this was impossible: the destination was frozen.
    process.env.MIDDLEWARE_URL = `${baseUrl}/tenant-b`;
    await proxy(new NextRequest('http://web-ui.local/bot-api/v1/ping'), ctx(['v1', 'ping']));
    expect(captured?.url).toBe('/tenant-b/api/v1/ping');
  });

  it('forwards POST bodies', async () => {
    process.env.MIDDLEWARE_URL = baseUrl;
    const proxy = createMiddlewareProxy('/api');
    const req = new NextRequest('http://web-ui.local/bot-api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ user: 'admin' }),
    });
    await proxy(req, ctx(['v1', 'auth', 'login']));

    expect(captured?.method).toBe('POST');
    expect(captured?.body).toBe('{"user":"admin"}');
    expect(captured?.headers['content-type']).toBe('application/json');
  });

  it('preserves multiple Set-Cookie headers (login sets the JWT this way)', async () => {
    process.env.MIDDLEWARE_URL = baseUrl;
    respond = (res) => {
      res.statusCode = 200;
      res.setHeader('Set-Cookie', ['auth=jwt; HttpOnly', 'flags=1; Path=/']);
      res.end('{}');
    };
    const proxy = createMiddlewareProxy('/api');
    const res = await proxy(
      new NextRequest('http://web-ui.local/bot-api/v1/auth/login', { method: 'POST', body: '{}' }),
      ctx(['v1', 'auth', 'login']),
    );

    expect(res.headers.getSetCookie()).toEqual(['auth=jwt; HttpOnly', 'flags=1; Path=/']);
  });

  it('maps /p/* without the /api prefix', async () => {
    process.env.MIDDLEWARE_URL = baseUrl;
    const proxy = createMiddlewareProxy('/p');
    await proxy(
      new NextRequest('http://web-ui.local/p/my-plugin/tab'),
      ctx(['my-plugin', 'tab']),
    );
    expect(captured?.url).toBe('/p/my-plugin/tab');
  });

  it('passes upstream error statuses through untouched', async () => {
    process.env.MIDDLEWARE_URL = baseUrl;
    respond = (res) => {
      res.statusCode = 503;
      res.end('busy');
    };
    const proxy = createMiddlewareProxy('/api');
    const res = await proxy(new NextRequest('http://web-ui.local/bot-api/v1/chat'), ctx(['v1', 'chat']));
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('busy');
  });
});
