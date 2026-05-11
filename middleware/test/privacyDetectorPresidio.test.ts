import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME,
  type PrivacyDetector,
  type PrivacyDetectorRegistry,
} from '@omadia/plugin-api';

import {
  createPresidioDetector,
  isPresidioTypeRelevant,
  mapPresidioType,
  PRESIDIO_DETECTOR_VERSION,
  type PresidioAnalyzeRequest,
  type PresidioAnalyzeResponse,
  type PresidioClient,
  type PresidioRawHit,
} from '@omadia/plugin-privacy-detector-presidio/dist/index.js';

// ---------------------------------------------------------------------------
// Slice 3.4 — Presidio-backed detector + plugin wiring.
//
// All Presidio HTTP traffic is faked. The integration boot-smoke (real
// sidecar) is a separate manual step gated on `docker run byte5/privacy-
// detector-presidio:dev`.
// ---------------------------------------------------------------------------

function stubClient(
  respond: (req: PresidioAnalyzeRequest) => Promise<PresidioAnalyzeResponse> | PresidioAnalyzeResponse,
  health: () => boolean = () => true,
): PresidioClient {
  return {
    async analyze(req) {
      const out = await respond(req);
      return out;
    },
    async health() {
      return health();
    },
  };
}

function rawHit(entity_type: string, start: number, end: number, score: number): PresidioRawHit {
  return { entity_type, start, end, score };
}

describe('typeMapping (Slice 3.4)', () => {
  it('maps PERSON to pii.name', () => {
    assert.equal(mapPresidioType('PERSON', 'de'), 'pii.name');
  });

  it('maps LOCATION/GPE to pii.address', () => {
    assert.equal(mapPresidioType('LOCATION', 'de'), 'pii.address');
    assert.equal(mapPresidioType('GPE', 'de'), 'pii.address');
  });

  it('maps ORG/ORGANIZATION to pii.organization', () => {
    assert.equal(mapPresidioType('ORG', 'de'), 'pii.organization');
    assert.equal(mapPresidioType('ORGANIZATION', 'de'), 'pii.organization');
  });

  it('maps EMAIL_ADDRESS / IBAN_CODE / CREDIT_CARD to canonical pii types', () => {
    assert.equal(mapPresidioType('EMAIL_ADDRESS', 'de'), 'pii.email');
    assert.equal(mapPresidioType('IBAN_CODE', 'de'), 'pii.iban');
    assert.equal(mapPresidioType('CREDIT_CARD', 'de'), 'pii.credit_card');
  });

  it('PHONE_NUMBER maps to pii.phone_de in DE, pii.phone otherwise', () => {
    assert.equal(mapPresidioType('PHONE_NUMBER', 'de'), 'pii.phone_de');
    assert.equal(mapPresidioType('PHONE_NUMBER', 'en'), 'pii.phone');
  });

  it('country-specific IDs all collapse to pii.id_number', () => {
    for (const t of ['US_SSN', 'UK_NHS', 'DE_STEUER_ID', 'DE_PERSONALAUSWEIS']) {
      assert.equal(mapPresidioType(t, 'de'), 'pii.id_number');
    }
  });

  it('excludes DATE_TIME, URL, NRP from the receipt (returns undefined)', () => {
    assert.equal(mapPresidioType('DATE_TIME', 'de'), undefined);
    assert.equal(mapPresidioType('URL', 'de'), undefined);
    assert.equal(mapPresidioType('NRP', 'de'), undefined);
    assert.equal(isPresidioTypeRelevant('DATE_TIME'), false);
    assert.equal(isPresidioTypeRelevant('PERSON'), true);
  });

  it('passes unknown entity types through as pii.<lowersnake>', () => {
    assert.equal(mapPresidioType('CUSTOM_ENTITY', 'de'), 'pii.custom_entity');
  });
});

