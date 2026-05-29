import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import express from 'express';
import type { TigrisStore } from '@omadia/diagrams';
import {
  createDocumentsRouter,
  renderXlsx,
  signDocumentUrl,
  MEDIA_TYPE,
} from '@omadia/plugin-office';

const SECRET = 'z'.repeat(32);

/** Minimal TigrisStore that records the content-type passed to put(), so the
 *  router round-trips the real xlsx media type back on GET. */
class InMemoryStore implements TigrisStore {
  private objects = new Map<string, { body: Buffer; contentType?: string }>();

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }
  put(key: string, body: Buffer, contentType?: string): Promise<void> {
    this.objects.set(key, { body, ...(contentType ? { contentType } : {}) });
    return Promise.resolve();
  }
  getStream(key: string): Promise<{
    stream: Readable;
    contentType: string | undefined;
    contentLength: number | undefined;
  }> {
    const obj = this.objects.get(key);
    if (!obj) {
      const err = new Error('NoSuchKey') as Error & { name: string };
      err.name = 'NoSuchKey';
      return Promise.reject(err);
    }
    return Promise.resolve({
      stream: Readable.from(obj.body),
      contentType: obj.contentType,
      contentLength: obj.body.byteLength,
    });
  }
}

describe('/documents router (office delivery path)', () => {
  let server: import('node:http').Server;
  let baseUrl: string;
  const store = new InMemoryStore();
  const key = 'documents/dev/abc/offene-posten.xlsx';
  let xlsxBytes: Buffer;

  before(async () => {
    const rendered = await renderXlsx({
      sheets: [
        {
          name: 'Test',
          columns: [{ key: 'a', header: 'A', type: 'currency' }],
          rows: [{ a: 1 }, { a: 2 }],
        },
      ],
    });
    xlsxBytes = rendered.buffer;
    await store.put(key, xlsxBytes, MEDIA_TYPE.xlsx);

    const app = express();
    app.use('/documents', createDocumentsRouter({ store, secret: SECRET }));
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serves the xlsx bytes as a download for a valid signed URL', async () => {
    const url = signDocumentUrl({ key, secret: SECRET, ttlSec: 60, publicBaseUrl: baseUrl });
    const res = await fetch(url, { redirect: 'error' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), MEDIA_TYPE.xlsx);
    // Download disposition with the friendly filename (last key segment).
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="offene-posten\.xlsx"/);
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(xlsxBytes), 'served bytes match stored bytes');
  });

  it('returns 403 when the signature is missing', async () => {
    const res = await fetch(`${baseUrl}/documents/${encodeURIComponent(key)}?exp=9999999999`);
    assert.equal(res.status, 403);
  });

  it('returns 403 when the signature is tampered', async () => {
    const url = signDocumentUrl({ key, secret: SECRET, ttlSec: 60, publicBaseUrl: baseUrl });
    const u = new URL(url);
    const sig = u.searchParams.get('sig') ?? '';
    u.searchParams.set('sig', sig.replace(/^./, (c) => (c === '0' ? '1' : '0')));
    const res = await fetch(u.toString());
    assert.equal(res.status, 403);
  });

  it('returns 403 when the signature is expired', async () => {
    const url = signDocumentUrl({ key, secret: SECRET, ttlSec: -10, publicBaseUrl: baseUrl });
    const res = await fetch(url);
    assert.equal(res.status, 403);
  });

  it('returns 404 for a key that is not stored', async () => {
    const url = signDocumentUrl({
      key: 'documents/dev/zzz/missing.xlsx',
      secret: SECRET,
      ttlSec: 60,
      publicBaseUrl: baseUrl,
    });
    const res = await fetch(url);
    assert.equal(res.status, 404);
  });
});
