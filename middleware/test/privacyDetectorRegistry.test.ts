import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  PRIVACY_DETECTOR_CAPABILITY,
  PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME,
  type PrivacyDetector,
  type PrivacyDetectorHit,
  type PrivacyDetectorRegistry,
} from '@omadia/plugin-api';

import {
  createPrivacyGuardService,
  createRegexDetector,
  REGEX_DETECTOR_ID,
} from '@omadia/plugin-privacy-guard/dist/index.js';

// ---------------------------------------------------------------------------
// Slice 3.1 — Detector-Plugin-API.
//
// Pins three contracts:
//   1. The capability + service-name constants are exported and stable.
//   2. The privacy-guard service multiplexes detectors: parallel run +
//      span-overlap dedup (highest confidence wins; ties broken by
//      shorter / more-specific span).
//   3. Detector failure is fail-open per detector — a thrown error inside
//      one detector returns zero hits without nuking the rest of the
//      outbound pass.
// ---------------------------------------------------------------------------

const SAMPLE_EMAIL = 'max@firma.de';

function staticDetector(
  id: string,
  hits: readonly PrivacyDetectorHit[],
): PrivacyDetector {
  return {
    id,
    async detect() {
      return { hits, status: 'ok' as const };
    },
  };
}

function makeHit(
  type: string,
  value: string,
  span: readonly [number, number],
  confidence: number,
  detector: string,
): PrivacyDetectorHit {
  return { type, value, span, confidence, detector };
}

describe('plugin-api · privacy.detector@1 capability constants', () => {
  it('exports the canonical service name and capability id', () => {
    assert.equal(PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME, 'privacyDetectorRegistry');
    assert.equal(PRIVACY_DETECTOR_CAPABILITY, 'privacy.detector@1');
  });
});

describe('PrivacyGuardService · default detector seed (Slice 3.1)', () => {
  it('bundles the regex detector when no detectors are passed', () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const ids = service.listDetectors().map((d) => d.id);
    assert.deepEqual(ids, [REGEX_DETECTOR_ID]);
  });

  it('replaces the default seed when an explicit detector list is supplied', () => {
    const noop = staticDetector('test:noop', []);
    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [noop],
    });
    const ids = service.listDetectors().map((d) => d.id);
    assert.deepEqual(ids, ['test:noop']);
  });

  it('preserves Slice-2.1 regex behaviour when only the default seed runs', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    const out = await service.processOutbound({
      sessionId: 'seed',
      turnId: 't1',
      systemPrompt: '',
      messages: [{ role: 'user', content: `Mail ${SAMPLE_EMAIL} bitte.` }],
    });
    const text = out.messages[0]?.content ?? '';
    assert.ok(!text.includes(SAMPLE_EMAIL), 'regex default must still tokenise email');
    assert.ok(/\btok_[0-9a-f]{8}_[a-z0-9_]+\b/.test(text));
  });
});

