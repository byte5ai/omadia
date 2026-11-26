import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import express from 'express';
import type { TigrisStore } from '@omadia/diagrams';
import { createDiagramsRouter, signUrl } from '@omadia/diagrams';
import {
  createDocumentsRouter,
  renderXlsx,
  signDocumentUrl,
  MEDIA_TYPE,
} from '@omadia/plugin-office';
import { listenLoopback } from './_helpers/listenLoopback.js';

const SECRET = 'z'.repeat(32);
/** Real office keys are `documents/<tenant>/<sha256>/<filename>`. */
const SHA = 'a'.repeat(64);

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
  const key = `documents/dev/${SHA}/offene-posten.xlsx`;
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
    app.use('/documents/dl', createDocumentsRouter({ store, secret: SECRET }));
    server = await listenLoopback(app);
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

  // #1963: names outside ASCII used to end in a 500 (above U+00FF, Node
  // refuses the header) or in a mangled saved name (Latin-1 bytes).
  for (const filename of ['Umsatz – Q3 €.xlsx', 'Übersicht Größe.xlsx']) {
    it(`serves "${filename}" with an ASCII fallback and a UTF-8 filename*`, async () => {
      const unicodeKey = `documents/dev/${SHA}/${filename}`;
      await store.put(unicodeKey, xlsxBytes, MEDIA_TYPE.xlsx);
      const url = signDocumentUrl({ key: unicodeKey, secret: SECRET, ttlSec: 60, publicBaseUrl: baseUrl });
      const res = await fetch(url, { redirect: 'error' });
      assert.equal(res.status, 200);

      const disposition = res.headers.get('content-disposition') ?? '';
      // The header itself must be plain ASCII so every client reads it the same way.
      assert.match(disposition, /^[\x20-\x7e]+$/);
      const fallback = /; filename="([^"]*)"/.exec(disposition)?.[1];
      assert.ok(fallback !== undefined && fallback.endsWith('.xlsx'), `ASCII fallback in ${disposition}`);
      const extended = /; filename\*=UTF-8''([^;]+)/.exec(disposition)?.[1];
      assert.ok(extended !== undefined, `filename* in ${disposition}`);
      assert.equal(decodeURIComponent(extended), filename);
      const body = Buffer.from(await res.arrayBuffer());
      assert.ok(body.equals(xlsxBytes), 'served bytes match stored bytes');
    });
  }

  it('returns 403 when the signature is missing', async () => {
    const res = await fetch(`${baseUrl}/documents/dl/${encodeURIComponent(key)}?exp=9999999999`);
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
      key: `documents/dev/${'b'.repeat(64)}/missing.xlsx`,
      secret: SECRET,
      ttlSec: 60,
      publicBaseUrl: baseUrl,
    });
    const res = await fetch(url);
    assert.equal(res.status, 404);
  });
});

// #1979 (ADR-0176): Office and Diagrams can share one secret and one bucket
// (env bootstrap). A signed link must work only on the route that issued it.
describe('/documents and /diagrams links are bound to their own route', () => {
  let server: import('node:http').Server;
  let baseUrl: string;
  const store = new InMemoryStore();
  const docKey = `documents/dev/${SHA}/report.xlsx`;
  const pngKey = `dev/${SHA}.png`;

  before(async () => {
    await store.put(docKey, Buffer.from('xlsx'), MEDIA_TYPE.xlsx);
    await store.put(pngKey, Buffer.from('png'), 'image/png');
    const app = express();
    app.use('/documents/dl', createDocumentsRouter({ store, secret: SECRET }));
    app.use('/diagrams/dl', createDiagramsRouter({ store, secret: SECRET }));
    server = await listenLoopback(app);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('each link works on its own route', async () => {
    const doc = signDocumentUrl({ key: docKey, secret: SECRET, ttlSec: 60, publicBaseUrl: baseUrl });
    const png = signUrl({ key: pngKey, secret: SECRET, ttlSec: 60, publicBaseUrl: baseUrl });
    assert.equal((await fetch(doc)).status, 200);
    assert.equal((await fetch(png)).status, 200);
  });

  it('a diagram link moved to /documents/dl is refused', async () => {
    const png = signUrl({ key: pngKey, secret: SECRET, ttlSec: 60, publicBaseUrl: baseUrl });
    const swapped = png.replace('/diagrams/dl/', '/documents/dl/');
    assert.notEqual((await fetch(swapped)).status, 200);
  });

  it('an office link moved to /diagrams/dl is refused', async () => {
    const doc = signDocumentUrl({ key: docKey, secret: SECRET, ttlSec: 60, publicBaseUrl: baseUrl });
    const swapped = doc.replace('/documents/dl/', '/diagrams/dl/');
    assert.notEqual((await fetch(swapped)).status, 200);
  });

  it('a key of the right layout signed for the other route fails the signature', async () => {
    // Even a diagram-shaped key that sits on the office route's layout check
    // cannot be served with a signature minted for /diagrams/dl.
    const png = new URL(signUrl({ key: docKey, secret: SECRET, ttlSec: 60, publicBaseUrl: baseUrl }));
    const onDocs = `${baseUrl}/documents/dl/${encodeURIComponent(docKey)}${png.search}`;
    assert.equal((await fetch(onDocs)).status, 403);
  });
});
