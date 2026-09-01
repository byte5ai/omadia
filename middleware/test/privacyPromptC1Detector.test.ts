/**
 * #361 — C1 HTTP detector (`createC1HttpDetector`) over the GLiNER
 * PII-detector sidecar.
 *
 * Pins the fail-closed client contract:
 *   - URL unresolved      ⇒ `[]`, no fetch (unconfigured ≠ degraded);
 *   - valid response      ⇒ spans converted code-point → UTF-16 exactly
 *                           (incl. astral-plane characters);
 *   - anything unexpected ⇒ THROW (schema mismatch, non-200, non-JSON,
 *                           offset/slice mismatch, timeout) — the service's
 *                           tier-1 path turns the throw into an audited
 *                           degrade-to-C0, which the composition tests at
 *                           the bottom pin end-to-end.
 *
 * The generic throwing-detector degrade case lives in
 * `privacyPromptMask.test.ts`; here the SAME semantics are asserted through
 * the real HTTP client implementation.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PromptPiiSpan } from '@omadia/plugin-api';
import {
  C1_DETECTOR_ID,
  createC1HttpDetector,
  DEFAULT_TIMEOUT_MS as DEFAULT_C1_TIMEOUT_MS,
  resolveTimeoutFromEnv,
} from '@omadia/plugin-privacy-guard/dist/c1Detector.js';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import { findIdentityLeaks } from '@omadia/plugin-privacy-guard/dist/v4/onTheWire.js';

type SidecarSpan = {
  start: number;
  end: number;
  text: string;
  label: string;
  score: number;
};

/** fetch fake answering a canned sidecar response; records calls. */
function fakeFetch(
  respond: (body: string) => Response | Promise<Response>,
): { fn: typeof fetch; calls: { url: string; body: unknown }[] } {
  const calls: { url: string; body: unknown }[] = [];
  const fn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body: unknown = JSON.parse(String(init?.body ?? 'null'));
    calls.push({ url, body });
    return await respond(String(init?.body ?? ''));
  }) as typeof fetch;
  return { fn, calls };
}