describe('PrivacyGuardService · multi-detector parallel + dedup (Slice 3.1)', () => {
  it('runs all detectors in parallel and unions their hits', async () => {
    const text = 'Marcel called at +49 30 12345678 today.';
    const nameHit = makeHit('pii.name', 'Marcel', [0, 6], 0.85, 'fake-ner:0.0.1');
    const phoneHit = makeHit(
      'pii.phone',
      '+49 30 12345678',
      [text.indexOf('+49'), text.indexOf('+49') + '+49 30 12345678'.length],
      0.92,
      'regex:0.1.0',
    );
    const ner = staticDetector('fake-ner:0.0.1', [nameHit]);
    const fakeRegex = staticDetector('regex:0.1.0', [phoneHit]);

    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [ner, fakeRegex],
    });

    await service.processOutbound({
      sessionId: 's',
      turnId: 'parallel',
      systemPrompt: '',
      messages: [{ role: 'user', content: text }],
    });
    const receipt = await service.finalizeTurn('parallel');
    if (!receipt) throw new Error('expected receipt');

    const types = receipt.detections.map((d) => d.type).sort();
    assert.deepEqual(types, ['pii.name', 'pii.phone'], 'both detectors contribute');
    const detectors = receipt.detections.map((d) => d.detector).sort();
    assert.deepEqual(detectors, ['fake-ner:0.0.1', 'regex:0.1.0']);
  });

  it('span-overlap: highest confidence wins, lower-confidence overlap is dropped', async () => {
    // Two detectors flag the same substring "Marcel Wege" — high-confidence
    // NER `pii.name` (0.95) and low-confidence custom `pii.alias` (0.7).
    // Dedup must keep the NER hit only.
    const text = 'Hi Marcel Wege, willkommen.';
    const nameSpan: [number, number] = [text.indexOf('Marcel'), text.indexOf('Wege') + 4];
    const ner = staticDetector('ner:0.1.0', [
      makeHit('pii.name', text.slice(...nameSpan), nameSpan, 0.95, 'ner:0.1.0'),
    ]);
    const alias = staticDetector('alias:0.0.1', [
      makeHit('pii.alias', text.slice(...nameSpan), nameSpan, 0.7, 'alias:0.0.1'),
    ]);

    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [alias, ner],
    });
    await service.processOutbound({
      sessionId: 's',
      turnId: 'dedup',
      systemPrompt: '',
      messages: [{ role: 'user', content: text }],
    });
    const receipt = await service.finalizeTurn('dedup');
    if (!receipt) throw new Error('expected receipt');

    assert.equal(receipt.detections.length, 1, 'overlap must be deduped');
    const det = receipt.detections[0];
    assert.equal(det?.type, 'pii.name');
    assert.equal(det?.detector, 'ner:0.1.0');
  });

  it('span-overlap tie on confidence: shorter (more specific) span wins', async () => {
    // Two detectors hit overlapping spans with identical confidence:
    //   - "Marcel Wege" (11 chars, broader)
    //   - "Marcel"      (6 chars, narrower)
    // Both at confidence 0.90 — dedup must keep the narrower hit.
    const text = 'Bitte an Marcel Wege weiterleiten.';
    const broadSpan: [number, number] = [
      text.indexOf('Marcel'),
      text.indexOf('Wege') + 4,
    ];
    const narrowSpan: [number, number] = [
      text.indexOf('Marcel'),
      text.indexOf('Marcel') + 'Marcel'.length,
    ];
    const broad = staticDetector('det-a:0.0', [
      makeHit('pii.full_name', text.slice(...broadSpan), broadSpan, 0.9, 'det-a:0.0'),
    ]);
    const narrow = staticDetector('det-b:0.0', [
      makeHit('pii.first_name', text.slice(...narrowSpan), narrowSpan, 0.9, 'det-b:0.0'),
    ]);

    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [broad, narrow],
    });
    await service.processOutbound({
      sessionId: 's',
      turnId: 'tie',
      systemPrompt: '',
      messages: [{ role: 'user', content: text }],
    });
    const receipt = await service.finalizeTurn('tie');
    if (!receipt) throw new Error('expected receipt');

    assert.equal(receipt.detections.length, 1);
    assert.equal(receipt.detections[0]?.type, 'pii.first_name');
  });

  it('non-overlapping hits across detectors are all kept', async () => {
    const text = 'A foo and bar and baz.';
    const fooSpan: [number, number] = [text.indexOf('foo'), text.indexOf('foo') + 3];
    const barSpan: [number, number] = [text.indexOf('bar'), text.indexOf('bar') + 3];
    const bazSpan: [number, number] = [text.indexOf('baz'), text.indexOf('baz') + 3];

    const det1 = staticDetector('d1:0', [
      makeHit('custom.x', 'foo', fooSpan, 0.8, 'd1:0'),
      makeHit('custom.x', 'baz', bazSpan, 0.8, 'd1:0'),
    ]);
    const det2 = staticDetector('d2:0', [
      makeHit('custom.y', 'bar', barSpan, 0.8, 'd2:0'),
    ]);

    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [det1, det2],
    });
    await service.processOutbound({
      sessionId: 's',
      turnId: 'no-overlap',
      systemPrompt: '',
      messages: [{ role: 'user', content: text }],
    });
    const receipt = await service.finalizeTurn('no-overlap');
    if (!receipt) throw new Error('expected receipt');

    const totalCount = receipt.detections.reduce((sum, d) => sum + d.count, 0);
    assert.equal(totalCount, 3, 'all three non-overlapping hits should land');
  });

  it('detector that throws is fail-open: zero hits, others still run', async () => {
    const text = `Reach me at ${SAMPLE_EMAIL}.`;
    const broken: PrivacyDetector = {
      id: 'broken:0.0.1',
      async detect(): Promise<never> {
        throw new Error('simulated detector outage');
      },
    };

    const service = createPrivacyGuardService({
      defaultPolicyMode: 'pii-shield',
      detectors: [broken, createRegexDetector()],
    });

    const out = await service.processOutbound({
      sessionId: 's',
      turnId: 'fail-open',
      systemPrompt: '',
      messages: [{ role: 'user', content: text }],
    });
    const tokenised = out.messages[0]?.content ?? '';
    assert.ok(!tokenised.includes(SAMPLE_EMAIL), 'regex must still tokenise email');
    assert.ok(/\btok_/.test(tokenised));

    const receipt = await service.finalizeTurn('fail-open');
    if (!receipt) throw new Error('expected receipt');
    // Only the regex contributed — broken detector's failure was swallowed.
    const detectors = receipt.detections.map((d) => d.detector);
    assert.deepEqual(detectors, [REGEX_DETECTOR_ID]);
  });
});