describe('createPresidioDetector · adapter contract (Slice 3.4)', () => {
  it('detector id is surfaced verbatim and includes the Presidio version', async () => {
    const detector = createPresidioDetector({
      client: stubClient(() => ({
        hits: [rawHit('PERSON', 0, 6, 0.85)],
      })),
      language: 'de',
      detectorId: `presidio:${PRESIDIO_DETECTOR_VERSION}`,
      maxInputChars: 100_000,
      timeoutMs: 3000,
      scoreThreshold: 0.4,
      log: () => {},
    });
    const outcome = await detector.detect('John hat ein Team.');
    assert.equal(detector.id, `presidio:${PRESIDIO_DETECTOR_VERSION}`);
    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.hits.length, 1);
    assert.equal(outcome.hits[0]?.detector, `presidio:${PRESIDIO_DETECTOR_VERSION}`);
  });

  it('drops hits below score threshold (defence-in-depth filter)', async () => {
    const detector = createPresidioDetector({
      client: stubClient(() => ({
        hits: [
          rawHit('PERSON', 0, 6, 0.3), // below threshold
          rawHit('IBAN_CODE', 10, 20, 0.95),
        ],
      })),
      language: 'de',
      detectorId: 'presidio:test',
      maxInputChars: 100_000,
      timeoutMs: 3000,
      scoreThreshold: 0.4,
      log: () => {},
    });
    const outcome = await detector.detect('AAAAAA AAAA1234567890');
    assert.equal(outcome.hits.length, 1, 'low-confidence hit dropped');
    assert.equal(outcome.hits[0]?.type, 'pii.iban');
  });

  it('drops hits with excluded entity types (DATE_TIME etc.)', async () => {
    const detector = createPresidioDetector({
      client: stubClient(() => ({
        hits: [
          rawHit('DATE_TIME', 0, 10, 0.95),
          rawHit('URL', 11, 25, 0.95),
          rawHit('PERSON', 26, 32, 0.85),
        ],
      })),
      language: 'de',
      detectorId: 'presidio:test',
      maxInputChars: 100_000,
      timeoutMs: 3000,
      scoreThreshold: 0.4,
      log: () => {},
    });
    const outcome = await detector.detect('2026-05-08 https://x.com John ist da.');
    assert.equal(outcome.hits.length, 1);
    assert.equal(outcome.hits[0]?.type, 'pii.name');
  });

  it('skips long input and returns status=skipped (no chat call)', async () => {
    let analyzeCalls = 0;
    const detector = createPresidioDetector({
      client: stubClient(() => {
        analyzeCalls++;
        return { hits: [] };
      }),
      language: 'de',
      detectorId: 'presidio:test',
      maxInputChars: 100,
      timeoutMs: 3000,
      scoreThreshold: 0.4,
      log: () => {},
    });
    const outcome = await detector.detect('a'.repeat(500));
    assert.equal(outcome.status, 'skipped');
    assert.match(outcome.reason ?? '', /input-too-long/);
    assert.equal(analyzeCalls, 0);
  });

  it('fail-open (status=error) on transport throw', async () => {
    const detector = createPresidioDetector({
      client: stubClient(() => {
        throw new Error('connection refused');
      }),
      language: 'de',
      detectorId: 'presidio:test',
      maxInputChars: 100_000,
      timeoutMs: 3000,
      scoreThreshold: 0.4,
      log: () => {},
    });
    const outcome = await detector.detect('John ist da.');
    assert.equal(outcome.status, 'error');
    assert.deepEqual(outcome.hits, []);
  });

  it('fail-open (status=timeout) on aborted/timeout error', async () => {
    const detector = createPresidioDetector({
      client: stubClient(() => {
        throw new Error('The operation was aborted due to timeout');
      }),
      language: 'de',
      detectorId: 'presidio:test',
      maxInputChars: 100_000,
      timeoutMs: 3000,
      scoreThreshold: 0.4,
      log: () => {},
    });
    const outcome = await detector.detect('John ist da.');
    assert.equal(outcome.status, 'timeout');
  });

  it('drops hits with out-of-range / inverted spans', async () => {
    const text = 'Hi John.';
    const detector = createPresidioDetector({
      client: stubClient(() => ({
        hits: [
          rawHit('PERSON', -1, 5, 0.85),  // negative start
          rawHit('PERSON', 5, 100, 0.85),  // end beyond text length
          rawHit('PERSON', 5, 3, 0.85),    // inverted
          rawHit('PERSON', 3, 9, 0.85),    // valid: "John"
        ],
      })),
      language: 'de',
      detectorId: 'presidio:test',
      maxInputChars: 100_000,
      timeoutMs: 3000,
      scoreThreshold: 0.4,
      log: () => {},
    });
    const outcome = await detector.detect(text);
    assert.equal(outcome.hits.length, 1);
    assert.equal(text.slice(...outcome.hits[0]!.span), 'John');
  });

  it('declares scanTargets={systemPrompt:false, userMessages:true, assistantMessages:true} — Slice 3.4.3', () => {
    // Slice 3.4 boot-smoke surfaced 270+ hits in one turn (memory
    // recall in the system prompt). 3.4.2 narrowed to user-only, but
    // that opened a re-leak hole: assistant-history items that
    // crossed the wire in earlier turns came back unmasked. 3.4.3
    // restores assistantMessages: true while keeping systemPrompt
    // skipped — the heavy memory-recall problem stays solved, the
    // leak is closed, and tokenizeMap determinism keeps token
    // identity coherent across turns.
    const detector = createPresidioDetector({
      client: stubClient(() => ({ hits: [] })),
      language: 'de',
      detectorId: 'presidio:test',
      maxInputChars: 100_000,
      timeoutMs: 3000,
      scoreThreshold: 0.6,
      log: () => {},
    });
    assert.deepEqual(detector.scanTargets, {
      systemPrompt: false,
      userMessages: true,
      assistantMessages: true,
    });
  });
});

