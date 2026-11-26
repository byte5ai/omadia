import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

import {
  createAttachmentByteReader,
  loopbackOriginFor,
} from '../src/channels/attachmentByteReader.js';
import { createCoreApi } from '../src/channels/coreApi.js';
import { listenLoopback } from './_helpers/listenLoopback.js';

/**
 * #1993 / ADR-0222 — channels read an outgoing attachment's bytes in-process:
 * loopback GET, only under a granted public prefix, no redirects, capped.
 */
describe('attachmentByteReader', () => {
  let server: Server;
  let origin: string;
  const seenHeaders: Array<Record<string, unknown>> = [];

  before(async () => {
    const app = express();
    app.get('/diagrams/dl/:key', (req, res) => {
      seenHeaders.push({ ...req.headers });
      if (req.query['sig'] !== 'ok') {
        res.status(403).end();
        return;
      }
      res.setHeader('content-type', 'image/png');
      res.setHeader('content-disposition', `attachment; filename="../${req.params.key}.png"`);
      res.end(Buffer.from([1, 2, 3, 4]));
    });
    app.get('/documents/dl/big', (_req, res) => {
      res.setHeader('content-type', 'application/octet-stream');
      res.end(Buffer.alloc(64));
    });
    app.get('/documents/dl/hop', (_req, res) => {
      res.redirect('/admin/secret');
    });
    app.get('/admin/secret', (_req, res) => {
      res.end('secret');
    });
    server = await listenLoopback(app);
    origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const granted = (path: string): unknown =>
    path.startsWith('/diagrams/dl/') || path.startsWith('/documents/dl/') ? { prefix: 'x' } : null;
  const reader = (maxBytes?: number) =>
    createAttachmentByteReader({
      resolveGrantedPath: granted,
      loopbackOrigin: origin,
      log: () => {},
      ...(maxBytes !== undefined ? { maxBytes } : {}),
    });

  it('reads a granted attachment through loopback, whatever the URL origin says', async () => {
    const res = await reader()('http://localhost:3979/diagrams/dl/chart?sig=ok');
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.deepEqual([...res.bytes], [1, 2, 3, 4]);
    assert.equal(res.mediaType, 'image/png');
    assert.equal(res.fileName, 'chart.png');
    assert.equal(seenHeaders.at(-1)?.['cookie'], undefined);
  });

  it('refuses a path that is not a granted public prefix', async () => {
    const res = await reader()(`${origin}/admin/secret`);
    assert.deepEqual(res, { ok: false, reason: 'not_kernel_attachment' });
  });

  it('maps a refused signature to not_found', async () => {
    const res = await reader()(`${origin}/diagrams/dl/chart?sig=bad`);
    assert.deepEqual(res, { ok: false, reason: 'not_found' });
  });

  it('does not follow a redirect out of the granted prefix', async () => {
    const res = await reader()(`${origin}/documents/dl/hop`);
    assert.deepEqual(res, { ok: false, reason: 'failed' });
  });

  it('caps the size', async () => {
    const res = await reader(16)(`${origin}/documents/dl/big`);
    assert.deepEqual(res, { ok: false, reason: 'too_large' });
  });

  it('a non-http URL is not a kernel attachment', async () => {
    assert.deepEqual(await reader()('file:///etc/passwd'), { ok: false, reason: 'not_kernel_attachment' });
  });

  it('loopbackOriginFor maps wildcard binds to 127.0.0.1', () => {
    assert.equal(loopbackOriginFor('::', 3979), 'http://127.0.0.1:3979');
    assert.equal(loopbackOriginFor('0.0.0.0', 80), 'http://127.0.0.1:80');
    assert.equal(loopbackOriginFor('::1', 1), 'http://[::1]:1');
  });

  it('CoreApi exposes readAttachment only when wired, and never throws', async () => {
    const base = { dispatcher: {} as never, routes: {} as never };
    assert.equal(createCoreApi(base).readAttachment, undefined);
    const api = createCoreApi({
      ...base,
      readAttachment: () => Promise.reject(new Error('boom')),
    });
    assert.deepEqual(await api.readAttachment?.('x'), { ok: false, reason: 'failed' });
  });
});
