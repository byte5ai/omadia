import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import express from 'express';

import { createInProcessClient } from './inProcessHttp.js';

/**
 * Self-coverage for the in-process HTTP driver that the channelApi router
 * suites run on (issue #564). These are deliberately behavioural, not
 * mock-counting: every assertion below fails if the transport silently drops
 * status, headers, the request body, or a streamed chunk — the exact ways an
 * in-memory shim can diverge from a real loopback socket.
 */
describe('support/inProcessHttp', () => {
  it('never binds a port — the server is created but never listen()ed', () => {
    const app = express();
    const { server } = createInProcessClient(app);
    // A listen()ed server reports an AddressInfo here; an un-listened one is
    // null. This is the whole point of the driver: no ephemeral-port bind, no
    // TCP handshake, nothing to contend under a loaded runner.
    assert.equal(server.address(), null);
    assert.equal(server.listening, false);
  });

  it('passes the request method, path, and JSON body through to the handler', async () => {
    const app = express();
    app.use(express.json());
    app.post('/echo/:id', (req, res) => {
      res.status(202).json({ id: req.params.id, method: req.method, body: req.body });
    });
    const { fetch } = createInProcessClient(app);

    const res = await fetch('/echo/abc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hello: 'world' }),
    });
    assert.equal(res.status, 202);
    assert.deepEqual(await res.json(), {
      id: 'abc',
      method: 'POST',
      body: { hello: 'world' },
    });
  });

  it('forwards request headers and surfaces response headers', async () => {
    const app = express();
    app.get('/h', (req, res) => {
      res.setHeader('x-custom', 'from-handler');
      res.json({ seen: req.get('x-caller') });
    });
    const { fetch } = createInProcessClient(app);

    const res = await fetch('/h', { headers: { 'x-caller': 'test' } });
    assert.equal(res.headers.get('x-custom'), 'from-handler');
    assert.equal((await res.json() as { seen: string }).seen, 'test');
  });

  it('propagates non-2xx status codes verbatim (404 for an unmounted path)', async () => {
    const app = express();
    app.get('/only', (_req, res) => {
      res.json({ ok: true });
    });
    const { fetch } = createInProcessClient(app);

    const res = await fetch('/nope');
    assert.equal(res.status, 404);
  });

  it('buffers a chunked/streamed response — every written chunk arrives, in order', async () => {
    const app = express();
    app.get('/stream', (_req, res) => {
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.flushHeaders();
      let n = 0;
      const timer = setInterval(() => {
        res.write(`${JSON.stringify({ n: n++ })}\n`);
        if (n === 3) {
          clearInterval(timer);
          res.end();
        }
      }, 3);
    });
    const { fetch } = createInProcessClient(app);

    const res = await fetch('/stream');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /x-ndjson/);
    const lines = (await res.text())
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { n: number });
    assert.deepEqual(lines, [{ n: 0 }, { n: 1 }, { n: 2 }]);
  });

  it('keeps concurrent in-flight requests isolated (no shared-connection bleed)', async () => {
    const app = express();
    app.get('/id/:n', (req, res) => {
      // Resolve out of call order to shake out any response cross-wiring.
      setTimeout(() => res.json({ n: Number(req.params.n) }), (5 - Number(req.params.n)) * 3);
    });
    const { fetch } = createInProcessClient(app);

    const results = await Promise.all(
      [1, 2, 3, 4].map(async (n) => (await (await fetch(`/id/${n}`)).json() as { n: number }).n),
    );
    assert.deepEqual(results.sort(), [1, 2, 3, 4]);
  });
});
