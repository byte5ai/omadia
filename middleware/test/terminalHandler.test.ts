import { strict as assert } from 'node:assert';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import express from 'express';
import type { Request, Response } from 'express';

import { createAppServer, createTerminalHandler } from '../src/http/terminalHandler.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

/**
 * #1326 / #1318 / #1349 — whatever no router answers gets a JSON
 * `{ code, message }` and never a stack, whatever NODE_ENV says. Express's own
 * `finalhandler` renders the stack into an HTML page outside production, and
 * the Compose stack runs with NODE_ENV=development, so the suite forces that
 * mode for its whole run.
 */
describe('terminal handler (JSON errors and 404s)', () => {
  let server: Server;
  let baseUrl: string;
  const warnings: string[] = [];
  const errors: string[] = [];
  const savedNodeEnv = process.env.NODE_ENV;

  before(async () => {
    process.env.NODE_ENV = 'development';
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    app.post('/api/public/v1/chat', (_req: Request, res: Response) => {
      res.status(401).json({ code: 'unauthorized', message: 'no key' });
    });
    app.get('/api/boom', () => {
      throw new Error('secret detail /app/dist/routes/x.js:1:1');
    });
    app.get('/api/denied', () => {
      throw Object.assign(new Error('nope'), { status: 403 });
    });
    app.get('/api/half', (_req: Request, res: Response, next) => {
      res.write('partial');
      next(new Error('late failure'));
    });
    const terminal = createTerminalHandler({
      ungrantedPublicPrefix: (path) =>
        path === '/documents/dl' || path.startsWith('/documents/dl/') ? '/documents/dl' : null,
      warn: (message) => warnings.push(message),
      error: (message) => errors.push(message),
    });
    server = await listenLoopback(createAppServer(app, terminal));
    // A route mounted after the server is up — the way plugins live-mount —
    // must still win over the terminal 404.
    app.get('/api/late', (_req: Request, res: Response) => {
      res.json({ ok: true });
    });
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    process.env.NODE_ENV = savedNodeEnv;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function expectJson(
    res: globalThis.Response,
    status: number,
    code: string,
  ): Promise<string> {
    assert.equal(res.status, status);
    assert.match(res.headers.get('content-type') ?? '', /^application\/json/);
    const text = await res.text();
    assert.doesNotMatch(text, /<html|<pre|\bat \S+ \(|node_modules|\/app\//i);
    assert.equal((JSON.parse(text) as { code: string }).code, code);
    return text;
  }

  it('answers malformed JSON with 400 request.invalid_json, before any route runs', async () => {
    const res = await fetch(`${baseUrl}/api/public/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"message":',
    });
    await expectJson(res, 400, 'request.invalid_json');
    assert.ok(warnings.some((w) => w.includes('request.invalid_json')));
  });

  it('answers an oversized body with 413 request.payload_too_large', async () => {
    const res = await fetch(`${baseUrl}/api/public/v1/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'a'.repeat(4096) }),
    });
    await expectJson(res, 413, 'request.payload_too_large');
  });

  it('answers an unhandled route error with 500 internal and keeps the detail server-side', async () => {
    const res = await fetch(`${baseUrl}/api/boom`);
    const text = await expectJson(res, 500, 'internal');
    assert.doesNotMatch(text, /secret detail/);
    assert.ok(errors.some((e) => e.includes('/api/boom')));
  });

  it('keeps the status of a thrown 4xx error and names it by status', async () => {
    const text = await expectJson(await fetch(`${baseUrl}/api/denied`), 403, 'forbidden');
    assert.doesNotMatch(text, /nope/);
  });

  it('answers an unknown /api path with a JSON 404', async () => {
    const res = await fetch(`${baseUrl}/api/v1/nope?x=1`);
    const text = await expectJson(res, 404, 'not_found');
    assert.match(text, /Cannot GET \/api\/v1\/nope"/);
  });

  it('answers an unknown path outside /api with a JSON 404 too', async () => {
    await expectJson(await fetch(`${baseUrl}/nowhere`), 404, 'not_found');
  });

  it('names a declared-but-ungranted public prefix instead of a bare 404 (#1349)', async () => {
    const res = await fetch(`${baseUrl}/documents/dl/anything`);
    const text = await expectJson(res, 404, 'public_path.not_granted');
    assert.match(text, /\/documents\/dl/);
  });

  it('lets a route mounted after boot answer, instead of the terminal 404', async () => {
    const res = await fetch(`${baseUrl}/api/late`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it('drops the connection when a route fails after sending headers', async () => {
    await assert.rejects(async () => {
      const res = await fetch(`${baseUrl}/api/half`);
      await res.text();
    });
    assert.ok(errors.some((e) => e.includes('/api/half')));
  });
});
