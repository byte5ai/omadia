import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  PRIVACY_DETECTOR_REGISTRY_SERVICE_NAME,
  type PrivacyDetector,
  type PrivacyDetectorRegistry,
} from '@omadia/plugin-api';

import {
  buildNerMessages,
  createOllamaNerDetector,
  NER_FEW_SHOT,
  NER_SYSTEM_PROMPT,
  NER_TYPE_VOCABULARY,
  NerResponseSchema,
  parseNerResponse,
  type OllamaChatClient,
  type OllamaChatRequest,
} from '@omadia/plugin-privacy-detector-ollama/dist/index.js';

// ---------------------------------------------------------------------------
// Slice 3.2 — Ollama-backed NER detector + plugin wiring.
//
// All Ollama HTTP traffic is faked with stub clients. The integration
// boot-smoke (real sidecar) is a separate manual step gated on the
// `ollama pull` having landed on the Fly machine.
// ---------------------------------------------------------------------------

function stubClient(
  respond: (req: OllamaChatRequest) => Promise<string> | string,
  health: () => boolean = () => true,
): OllamaChatClient {
  return {
    async chat(req) {
      const out = await respond(req);
      return out;
    },
    async health() {
      return health();
    },
  };
}

describe('nerPrompt · message scaffolding (Slice 3.2)', () => {
  it('builds [system, fewShot×N alternating, user]', () => {
    const msgs = buildNerMessages('Hi John.');
    assert.equal(msgs.length, 1 + NER_FEW_SHOT.length * 2 + 1);
    assert.equal(msgs[0]?.role, 'system');
    assert.equal(msgs[0]?.content, NER_SYSTEM_PROMPT);
    // Each example contributes a user/assistant pair.
    for (let i = 0; i < NER_FEW_SHOT.length; i++) {
      assert.equal(msgs[1 + i * 2]?.role, 'user');
      assert.equal(msgs[2 + i * 2]?.role, 'assistant');
    }
    const last = msgs[msgs.length - 1];
    assert.equal(last?.role, 'user');
    assert.equal(last?.content, 'Hi John.');
  });

  it('every few-shot assistant content parses + validates against the response schema', () => {
    for (const ex of NER_FEW_SHOT) {
      const parsed = JSON.parse(ex.assistant);
      const ok = NerResponseSchema.safeParse(parsed);
      assert.ok(ok.success, `few-shot example "${ex.user.slice(0, 30)}…" must be valid JSON: ${JSON.stringify(ok)}`);
    }
  });

  it('only emits the documented type vocabulary in few-shot examples', () => {
    const allowed = new Set<string>(NER_TYPE_VOCABULARY);
    for (const ex of NER_FEW_SHOT) {
      const parsed = NerResponseSchema.parse(JSON.parse(ex.assistant));
      for (const hit of parsed.hits) {
        assert.ok(allowed.has(hit.type), `hit.type ${hit.type} not in vocabulary`);
      }
    }
  });
});

describe('parseNerResponse · permissive parser (Slice 3.2)', () => {
  it('accepts a clean JSON object', () => {
    const r = parseNerResponse('{"hits":[]}');
    assert.deepEqual(r, { hits: [] });
  });

  it('accepts JSON with leading/trailing whitespace', () => {
    const r = parseNerResponse('  \n{"hits":[]}\n  ');
    assert.deepEqual(r, { hits: [] });
  });

  it('extracts the outermost object when the model adds trailing commentary', () => {
    const raw = '{"hits":[]}\n\nDas war alles.';
    const r = parseNerResponse(raw);
    assert.deepEqual(r, { hits: [] });
  });

  it('returns undefined on broken JSON', () => {
    assert.equal(parseNerResponse('{"hits": ['), undefined);
    assert.equal(parseNerResponse(''), undefined);
    assert.equal(parseNerResponse('not json at all'), undefined);
  });

  it('returns undefined when type is outside the vocabulary', () => {
    const raw = '{"hits":[{"type":"pii.unknown","value":"x","start":0,"end":1,"confidence":0.5}]}';
    assert.equal(parseNerResponse(raw), undefined);
  });

  it('returns undefined when confidence is out of range', () => {
    const raw = '{"hits":[{"type":"pii.name","value":"x","start":0,"end":1,"confidence":1.5}]}';
    assert.equal(parseNerResponse(raw), undefined);
  });
});