describe('plugin activate (Slice 3.4)', () => {
  it('looks up the registry and registers the Presidio detector', async () => {
    const registered: PrivacyDetector[] = [];
    const registry: PrivacyDetectorRegistry = {
      register: (d) => {
        registered.push(d);
        return () => {
          const i = registered.indexOf(d);
          if (i >= 0) registered.splice(i, 1);
        };
      },
      list: () => [...registered],
    };

    const services = new Map<string, unknown>();
    services.set(PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME, registry);

    const ctx = {
      agentId: '@omadia/plugin-privacy-detector-presidio',
      smokeMode: false,
      secrets: { get: async () => undefined, require: async () => '', keys: async () => [] },
      config: {
        get: (key: string) => {
          if (key === 'presidio_endpoint') return 'http://127.0.0.1:1';
          if (key === 'presidio_language') return 'de';
          return undefined;
        },
        require: () => '',
      },
      services: {
        get<T>(name: string): T | undefined {
          return services.get(name) as T | undefined;
        },
        has: (name: string) => services.has(name),
        provide<T>(name: string, impl: T) {
          services.set(name, impl);
          return () => services.delete(name);
        },
        replace<T>(name: string, impl: T) {
          services.set(name, impl);
          return () => services.delete(name);
        },
      },
      tools: { register: () => () => {}, registerHandler: () => () => {} },
      routes: { register: () => () => {} },
      jobs: { register: () => () => {} },
      log: () => {},
    } as unknown as Parameters<
      typeof import('@omadia/plugin-privacy-detector-presidio/dist/index.js').activate
    >[0];

    const { activate } = await import(
      '@omadia/plugin-privacy-detector-presidio/dist/index.js'
    );
    const handle = await activate(ctx);

    assert.equal(registered.length, 1);
    assert.equal(registered[0]?.id, `presidio:${PRESIDIO_DETECTOR_VERSION}`);

    await handle.close();
    assert.equal(registered.length, 0);
  });

  it('throws when privacyDetectorRegistry is absent (privacy-guard missing)', async () => {
    const ctx = {
      agentId: '@omadia/plugin-privacy-detector-presidio',
      smokeMode: false,
      secrets: { get: async () => undefined, require: async () => '', keys: async () => [] },
      config: { get: () => undefined, require: () => '' },
      services: {
        get: () => undefined,
        has: () => false,
        provide: () => () => {},
        replace: () => () => {},
      },
      tools: { register: () => () => {}, registerHandler: () => () => {} },
      routes: { register: () => () => {} },
      jobs: { register: () => () => {} },
      log: () => {},
    } as unknown as Parameters<
      typeof import('@omadia/plugin-privacy-detector-presidio/dist/index.js').activate
    >[0];

    const { activate } = await import(
      '@omadia/plugin-privacy-detector-presidio/dist/index.js'
    );
    await assert.rejects(activate(ctx), /requires the 'privacyDetectorRegistry' service/);
  });
});