function okResponse(spans: SidecarSpan[]): Response {
  return new Response(
    JSON.stringify({ ok: true, model_version: 'test', spans }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('createC1HttpDetector', () => {
  it('returns [] without fetching when no URL resolves (unconfigured, not degraded)', async () => {
    const { fn, calls } = fakeFetch(() => okResponse([]));
    for (const unresolved of [undefined, '', '   ']) {
      const detector = createC1HttpDetector({
        resolveUrl: () => unresolved,
        fetchFn: fn,
      });
      assert.deepEqual(await detector.detect('Mail an Anna Schmidt'), []);
    }
    assert.equal(calls.length, 0, 'unconfigured detector must not fetch');
  });

  it('has the stable receipt id c1-gliner', () => {
    const detector = createC1HttpDetector({ resolveUrl: () => undefined });
    assert.equal(detector.id, 'c1-gliner');
    assert.equal(detector.id, C1_DETECTOR_ID);
  });

  it('POSTs {text, labels, threshold} to <url>/detect (trailing slash normalized)', async () => {
    const { fn, calls } = fakeFetch(() => okResponse([]));
    const detector = createC1HttpDetector({
      resolveUrl: () => 'http://pii-detector:8812/',
      fetchFn: fn,
    });
    await detector.detect('kein PII hier');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://pii-detector:8812/detect');
    assert.deepEqual(calls[0]!.body, {
      text: 'kein PII hier',
      labels: ['person', 'address'],
      threshold: 0.5,
    });
  });

  it('converts code-point offsets to UTF-16 exactly (astral-plane case)', async () => {
    // '😀' is ONE code point but TWO UTF-16 units — the exact Python↔JS
    // divergence the conversion exists for.
    const text = '😀 Anna Schmidt wohnt in der Bahnhofstr. 5';
    // Sidecar (Python) offsets: emoji=1 position, so 'Anna Schmidt' is
    // code points 2..14 and 'Bahnhofstr. 5' is 28..41.
    const { fn } = fakeFetch(() =>
      okResponse([
        { start: 2, end: 14, text: 'Anna Schmidt', label: 'person', score: 0.93 },
        { start: 28, end: 41, text: 'Bahnhofstr. 5', label: 'address', score: 0.81 },
      ]),
    );
    const detector = createC1HttpDetector({
      resolveUrl: () => 'http://sidecar',
      fetchFn: fn,
    });
    const spans = await detector.detect(text);
    assert.equal(spans.length, 2);
    const [person, address] = spans as [PromptPiiSpan, PromptPiiSpan];
    // UTF-16: emoji occupies indices 0..2, so the name starts at 3.
    assert.equal(person.start, 3);
    assert.equal(person.end, 15);
    assert.equal(text.slice(person.start, person.end), 'Anna Schmidt');
    assert.equal(person.type, 'person');
    assert.equal(person.confidence, 0.93);
    assert.equal(text.slice(address.start, address.end), 'Bahnhofstr. 5');
    assert.equal(address.type, 'address');
  });

  it('accepts a span ending exactly at end-of-text', async () => {
    const text = '😀 Anna';
    const { fn } = fakeFetch(() =>
      okResponse([{ start: 2, end: 6, text: 'Anna', label: 'person', score: 0.9 }]),
    );
    const detector = createC1HttpDetector({
      resolveUrl: () => 'http://sidecar',
      fetchFn: fn,
    });
    const spans = await detector.detect(text);
    assert.equal(spans.length, 1);
    assert.equal(text.slice(spans[0]!.start, spans[0]!.end), 'Anna');
  });

  it('throws when the span text does not match its offsets (mis-anchored span = leak)', async () => {
    const { fn } = fakeFetch(() =>
      okResponse([
        // Offsets point at 'Anna Schm', text claims something else.
        { start: 0, end: 9, text: 'Bob Miller', label: 'person', score: 0.9 },
      ]),
    );
    const detector = createC1HttpDetector({
      resolveUrl: () => 'http://sidecar',
      fetchFn: fn,
    });
    await assert.rejects(detector.detect('Anna Schmidt calls'), /does not match/);
  });

  it('throws when span offsets are out of range', async () => {
    const { fn } = fakeFetch(() =>
      okResponse([{ start: 90, end: 99, text: 'x', label: 'person', score: 0.9 }]),
    );
    const detector = createC1HttpDetector({
      resolveUrl: () => 'http://sidecar',
      fetchFn: fn,
    });
    await assert.rejects(detector.detect('kurz'), /out of range/);
  });

  it('throws on non-200, ok:false, malformed spans, and non-JSON bodies', async () => {
    const cases: { name: string; respond: () => Response }[] = [
      {
        name: 'non-200',
        respond: () =>
          new Response(JSON.stringify({ ok: false, error: 'overloaded' }), {
            status: 503,
          }),
      },
      {
        name: 'ok:false with 200',
        respond: () =>
          new Response(JSON.stringify({ ok: false, error: 'nope' }), { status: 200 }),
      },
      {
        name: 'missing spans array',
        respond: () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        name: 'span missing score',
        respond: () =>
          new Response(
            JSON.stringify({
              ok: true,
              spans: [{ start: 0, end: 4, text: 'Anna', label: 'person' }],
            }),
            { status: 200 },
          ),
      },
      {
        name: 'span with non-integer offsets',
        respond: () =>
          new Response(
            JSON.stringify({
              ok: true,
              spans: [{ start: 0.5, end: 4, text: 'Anna', label: 'person', score: 1 }],
            }),
            { status: 200 },
          ),
      },
      {
        name: 'span with end <= start',
        respond: () =>
          new Response(
            JSON.stringify({
              ok: true,
              spans: [{ start: 4, end: 4, text: 'Anna', label: 'person', score: 1 }],
            }),
            { status: 200 },
          ),
      },
      {
        name: 'non-JSON body',
        respond: () => new Response('<html>gateway error</html>', { status: 200 }),
      },
      {
        name: 'non-object body',
        respond: () => new Response('42', { status: 200 }),
      },
    ];
    for (const { name, respond } of cases) {
      const { fn } = fakeFetch(respond);
      const detector = createC1HttpDetector({
        resolveUrl: () => 'http://sidecar',
        fetchFn: fn,
      });
      await assert.rejects(
        detector.detect('Anna Schmidt'),
        undefined,
        `case '${name}' must throw (fail-closed)`,
      );
    }
  });

  it('throws on timeout even when the transport ignores the abort signal', async () => {
    const never = (() => new Promise<Response>(() => undefined)) as typeof fetch;
    const detector = createC1HttpDetector({
      resolveUrl: () => 'http://sidecar',
      fetchFn: never,
      timeoutMs: 25,
    });
    await assert.rejects(detector.detect('Anna Schmidt'), /timed out after 25ms/);
  });

  it('maps unknown labels to a slug type and clamps the score into [0,1]', async () => {
    const text = 'DE89 3704 0044 0532 0130 00 gehört Anna';
    const { fn } = fakeFetch(() =>
      okResponse([
        { start: 0, end: 27, text: 'DE89 3704 0044 0532 0130 00', label: 'Credit Card', score: 1.7 },
        { start: 35, end: 39, text: 'Anna', label: 'person', score: -0.2 },
      ]),
    );
    const detector = createC1HttpDetector({
      resolveUrl: () => 'http://sidecar',
      fetchFn: fn,
    });
    const spans = await detector.detect(text);
    assert.equal(spans[0]!.type, 'credit-card');
    assert.equal(spans[0]!.confidence, 1);
    assert.equal(spans[1]!.type, 'person');
    assert.equal(spans[1]!.confidence, 0);
  });

  it('honors custom labels and threshold in the request body', async () => {
    const { fn, calls } = fakeFetch(() => okResponse([]));
    const detector = createC1HttpDetector({
      resolveUrl: () => 'http://sidecar',
      fetchFn: fn,
      labels: ['person'],
      threshold: 0.7,
    });
    await detector.detect('text');
    assert.deepEqual(calls[0]!.body, { text: 'text', labels: ['person'], threshold: 0.7 });
  });
});

// ---------------------------------------------------------------------------
// Composition with the shipped service — the HTTP detector's throw semantics
// must ride the tier-1 degrade path, and its spans the normal mask pass.
// (The generic stub/throwing-detector cases live in privacyPromptMask.test.ts;
// these two pin the REAL client end-to-end.)
// ---------------------------------------------------------------------------

describe('createC1HttpDetector × createPrivacyGuardService', () => {
  it('degrades to C0 (masked, degraded:true) when the sidecar is unreachable', async () => {
    const failingFetch = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof fetch;
    const svc = createPrivacyGuardService({
      readConfig: () => 'on',
      c1Detector: createC1HttpDetector({
        resolveUrl: () => 'http://sidecar',
        fetchFn: failingFetch,
      }),
    });
    const result = await svc.maskUserPrompt!({
      sessionId: 's',
      turnId: 't-http-degraded',
      text: 'Mail an anna.schmidt@firma.de bitte',
    });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.equal(result.degraded, true);
    // The C0 baseline still masked the structured identifier.
    assert.equal(
      findIdentityLeaks(result.maskedText, ['anna.schmidt@firma.de']).length,
      0,
    );
  });

  it('masks C1 person spans through the normal pass (degraded:false, detector attributed)', async () => {
    const text = 'What should we pay Anna Schmidt next year?';
    const { fn } = fakeFetch(() =>
      okResponse([
        { start: 19, end: 31, text: 'Anna Schmidt', label: 'person', score: 0.95 },
      ]),
    );
    const svc = createPrivacyGuardService({
      readConfig: () => 'on',
      c1Detector: createC1HttpDetector({
        resolveUrl: () => 'http://sidecar',
        fetchFn: fn,
      }),
    });
    const result = await svc.maskUserPrompt!({
      sessionId: 's',
      turnId: 't-http-person',
      text,
    });
    assert.equal(result.outcome, 'masked');
    if (result.outcome !== 'masked') return;
    assert.equal(result.degraded, false);
    assert.ok(
      !result.maskedText.includes('Anna Schmidt'),
      'the real name must not survive on the wire',
    );
    const personSpans = result.spans.filter((s) => s.type === 'person');
    assert.ok(personSpans.length >= 1);
    assert.equal(personSpans[0]!.detector, 'c1-gliner');
    // Restore projects the surrogate back to the real name.
    const surrogate = result.maskedText.slice(19).split(' next')[0]!;
    const restored = await svc.restorePromptPseudonyms!(
      't-http-person',
      `We should pay ${surrogate} more.`,
    );
    assert.equal(restored, 'We should pay Anna Schmidt more.');
  });
});

describe('C1 detect timeout budget', () => {
  /**
   * #975 — the 1500 ms default starved every realistic turn. Measured
   * against the live sidecar: a 46-char sentence takes 69-133 ms, a 3.4 KB
   * prompt (one modest attachment) takes 3.7-3.8 s. Everything over the cap
   * logged `promptMaskDegraded` and fell back to C0, so person names went
   * unmasked on exactly the turns carrying the most of them.
   */
  it('defaults well above the measured cost of a realistic prompt', () => {
    // A 3.4 KB prompt measured 3.8 s; the default must clear it with room.
    assert.ok(
      DEFAULT_C1_TIMEOUT_MS >= 10_000,
      `default ${String(DEFAULT_C1_TIMEOUT_MS)}ms is too tight for a multi-KB prompt`,
    );
  });

  it('honours a valid PRIVACY_C1_TIMEOUT_MS override', () => {
    assert.equal(resolveTimeoutFromEnv({ PRIVACY_C1_TIMEOUT_MS: '2500' }), 2500);
  });

  it('ignores an unset or blank override', () => {
    assert.equal(resolveTimeoutFromEnv({}), undefined);
    assert.equal(resolveTimeoutFromEnv({ PRIVACY_C1_TIMEOUT_MS: '   ' }), undefined);
  });

  it('ignores a malformed override rather than degrading every turn', () => {
    // A 0 or negative cap would make detect() abort instantly, i.e. silently
    // turn C1 off for the whole install. Fall back to the default instead.
    for (const bad of ['0', '-1', 'abc', 'NaN', 'Infinity']) {
      assert.equal(
        resolveTimeoutFromEnv({ PRIVACY_C1_TIMEOUT_MS: bad }),
        undefined,
        `expected ${bad} to be rejected`,
      );
    }
  });

  it('actually applies the configured timeout to a hanging sidecar', async () => {
    const detector = createC1HttpDetector({
      resolveUrl: () => 'http://sidecar.invalid:8812',
      timeoutMs: 40,
      fetchFn: (async (_url: string, init?: { signal?: AbortSignal }) =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          );
          // never settles on its own
        })) as unknown as typeof fetch,
    });
    await assert.rejects(
      () => detector.detect('Anna Schmidt wohnt in Berlin.'),
      /timed out after 40ms/,
    );
  });
});
