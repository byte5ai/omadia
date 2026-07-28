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
