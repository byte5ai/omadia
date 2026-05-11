import { describe, it, beforeEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import {
  DiagramService,
  DiagramRenderError,
  DiagramRenderTooLargeError,
  DiagramSourceTooLargeError,
  UnsupportedDiagramKindError,
  type DiagramKind,
} from '@omadia/diagrams';

// --- Test doubles ----------------------------------------------------------

class StubStore {
  public objects = new Map<string, Buffer>();
  public headCalls = 0;
  public putCalls = 0;

  exists(key: string): Promise<boolean> {
    this.headCalls++;
    return Promise.resolve(this.objects.has(key));
  }
  put(key: string, body: Buffer): Promise<void> {
    this.putCalls++;
    this.objects.set(key, body);
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

class StubKroki {
  public calls: Array<{ kind: DiagramKind; source: string }> = [];
  constructor(private readonly pngFactory: (kind: DiagramKind) => Buffer) {}
  renderPng(kind: DiagramKind, source: string): Promise<Buffer> {
    this.calls.push({ kind, source });
    return Promise.resolve(this.pngFactory(kind));
  }
}

function makeService(overrides: {
  kroki: StubKroki;
  store: StubStore;
  maxPngBytes?: number;
  maxSourceBytes?: number;
}): DiagramService {
  return new DiagramService({
    kroki: overrides.kroki,
    store: overrides.store,
    tenantId: 'byte5',
    secret: 'x'.repeat(32),
    publicBaseUrl: 'http://localhost:3979',
    signedUrlTtlSec: 900,
    maxSourceBytes: overrides.maxSourceBytes ?? 64_000,
    maxPngBytes: overrides.maxPngBytes ?? 900_000,
  });
}

// --- Tests -----------------------------------------------------------------

describe('DiagramService', () => {
  let store: StubStore;
  let kroki: StubKroki;
  let service: DiagramService;

  beforeEach(() => {
    store = new StubStore();
    kroki = new StubKroki(() => Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    service = makeService({ kroki, store });
  });

  it('renders and stores a new diagram on first call', async () => {
    const out = await service.render({
      kind: 'mermaid',
      source: 'graph TD; A-->B',
    });
    assert.equal(out.cacheHit, false);
    assert.equal(out.kind, 'mermaid');
    assert.equal(store.putCalls, 1);
    assert.equal(kroki.calls.length, 1);
    assert.match(out.url, /^http:\/\/localhost:3979\/diagrams\//);
    assert.match(out.url, /\?exp=\d+&sig=[0-9a-f]{64}$/);
    assert.ok(out.key.startsWith('byte5/'));
    assert.ok(out.key.endsWith('.png'));
  });

  it('returns cacheHit=true and skips Kroki on repeat render', async () => {
    const input = { kind: 'mermaid' as const, source: 'graph TD; A-->B' };
    await service.render(input);
    const second = await service.render(input);
    assert.equal(second.cacheHit, true);
    assert.equal(kroki.calls.length, 1, 'kroki should only be called once');
    assert.equal(store.putCalls, 1, 'store should only be written once');
  });

  it('produces different keys for different kinds of the same source', async () => {
    const a = await service.render({ kind: 'mermaid', source: 'A' });
    const b = await service.render({ kind: 'graphviz', source: 'A' });
    assert.notEqual(a.key, b.key);
  });

  it('rejects disallowed kinds', async () => {
    await assert.rejects(
      service.render({ kind: 'excalidraw' as unknown as DiagramKind, source: 'x' }),
      UnsupportedDiagramKindError,
    );
    assert.equal(kroki.calls.length, 0);
  });

  it('rejects oversized sources', async () => {
    const big = makeService({ kroki, store, maxSourceBytes: 100 });
    await assert.rejects(
      big.render({ kind: 'mermaid', source: 'x'.repeat(200) }),
      DiagramSourceTooLargeError,
    );
    assert.equal(kroki.calls.length, 0);
  });

  it('rejects Kroki renders larger than maxPngBytes', async () => {
    const huge = new StubKroki(() => Buffer.alloc(2_000_000));
    const svc = makeService({ kroki: huge, store, maxPngBytes: 500_000 });
    await assert.rejects(
      svc.render({ kind: 'mermaid', source: 'graph TD; A-->B' }),
      DiagramRenderTooLargeError,
    );
    assert.equal(store.putCalls, 0);
  });

  it('propagates upstream DiagramRenderError with status preserved', async () => {
    const broken: StubKroki = {
      calls: [],
      renderPng: () =>
        Promise.reject(new DiagramRenderError('kroki 502', 502, 'bad gateway')),
    } as unknown as StubKroki;
    const svc = makeService({ kroki: broken, store });
    await assert.rejects(
      svc.render({ kind: 'plantuml', source: '@startuml\n@enduml' }),
      (err: unknown) =>
        err instanceof DiagramRenderError && err.status === 502,
    );
  });

  it('scopes cache keys by tenantId', async () => {
    const a = service;
    const b = new DiagramService({
      kroki,
      store,
      tenantId: 'other-tenant',
      secret: 'x'.repeat(32),
      publicBaseUrl: 'http://localhost:3979',
      signedUrlTtlSec: 900,
      maxSourceBytes: 64_000,
      maxPngBytes: 900_000,
    });
    const outA = await a.render({ kind: 'mermaid', source: 'A' });
    const outB = await b.render({ kind: 'mermaid', source: 'A' });
    assert.notEqual(outA.key, outB.key);
  });
});
