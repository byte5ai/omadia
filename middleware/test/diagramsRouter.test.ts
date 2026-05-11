import { describe, it, before, after } from 'node:test';
import { strict as assert } from 'node:assert';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import express from 'express';
import {
  createDiagramsRouter,
  signUrl,
  type TigrisStore,
} from '@omadia/diagrams';

const SECRET = 'z'.repeat(32);

class InMemoryStore implements TigrisStore {
  private objects = new Map<string, Buffer>();

  seed(key: string, body: Buffer): void {
    this.objects.set(key, body);
  }

  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }
  put(key: string, body: Buffer): Promise<void> {
    this.objects.set(key, body);
    return Promise.resolve();
  }
  getStream(
    key: string,
  ): Promise<{
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
      stream: Readable.from(obj),
      contentType: 'image/png',
      contentLength: obj.byteLength,
    });
  }
}

describe('/diagrams router', () => {
  let server: import('node:http').Server;
  let baseUrl: string;
  const store = new InMemoryStore();
  const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fakePng = Buffer.concat([PNG_MAGIC, Buffer.from('fake-body')]);

  before(() => {
    store.seed('byte5/abc.png', fakePng);
    const app = express();
    app.use('/diagrams', createDiagramsRouter({ store, secret: SECRET }));
    server = app.listen(0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${String(addr.port)}`;
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  });

  it('serves the PNG bytes for a valid signed URL', async () => {
    const url = signUrl({
      key: 'byte5/abc.png',
      secret: SECRET,
      ttlSec: 60,
      publicBaseUrl: baseUrl,
    });
    const res = await fetch(url, { redirect: 'error' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const body = Buffer.from(await res.arrayBuffer());
    assert.deepEqual(body, fakePng);
  });

  it('returns 403 when the signature is missing', async () => {
    const res = await fetch(`${baseUrl}/diagrams/${encodeURIComponent('byte5/abc.png')}?exp=9999999999`);
    assert.equal(res.status, 403);
  });

  it('returns 403 when the signature is tampered', async () => {
    const url = signUrl({
      key: 'byte5/abc.png',
      secret: SECRET,
      ttlSec: 60,
      publicBaseUrl: baseUrl,
    });
    const u = new URL(url);
    const sig = u.searchParams.get('sig') ?? '';
    const badSig = sig.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    u.searchParams.set('sig', badSig);
    const res = await fetch(u.toString());
    assert.equal(res.status, 403);
  });

  it('returns 403 when the signature is expired', async () => {
    const url = signUrl({
      key: 'byte5/abc.png',
      secret: SECRET,
      ttlSec: -10, // expired by default
      publicBaseUrl: baseUrl,
    });
    const res = await fetch(url);
    assert.equal(res.status, 403);
  });

  it('returns 404 for a key that is not stored', async () => {
    const url = signUrl({
      key: 'byte5/does-not-exist.png',
      secret: SECRET,
      ttlSec: 60,
      publicBaseUrl: baseUrl,
    });
    const res = await fetch(url);
    assert.equal(res.status, 404);
  });

  it('never emits a redirect (Teams does not follow them)', async () => {
    const url = signUrl({
      key: 'byte5/abc.png',
      secret: SECRET,
      ttlSec: 60,
      publicBaseUrl: baseUrl,
    });
    const res = await fetch(url, { redirect: 'manual' });
    // The fetch API distinguishes "redirect" responses via type=opaqueredirect
    // when redirect:manual and the server responded with 3xx. We want 200.
    assert.equal(res.status, 200);
    assert.notEqual(res.type, 'opaqueredirect');
  });
});
