/**
 * #361 — free-text user-prompt PII masking.
 *
 * Covers the detection/substitution engine (`promptMask.ts`), the typed
 * prompt-surrogate map (`v4/pseudonym.ts#createPromptPseudonymMap`), the
 * service policy surface (`maskUserPrompt` / `restorePromptPseudonyms` —
 * default-off flag, degrade-to-C0, failure-closed), and the orchestrator's
 * `PrivacyTurnHandle` delegation incl. feature-detection on providers that
 * predate the contract.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PrivacyGuardService, PromptPiiDetector } from '@omadia/plugin-api';
import { createPrivacyTurnHandle } from '@omadia/orchestrator/dist/privacyHandle.js';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import {
  createBaselineDetector,
  createC1StubDetector,
  dedupSpans,
  maskPrompt,
} from '@omadia/plugin-privacy-guard/dist/promptMask.js';
import { findIdentityLeaks } from '@omadia/plugin-privacy-guard/dist/v4/onTheWire.js';
import {
  createPromptPseudonymMap,
  resolvePseudonyms,
} from '@omadia/plugin-privacy-guard/dist/v4/pseudonym.js';

const RFC_PROMPT =
  'What should we pay Anna Schmidt (32, lives at Bahnhofstr. 5, 60311 Frankfurt) ' +
  'given her current salary of €72,000? Reach her at anna.schmidt@firma.de or +49 171 5551234.';

const RFC_STRUCTURED_VALUES = [
  'Bahnhofstr. 5, 60311 Frankfurt',
  '€72,000',
  'anna.schmidt@firma.de',
  '+49 171 5551234',
];

describe('createBaselineDetector (C0)', () => {
  it('detects each structured identifier type', async () => {
    const spans = await createBaselineDetector().detect(RFC_PROMPT);
    const types = new Set(spans.map((s) => s.type));
    for (const expected of ['email', 'phone', 'address', 'amount']) {
      assert.ok(types.has(expected), `C0 must detect type '${expected}'`);
    }
  });

  it('detects IBAN and DOB-style dates', async () => {
    const spans = await createBaselineDetector().detect(
      'Konto DE89 3704 0044 0532 0130 00, geboren am 24.12.1987.',
    );
    const types = new Set(spans.map((s) => s.type));
    assert.ok(types.has('iban'));
    assert.ok(types.has('date'));
  });

  it('reports nothing on a PII-free prompt (over-masking guard)', async () => {
    const spans = await createBaselineDetector().detect(
      'Summarize our vacation carry-over policy for first-year employees.',
    );
    assert.equal(spans.length, 0);
  });
});

describe('dedupSpans', () => {
  it('resolves overlaps to the higher-confidence span and extends to word boundaries', () => {
    const text = 'mail me at anna.schmidt@firma.de today';
    const resolved = dedupSpans(text, [
      // Low-confidence span covering only part of the address…
      { span: { start: 11, end: 23, type: 'person', confidence: 0.4 }, detector: 'c1' },
      // …and the full email at confidence 1.
      { span: { start: 11, end: 32, type: 'email', confidence: 1 }, detector: 'c0-regex' },
    ]);
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0]!.type, 'email');
    assert.equal(resolved[0]!.value, 'anna.schmidt@firma.de');
  });

  it('extends a mid-word span so no identifying fragment survives', () => {
    const text = 'contact anna.schmidt@firma.de';
    const resolved = dedupSpans(text, [
      // Detector only caught the local part.
      { span: { start: 8, end: 20, type: 'email', confidence: 0.9 }, detector: 'c1' },
    ]);
    assert.equal(resolved[0]!.value, 'anna.schmidt@firma.de');
  });
});

describe('createPromptPseudonymMap', () => {
  it('is bijective, type-shaped, and never collides with the input text', () => {
    const map = createPromptPseudonymMap(
      [
        { value: 'anna.schmidt@firma.de', type: 'email' },
        { value: '+49 171 5551234', type: 'phone' },
        { value: 'Anna Schmidt', type: 'person' },
      ],
      RFC_PROMPT,
    );
    assert.equal(map.forward.size, 3);
    assert.equal(map.reverse.size, 3);
    assert.ok(map.forward.get('anna.schmidt@firma.de')!.includes('@'));
    for (const surrogate of map.reverse.keys()) {
      assert.ok(!RFC_PROMPT.includes(surrogate), `surrogate '${surrogate}' collides with input`);
    }
  });

  it('keeps existing surrogates stable when extended', () => {
    const first = createPromptPseudonymMap(
      [{ value: 'anna.schmidt@firma.de', type: 'email' }],
      'a',
    );
    const second = createPromptPseudonymMap(
      [
        { value: 'anna.schmidt@firma.de', type: 'email' },
        { value: 'DE89370400440532013000', type: 'iban' },
      ],
      'a',
      first,
    );
    assert.equal(
      second.forward.get('anna.schmidt@firma.de'),
      first.forward.get('anna.schmidt@firma.de'),
    );
  });
});

describe('maskPrompt', () => {
  it('produces wire text with zero identity leaks for detected values', async () => {
    const result = await maskPrompt(RFC_PROMPT, [createBaselineDetector()]);
    for (const value of RFC_STRUCTURED_VALUES) {
      assert.equal(
        findIdentityLeaks(result.maskedText, [value]).length,
        0,
        `real value '${value}' survived masking`,
      );
    }
  });

  it('round-trips exactly via resolvePseudonyms', async () => {
    const result = await maskPrompt(RFC_PROMPT, [createBaselineDetector()]);
    assert.equal(resolvePseudonyms(result.maskedText, result.map), RFC_PROMPT);
  });

  it('masks a repeated value everywhere, even when detected once', async () => {
    const email = 'anna.schmidt@firma.de';
    const text = `Mail ${email}. I repeat: ${email}`;
    const result = await maskPrompt(text, [createBaselineDetector()]);
    assert.equal(findIdentityLeaks(result.maskedText, [email]).length, 0);
  });

  it('is a no-op on PII-free text', async () => {
    const text = 'Draft a neutral follow-up on the roadmap review.';
    const result = await maskPrompt(text, [createBaselineDetector()]);
    assert.equal(result.maskedText, text);
    assert.equal(result.spans.length, 0);
  });
});

describe('PrivacyGuardService.maskUserPrompt', () => {
  const req = (turnId: string) => ({ sessionId: 's', turnId, text: RFC_PROMPT });

  it('reports disabled without a readConfig (flag-off ⇒ byte-identical path)', async () => {
    const svc = createPrivacyGuardService();
    assert.deepEqual(await svc.maskUserPrompt!(req('t-off')), { outcome: 'disabled' });
  });

  it('reports disabled when the flag is off/unset', async () => {
    const svc = createPrivacyGuardService({ readConfig: () => 'off' });
    assert.deepEqual(await svc.maskUserPrompt!(req('t-off2')), { outcome: 'disabled' });
  });

  it('masks when the flag is on; wire text carries zero detected real values', async () => {
    const svc = createPrivacyGuardService({ readConfig: () => 'on' });
    const result = await svc.maskUserPrompt!(req('t-on'));
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.equal(result.degraded, false);
    for (const value of RFC_STRUCTURED_VALUES) {
      assert.equal(findIdentityLeaks(result.maskedText, [value]).length, 0);
    }
    // Span records are PII-free (type + detector only).
    for (const span of result.spans) {
      assert.deepEqual(Object.keys(span).sort(), ['detector', 'type']);
    }
  });

  it('restores surrogates in the answer and surfaces spans in the receipt', async () => {
    const svc = createPrivacyGuardService({ readConfig: () => 'on' });
    const masked = await svc.maskUserPrompt!(req('t-restore'));
    assert.equal(masked.outcome, 'masked');
    if (masked.outcome !== 'masked') return;
    // Simulate the LLM echoing a surrogate back in its answer.
    const answer = `The details: ${masked.maskedText}`;
    const restored = await svc.restorePromptPseudonyms!('t-restore', answer);
    for (const value of RFC_STRUCTURED_VALUES) {
      assert.ok(restored.includes(value), `answer must restore '${value}'`);
    }
    const receipt = await svc.finalizeTurn('t-restore');
    assert.ok(receipt, 'a masked-prompt turn must emit a receipt');
    assert.ok((receipt.maskedPromptSpans?.length ?? 0) > 0);
    // finalize dropped the map — restore becomes identity.
    assert.equal(await svc.restorePromptPseudonyms!('t-restore', answer), answer);
  });

  it('shares one surrogate map across repeated calls in a turn', async () => {
    const svc = createPrivacyGuardService({ readConfig: () => 'on' });
    const a = await svc.maskUserPrompt!({
      sessionId: 's',
      turnId: 't-shared',
      text: 'Mail anna.schmidt@firma.de',
    });
    const b = await svc.maskUserPrompt!({
      sessionId: 's',
      turnId: 't-shared',
      text: 'Attachment mentions anna.schmidt@firma.de again',
    });
    assert.equal(a.outcome, 'masked');
    assert.equal(b.outcome, 'masked');
    if (a.outcome !== 'masked' || b.outcome !== 'masked') return;
    const surrogateA = a.maskedText.replace('Mail ', '');
    assert.ok(
      b.maskedText.includes(surrogateA),
      'the same real value must map to the same surrogate within a turn',
    );
  });

  it('degrades to C0 (audited, masked) when the C1 detector throws', async () => {
    const throwingC1: PromptPiiDetector = {
      id: 'c1-broken',
      detect: async () => {
        throw new Error('transformer down');
      },
    };
    const svc = createPrivacyGuardService({
      readConfig: () => 'on',
      c1Detector: throwingC1,
    });
    const result = await svc.maskUserPrompt!(req('t-degraded'));
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.equal(result.degraded, true);
    // C0 results still applied.
    assert.equal(
      findIdentityLeaks(result.maskedText, ['anna.schmidt@firma.de']).length,
      0,
    );
  });

  it('uses C1 spans when the detector works (stub seam contract)', async () => {
    const svc = createPrivacyGuardService({
      readConfig: () => 'on',
      c1Detector: createC1StubDetector(),
    });
    const result = await svc.maskUserPrompt!(req('t-c1'));
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.equal(result.degraded, false);
  });
});

describe('PrivacyTurnHandle prompt-mask delegation', () => {
  function stubService(overrides: Partial<PrivacyGuardService>): PrivacyGuardService {
    return {
      internToolResultV4: async () => ({ digestText: '', datasetId: 'ds' }),
      recordBypassedTool: async () => undefined,
      runV4Tool: async () => ({ resultText: '' }),
      subAgentResultV4: async () => ({ resultText: '' }),
      takeRenderedAnswerV4: async () => undefined,
      v4ToolSpecs: () => [],
      finalizeTurn: async () => undefined,
      ...overrides,
    };
  }

  it('feature-detects providers without the optional methods (disabled / identity)', async () => {
    const handle = createPrivacyTurnHandle({
      service: stubService({}),
      sessionId: 's',
      turnId: 't',
    });
    assert.deepEqual(await handle.maskUserPrompt('text'), { outcome: 'disabled' });
    assert.equal(await handle.restorePromptPseudonyms('answer'), 'answer');
  });

  it('propagates the failure-closed blocked outcome', async () => {
    const handle = createPrivacyTurnHandle({
      service: stubService({
        maskUserPrompt: async () => ({ outcome: 'blocked', reason: 'test' }),
      }),
      sessionId: 's',
      turnId: 't',
    });
    const result = await handle.maskUserPrompt('text');
    assert.equal(result.outcome, 'blocked');
  });

  it('scopes the request to the handle turn/session pair', async () => {
    let seen: { sessionId: string; turnId: string; text: string } | undefined;
    const handle = createPrivacyTurnHandle({
      service: stubService({
        maskUserPrompt: async (request) => {
          seen = request;
          return { outcome: 'masked', maskedText: 'X', spans: [], degraded: false };
        },
      }),
      sessionId: 'session-1',
      turnId: 'turn-1',
    });
    await handle.maskUserPrompt('hello');
    assert.deepEqual(seen, { sessionId: 'session-1', turnId: 'turn-1', text: 'hello' });
  });
});