describe('createOllamaNerDetector · adapter contract (Slice 3.2)', () => {
  it('detector id is surfaced verbatim on every hit', async () => {
    const detector = createOllamaNerDetector({
      client: stubClient(
        () =>
          '{"hits":[{"type":"pii.name","value":"John","start":3,"end":9,"confidence":0.9}]}',
      ),
      model: 'llama3.2:3b',
      detectorId: 'ollama:llama3.2:3b',
      maxInputChars: 8000,
      timeoutMs: 5000,
      log: () => {},
    });
    const { hits } = await detector.detect('Hi John hi.');
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.detector, 'ollama:llama3.2:3b');
    assert.equal(detector.id, 'ollama:llama3.2:3b');
  });

  it('skips long input above max_input_chars and returns []', async () => {
    let chatCalls = 0;
    const detector = createOllamaNerDetector({
      client: stubClient(() => {
        chatCalls++;
        return '{"hits":[]}';
      }),
      model: 'llama3.2:3b',
      detectorId: 'ollama:llama3.2:3b',
      maxInputChars: 50,
      timeoutMs: 5000,
      log: () => {},
    });
    const tooLong = 'a'.repeat(100);
    const { hits } = await detector.detect(tooLong);
    assert.deepEqual(hits, []);
    assert.equal(chatCalls, 0, 'long input must short-circuit before any chat call');
  });

  it('returns [] (fail-open) when the chat client throws', async () => {
    const detector = createOllamaNerDetector({
      client: stubClient(() => {
        throw new Error('simulated network outage');
      }),
      model: 'llama3.2:3b',
      detectorId: 'ollama:llama3.2:3b',
      maxInputChars: 8000,
      timeoutMs: 5000,
      log: () => {},
    });
    const { hits } = await detector.detect('Hi John.');
    assert.deepEqual(hits, []);
  });

  it('returns [] (fail-open) when the response is not valid JSON', async () => {
    const detector = createOllamaNerDetector({
      client: stubClient(() => 'totally not json'),
      model: 'llama3.2:3b',
      detectorId: 'ollama:llama3.2:3b',
      maxInputChars: 8000,
      timeoutMs: 5000,
      log: () => {},
    });
    const { hits } = await detector.detect('Hi John.');
    assert.deepEqual(hits, []);
  });

  it('re-anchors hits via indexOf when the model returns wrong-but-shape-valid offsets', async () => {
    // Model returns plausible-looking but wrong offsets (start=0, end=5).
    // The slice at those offsets does not match `value`, so the detector
    // re-scans via indexOf and recovers the real span.
    const text = 'Bitte an John Doe weiterleiten.';
    const detector = createOllamaNerDetector({
      client: stubClient(
        () =>
          `{"hits":[{"type":"pii.name","value":"John Doe","start":0,"end":5,"confidence":0.95}]}`,
      ),
      model: 'llama3.2:3b',
      detectorId: 'ollama:llama3.2:3b',
      maxInputChars: 8000,
      timeoutMs: 5000,
      log: () => {},
    });
    const { hits } = await detector.detect(text);
    assert.equal(hits.length, 1);
    const hit = hits[0];
    if (!hit) throw new Error('expected a hit');
    assert.equal(text.slice(hit.span[0], hit.span[1]), 'John Doe');
    assert.equal(hit.span[0], text.indexOf('John Doe'));
  });

  it('drops hits whose value is not present in the source text (model hallucination)', async () => {
    const detector = createOllamaNerDetector({
      client: stubClient(
        () =>
          `{"hits":[{"type":"pii.name","value":"NotInTheText","start":0,"end":12,"confidence":0.95}]}`,
      ),
      model: 'llama3.2:3b',
      detectorId: 'ollama:llama3.2:3b',
      maxInputChars: 8000,
      timeoutMs: 5000,
      log: () => {},
    });
    const { hits } = await detector.detect('Hi John.');
    assert.deepEqual(hits, []);
  });

  it('disambiguates two identical values to distinct spans via cursor advance', async () => {
    const text = 'John hat John verloren.';
    const detector = createOllamaNerDetector({
      client: stubClient(
        () =>
          `{"hits":[` +
          `{"type":"pii.name","value":"John","start":0,"end":6,"confidence":0.9},` +
          `{"type":"pii.name","value":"John","start":11,"end":17,"confidence":0.9}` +
          `]}`,
      ),
      model: 'llama3.2:3b',
      detectorId: 'ollama:llama3.2:3b',
      maxInputChars: 8000,
      timeoutMs: 5000,
      log: () => {},
    });
    const { hits } = await detector.detect(text);
    assert.equal(hits.length, 2);
    assert.notDeepEqual(hits[0]?.span, hits[1]?.span);
    assert.equal(hits[0]?.span[0], 0);
    assert.equal(hits[1]?.span[0], 11);
  });

  it('surfaces empty input as zero hits without calling the chat client', async () => {
    let chatCalls = 0;
    const detector = createOllamaNerDetector({
      client: stubClient(() => {
        chatCalls++;
        return '{"hits":[]}';
      }),
      model: 'llama3.2:3b',
      detectorId: 'ollama:llama3.2:3b',
      maxInputChars: 8000,
      timeoutMs: 5000,
      log: () => {},
    });
    const { hits } = await detector.detect('');
    assert.deepEqual(hits, []);
    assert.equal(chatCalls, 0);
  });
});

describe('plugin activate · registers detector with privacyDetectorRegistry (Slice 3.2)', () => {
  it('looks up the registry and registers the Ollama NER detector', async () => {
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
      agentId: '@omadia/plugin-privacy-detector-ollama',
      smokeMode: false,
      secrets: { get: async () => undefined, require: async () => '', keys: async () => [] },
      config: {
        get: (key: string) => {
          if (key === 'ollama_endpoint') return 'http://127.0.0.1:1';
          if (key === 'ollama_model') return 'llama3.2:3b';
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
      typeof import('@omadia/plugin-privacy-detector-ollama/dist/index.js').activate
    >[0];

    const { activate } = await import(
      '@omadia/plugin-privacy-detector-ollama/dist/index.js'
    );
    const handle = await activate(ctx);

    assert.equal(registered.length, 1, 'plugin must register exactly one detector');
    assert.equal(registered[0]?.id, 'ollama:llama3.2:3b');

    await handle.close();
    assert.equal(registered.length, 0, 'close() must unregister the detector');
  });

  it('throws when privacyDetectorRegistry is not present (privacy-guard missing)', async () => {
    const services = new Map<string, unknown>();
    const ctx = {
      agentId: '@omadia/plugin-privacy-detector-ollama',
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
      typeof import('@omadia/plugin-privacy-detector-ollama/dist/index.js').activate
    >[0];

    const { activate } = await import(
      '@omadia/plugin-privacy-detector-ollama/dist/index.js'
    );
    void services;
    await assert.rejects(activate(ctx), /requires the 'privacyDetectorRegistry' service/);
  });
});
