import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import { DiagramService, type DiagramKind } from '@omadia/diagrams';

// --- Minimal stubs -------------------------------------------------------

class StubStore {
  readonly objects = new Map<string, Buffer>();
  exists(key: string): Promise<boolean> {
    return Promise.resolve(this.objects.has(key));
  }
  put(): Promise<void> {
    return Promise.resolve();
  }
  getStream(key: string): Promise<{
    stream: Readable;
    contentType: string | undefined;
    contentLength: number | undefined;
  }> {
    const obj = this.objects.get(key);
    if (!obj) return Promise.reject(new Error(`NoSuchKey: ${key}`));
    return Promise.resolve({
      stream: Readable.from(obj),
      contentType: 'image/png',
      contentLength: obj.byteLength,
    });
  }
}

class CapturingKroki {
  lastSource?: string;
  renderPng(_kind: DiagramKind, source: string): Promise<Buffer> {
    this.lastSource = source;
    return Promise.resolve(Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic
  }
}

function make(): { service: DiagramService; store: StubStore; kroki: CapturingKroki } {
  const store = new StubStore();
  const kroki = new CapturingKroki();
  const service = new DiagramService({
    kroki,
    store,
    tenantId: 'byte5',
    secret: 'x'.repeat(32),
    publicBaseUrl: 'http://localhost:3979',
    signedUrlTtlSec: 900,
    maxSourceBytes: 1_000_000,
    maxPngBytes: 900_000,
  });
  return { service, store, kroki };
}

const LOGO_BYTES = Buffer.from([
  // Tiny 1×1 PNG (8 header + minimal IHDR)
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

// --- Tests ---------------------------------------------------------------

describe('diagram/brand-logo substitution', () => {
  it('substitutes brand://logo with a data URL when key is supplied', async () => {
    const { service, store, kroki } = make();
    store.objects.set('teams-attachments/byte5/conv/2026-logo.png', LOGO_BYTES);
    const spec = JSON.stringify({
      mark: 'image',
      encoding: { url: { value: 'brand://logo' } },
    });
    await service.render({
      kind: 'vegalite',
      source: spec,
      brandLogoStorageKey: 'teams-attachments/byte5/conv/2026-logo.png',
    });
    assert.ok(kroki.lastSource);
    assert.ok(
      !kroki.lastSource!.includes('brand://logo'),
      'placeholder should be removed from the Kroki-bound source',
    );
    assert.ok(
      kroki.lastSource!.includes('data:image/png;base64,'),
      'expected base64 data URL inline in spec',
    );
  });

  it('leaves brand://logo untouched when no key is supplied', async () => {
    const { service, kroki } = make();
    const spec = JSON.stringify({
      mark: 'image',
      encoding: { url: { value: 'brand://logo' } },
    });
    await service.render({
      kind: 'vegalite',
      source: spec,
    });
    assert.ok(kroki.lastSource);
    assert.ok(kroki.lastSource!.includes('brand://logo'));
    assert.ok(!kroki.lastSource!.includes('data:image'));
  });

  it('rejects keys outside the allowed prefix', async () => {
    const { service, store } = make();
    store.objects.set('diagrams/byte5/some-other-key.png', LOGO_BYTES);
    const spec = JSON.stringify({
      mark: 'image',
      encoding: { url: { value: 'brand://logo' } },
    });
    await assert.rejects(
      service.render({
        kind: 'vegalite',
        source: spec,
        brandLogoStorageKey: 'diagrams/byte5/some-other-key.png',
      }),
      /disallowed prefix/,
    );
  });

  it('does not invoke Tigris when the placeholder is absent', async () => {
    const { service, store } = make();
    let getCalls = 0;
    const originalGet = store.getStream.bind(store);
    store.getStream = (key: string) => {
      getCalls += 1;
      return originalGet(key);
    };
    await service.render({
      kind: 'vegalite',
      source: '{"mark":"bar"}',
      brandLogoStorageKey: 'teams-attachments/byte5/conv/x.png',
    });
    assert.equal(getCalls, 0);
  });

  it('respects the source-size cap AFTER substitution', async () => {
    const { service, store } = make();
    // 800 kB of bytes — base64 ~ 1.07 MB → over the 1 MB cap.
    const big = Buffer.alloc(800_000, 0xab);
    store.objects.set('teams-attachments/byte5/huge.png', big);
    const spec = JSON.stringify({
      mark: 'image',
      encoding: { url: { value: 'brand://logo' } },
    });
    await assert.rejects(
      service.render({
        kind: 'vegalite',
        source: spec,
        brandLogoStorageKey: 'teams-attachments/byte5/huge.png',
      }),
      /bytes.*limit/,
    );
  });

  it('cache key differs when the logo bytes differ (re-renders on logo change)', async () => {
    const { service, store, kroki } = make();
    store.objects.set('teams-attachments/byte5/a.png', Buffer.from('A'));
    store.objects.set('teams-attachments/byte5/b.png', Buffer.from('BBBBBBBB'));
    const spec = JSON.stringify({
      mark: 'image',
      encoding: { url: { value: 'brand://logo' } },
    });
    const r1 = await service.render({
      kind: 'vegalite',
      source: spec,
      brandLogoStorageKey: 'teams-attachments/byte5/a.png',
    });
    const r2 = await service.render({
      kind: 'vegalite',
      source: spec,
      brandLogoStorageKey: 'teams-attachments/byte5/b.png',
    });
    assert.notEqual(r1.key, r2.key, 'cache key must depend on inlined bytes');
    // Kroki called twice (no cache-hit across different logos).
    assert.ok(kroki.lastSource);
  });
});