describe('PrivacyGuardService · detector registry (Slice 3.1)', () => {
  it('registerDetector adds to the active set; dispose removes it', async () => {
    const service = createPrivacyGuardService({ defaultPolicyMode: 'pii-shield' });
    assert.equal(service.listDetectors().length, 1, 'starts with regex default');

    const text = 'Hi Marcel.';
    const nameSpan: [number, number] = [text.indexOf('Marcel'), text.indexOf('Marcel') + 6];
    const ner = staticDetector('ner-runtime:0.0', [
      makeHit('pii.name', 'Marcel', nameSpan, 0.9, 'ner-runtime:0.0'),
    ]);

    const dispose = service.registerDetector(ner);
    assert.equal(service.listDetectors().length, 2);

    await service.processOutbound({
      sessionId: 's',
      turnId: 't-with-ner',
      systemPrompt: '',
      messages: [{ role: 'user', content: text }],
    });
    let receipt = await service.finalizeTurn('t-with-ner');
    if (!receipt) throw new Error('expected receipt');
    assert.ok(
      receipt.detections.some((d) => d.detector === 'ner-runtime:0.0'),
      'NER detector must be invoked while registered',
    );

    dispose();
    assert.equal(service.listDetectors().length, 1, 'dispose unregisters');
    // Second dispose is a no-op (idempotent).
    dispose();
    assert.equal(service.listDetectors().length, 1);

    await service.processOutbound({
      sessionId: 's',
      turnId: 't-after-dispose',
      systemPrompt: '',
      messages: [{ role: 'user', content: text }],
    });
    receipt = await service.finalizeTurn('t-after-dispose');
    // Default regex finds nothing in "Hi Marcel."; receipt has no detections.
    assert.equal(receipt?.detections.length ?? 0, 0);
  });

  it('plugin entry registers PrivacyDetectorRegistry as a public service', async () => {
    // Sanity-check that the plugin wires the registry under the canonical
    // service name. We construct a minimal in-memory ServicesAccessor stub
    // that mirrors the kernel's contract.
    const services = new Map<string, unknown>();
    type ServicesAccessor = {
      provide<T>(name: string, impl: T): () => void;
      get<T>(name: string): T | undefined;
      has(name: string): boolean;
      replace<T>(name: string, impl: T): () => void;
    };
    const stubServices: ServicesAccessor = {
      provide(name, impl) {
        services.set(name, impl);
        return () => services.delete(name);
      },
      get(name) {
        return services.get(name) as never;
      },
      has(name) {
        return services.has(name);
      },
      replace(name, impl) {
        services.set(name, impl);
        return () => services.delete(name);
      },
    };
    const ctx = {
      agentId: '@omadia/plugin-privacy-guard',
      smokeMode: false,
      secrets: { get: async () => undefined, require: async () => '', keys: async () => [] },
      config: { get: () => undefined, require: () => '' },
      services: stubServices,
      tools: { register: () => () => {}, registerHandler: () => () => {} },
      routes: { register: () => () => {} },
      jobs: { register: () => () => {} },
      log: () => {},
    } as unknown as Parameters<typeof import('@omadia/plugin-privacy-guard/dist/index.js').activate>[0];

    const { activate } = await import(
      '@omadia/plugin-privacy-guard/dist/index.js'
    );
    const handle = await activate(ctx);

    const registry = services.get(
      PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME,
    ) as PrivacyDetectorRegistry | undefined;
    assert.ok(registry, 'plugin must publish privacyDetectorRegistry');
    assert.equal(typeof registry.register, 'function');
    assert.equal(typeof registry.list, 'function');
    assert.equal(registry.list().length, 1, 'default seed = regex detector');

    const dispose = registry.register(staticDetector('addon:0.0', []));
    assert.equal(registry.list().length, 2);
    dispose();
    assert.equal(registry.list().length, 1);

    await handle.close();
    assert.equal(services.has(PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME), false);
  });
});
