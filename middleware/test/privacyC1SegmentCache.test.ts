/**
 * Privacy Shield v4 — process-wide, content-hash keyed C1 cache for the
 * recalled tail.
 *
 * The recalled prior context (session tail + recall) is re-masked on EVERY
 * turn, although the stored turns it renders never change. The per-turn C1
 * cache (#979) cannot help — it is dropped by `finalizeTurn`, and the tail
 * as a whole differs every turn (one turn added, the oldest dropped). So the
 * caller hands `maskReplayedAnswer` the tail's per-turn SEGMENTS; C1 runs per
 * segment and a segment's spans are cached by sha256 of its content, across
 * turns. These tests pin:
 *
 *   - the masked result is IDENTICAL with and without segmentation, cold
 *     and warm, for a context-free detector;
 *   - a second turn with the same tail plus one new turn sends ONLY the new
 *     segment to the detector;
 *   - a segment list that is not a partition of the text is ignored (one
 *     whole-text call, as before);
 *   - degrade/latch behaviour is unchanged, and a failed segment is not
 *     cached;
 *   - the cache scope (live C1 config) is part of the key; an unconfigured
 *     detector caches nothing;
 *   - the `c1-detect` log line reports `cached=<n>/<total segments>`;
 *   - the LRU is bounded and its keys carry no plaintext.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import type { PromptPiiDetector, PromptPiiSpan } from '@omadia/plugin-api';
import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';
import {
  c1SegmentKey,
  createC1SegmentCache,
} from '@omadia/plugin-privacy-guard/dist/c1SegmentCache.js';
import { propagatePersonNames } from '@omadia/plugin-privacy-guard/dist/c1NamePropagation.js';

const NAMES = ['Anna Schmidt', 'Marvin Vomberg', 'Jens Kowalski'];

/** Context-free stand-in for GLiNER: every occurrence of a known name is a
 *  person span, wherever the text came from. Records every text it scans. */
function nameC1(
  seen: string[],
  failOn?: (text: string) => boolean,
): PromptPiiDetector {
  return {
    id: 'c1-test',
    async detect(text: string): Promise<readonly PromptPiiSpan[]> {
      seen.push(text);
      if (failOn?.(text) === true) {
        throw new Error('C1 detector timed out after 15000 ms');
      }
      const spans: PromptPiiSpan[] = [];
      for (const name of NAMES) {
        let at = text.indexOf(name);
        while (at >= 0) {
          spans.push({ start: at, end: at + name.length, type: 'person', confidence: 0.9 });
          at = text.indexOf(name, at + name.length);
        }
      }
      return spans.sort((a, b) => a.start - b.start);
    },
  };
}

const HEADER = '## Letzte Turns in diesem Chat';
const turnChunk = (time: string, user: string, answer: string): string =>
  `\n- [${time}]\n  Nutzer: ${user}\n  Assistent: ${answer}`;
const T1 = turnChunk(
  '2026-10-01T08:00:00Z',
  'Wann hat Anna Schmidt Geburtstag?',
  'Anna Schmidt hat am 4. Januar Geburtstag (anna.schmidt@example.com).',
);
const T2 = turnChunk(
  '2026-10-01T08:05:00Z',
  'Und Marvin Vomberg?',
  'Marvin Vomberg hat am 21. Januar Geburtstag.',
);
const T3 = turnChunk(
  '2026-10-01T08:10:00Z',
  'Wer vertritt Jens Kowalski?',
  'Jens Kowalski wird von Anna Schmidt vertreten.',
);

function svcWith(
  c1: PromptPiiDetector,
  c1CacheScope?: () => string | undefined,
): ReturnType<typeof createPrivacyGuardService> {
  return createPrivacyGuardService({
    c1Detector: c1,
    ...(c1CacheScope !== undefined ? { c1CacheScope } : {}),
  });
}

async function maskTail(
  svc: ReturnType<typeof createPrivacyGuardService>,
  turnId: string,
  segments: readonly string[] | undefined,
  text: string = (segments ?? []).join(''),
): Promise<Awaited<ReturnType<NonNullable<typeof svc.maskReplayedAnswer>>>> {
  return svc.maskReplayedAnswer!({
    sessionId: 's',
    turnId,
    text,
    ...(segments !== undefined ? { segments } : {}),
  });
}

/** Collect console.log lines while `fn` runs. */
async function captureLog<T>(fn: () => Promise<T>): Promise<{ lines: string[]; value: T }> {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(' '));
  };
  try {
    const value = await fn();
    return { lines, value };
  } finally {
    console.log = original;
  }
}

describe('PrivacyGuardService — per-segment C1 cache for the recalled tail', () => {
  // The segmented path adds a name-propagation step (person tokens found in
  // one segment are masked wherever else they occur), so in general its
  // masking is a SUPERSET of the whole-text path's. This fixture has no
  // surname-only mention, so propagation adds nothing and the outputs are
  // equal — the equality pins the offset mapping and the cache.
  it('masks a multi-segment tail IDENTICALLY with and without segments, cold and warm', async () => {
    const segments = [HEADER, T1, T2, T3];
    const text = segments.join('');

    const baselineSeen: string[] = [];
    const baseline = await maskTail(svcWith(nameC1(baselineSeen)), 't-base', undefined, text);
    assert.equal(baseline.outcome, 'masked');
    assert.deepEqual(baselineSeen, [text], 'without segments: one whole-text call, as today');
    for (const name of NAMES) {
      assert.ok(
        baseline.outcome === 'masked' && !baseline.maskedText.includes(name),
        `${name} is masked`,
      );
    }

    const seen: string[] = [];
    const svc = svcWith(nameC1(seen));
    const cold = await maskTail(svc, 't-1', segments);
    await svc.finalizeTurn('t-1');
    const warm = await maskTail(svc, 't-2', segments);
    await svc.finalizeTurn('t-2');

    assert.deepEqual(cold, baseline, 'segmented (cold) === whole-text');
    assert.deepEqual(warm, baseline, 'segmented (warm, all cached) === whole-text');
    assert.deepEqual(seen, [HEADER, T1, T2, T3], 'the warm turn made no detector call');
  });

  it('a second turn with the same tail plus one new turn sends ONLY the new segment', async () => {
    const seen: string[] = [];
    const svc = svcWith(nameC1(seen));
    await maskTail(svc, 't-1', [HEADER, T1, T2]);
    await svc.finalizeTurn('t-1');
    seen.length = 0;

    const second = await maskTail(svc, 't-2', [HEADER, T1, T2, T3]);
    assert.deepEqual(seen, [T3], 'only the new stored turn reached the detector');

    const reference = await maskTail(
      svcWith(nameC1([])),
      't-ref',
      undefined,
      [HEADER, T1, T2, T3].join(''),
    );
    assert.deepEqual(second, reference, 'spans map back to the right offsets');
  });

  it('logs cached=<n>/<total segments> on the c1-detect line', async () => {
    const svc = svcWith(nameC1([]));
    const first = await captureLog(() => maskTail(svc, 't-1', [HEADER, T1, T2]));
    await svc.finalizeTurn('t-1');
    const second = await captureLog(() => maskTail(svc, 't-2', [HEADER, T1, T2, T3]));

    const C1_LINE = /^\[privacy-guard v4\] c1-detect ms=\d+ chars=(\d+) spans=(\d+) cached=(\d+)\/(\d+)/;
    const m1 = first.lines.map((l) => C1_LINE.exec(l)).find((m) => m !== null);
    const m2 = second.lines.map((l) => C1_LINE.exec(l)).find((m) => m !== null);
    assert.ok(m1, `no c1-detect line in: ${first.lines.join(' | ')}`);
    assert.ok(m2, `no c1-detect line in: ${second.lines.join(' | ')}`);
    assert.deepEqual(m1.slice(3), ['0', '3']);
    assert.deepEqual(m2.slice(3), ['3', '4']);
    assert.equal(m2[1], String([HEADER, T1, T2, T3].join('').length));
  });

  it('the whole-text path logs cached=0/1', async () => {
    const svc = createPrivacyGuardService({ readConfig: () => 'on', c1Detector: nameC1([]) });
    const { lines } = await captureLog(() =>
      svc.maskUserPrompt!({ sessionId: 's', turnId: 't-u', text: 'Mail an Anna Schmidt' }),
    );
    assert.ok(
      lines.some((l) => /c1-detect ms=\d+ chars=20 spans=1 cached=0\/1 /.test(l)),
      lines.join(' | '),
    );
  });

  it('ignores a segment list that is not a partition of the text (one whole-text call)', async () => {
    const seen: string[] = [];
    const svc = svcWith(nameC1(seen));
    const text = [HEADER, T1, T2].join('');
    const result = await maskTail(svc, 't-1', [HEADER, T2, T1], text);
    assert.deepEqual(seen, [text]);
    const reference = await maskTail(svcWith(nameC1([])), 't-ref', undefined, text);
    assert.deepEqual(result, reference);
  });

  it('blank segments are not sent to the detector', async () => {
    const seen: string[] = [];
    const svc = svcWith(nameC1(seen));
    await maskTail(svc, 't-1', [HEADER, '\n\n', T1]);
    assert.deepEqual(seen, [HEADER, T1]);
  });

  it('a failing segment degrades the whole text to C0, latches the turn, and is not cached', async () => {
    const seen: string[] = [];
    let failing = true;
    const svc = svcWith(nameC1(seen, (t) => failing && t === T3));

    const degraded = await maskTail(svc, 't-1', [HEADER, T1, T2, T3]);
    assert.equal(degraded.outcome, 'masked');
    assert.ok(degraded.outcome === 'masked' && degraded.degraded, 'reports degraded');
    assert.ok(
      degraded.outcome === 'masked' && !degraded.maskedText.includes('anna.schmidt@example.com'),
      'C0 still masks the e-mail',
    );
    assert.deepEqual(seen, [HEADER, T1, T2, T3]);

    // Latched: a later call in the SAME turn skips the network entirely.
    seen.length = 0;
    const again = await maskTail(svc, 't-1', [HEADER, T1]);
    assert.ok(again.outcome === 'masked' && again.degraded);
    assert.deepEqual(seen, []);
    await svc.finalizeTurn('t-1');

    // Next turn: the sidecar recovered — only the failed segment is retried.
    failing = false;
    seen.length = 0;
    const recovered = await maskTail(svc, 't-2', [HEADER, T1, T2, T3]);
    assert.ok(recovered.outcome === 'masked' && !recovered.degraded);
    assert.deepEqual(seen, [T3]);
  });

  it('caches nothing while C1 is unconfigured (scope undefined) and keys by scope', async () => {
    const seen: string[] = [];
    let scope: string | undefined;
    const svc = svcWith(nameC1(seen), () => scope);

    await maskTail(svc, 't-1', [HEADER, T1]);
    await svc.finalizeTurn('t-1');
    await maskTail(svc, 't-2', [HEADER, T1]);
    await svc.finalizeTurn('t-2');
    assert.deepEqual(seen, [HEADER, T1, HEADER, T1], 'unconfigured ⇒ no cache');

    seen.length = 0;
    scope = 'http://pii-a:8080';
    await maskTail(svc, 't-3', [HEADER, T1]);
    await svc.finalizeTurn('t-3');
    await maskTail(svc, 't-4', [HEADER, T1]);
    await svc.finalizeTurn('t-4');
    assert.deepEqual(seen, [HEADER, T1], 'configured ⇒ cached across turns');

    seen.length = 0;
    scope = 'http://pii-b:8080';
    await maskTail(svc, 't-5', [HEADER, T1]);
    assert.deepEqual(seen, [HEADER, T1], 'a reconfigured sidecar misses the old entries');
  });
});

/** GLiNER-per-segment stand-in: only FULL names are persons. A surname-only
 *  mention ("Frau Weißenborn") is missed — exactly what the real sidecar did
 *  per segment, while the whole-text pass caught it from another turn. */
function fullNameOnlyC1(seen: string[] = []): PromptPiiDetector {
  const FULL = /\b(?:Helga Weißenborn|Karl-Heinz Öztürk)\b/gu;
  return {
    id: 'c1-test',
    async detect(text: string): Promise<readonly PromptPiiSpan[]> {
      seen.push(text);
      return [...text.matchAll(FULL)].map((m) => ({
        start: m.index,
        end: m.index + m[0].length,
        type: 'person',
        confidence: 0.83,
      }));
    },
  };
}

describe('PrivacyGuardService — person-name propagation across segments', () => {
  const A = turnChunk('2026-10-02T09:00:00Z', 'Wer ist Helga Weißenborn?', 'Die Teamleitung.');
  const B = turnChunk('2026-10-02T09:05:00Z', 'Ruf Frau Weißenborn an.', 'Erledigt.');

  it('masks a surname-only mention in another segment (whole-text parity regression)', async () => {
    const result = await maskTail(svcWith(fullNameOnlyC1()), 't-1', [HEADER, A, B]);
    assert.equal(result.outcome, 'masked');
    assert.ok(result.outcome === 'masked' && !result.maskedText.includes('Weißenborn'),
      result.outcome === 'masked' ? result.maskedText : '');
    assert.ok(result.outcome === 'masked' && result.maskedText.includes('Frau '),
      'the honorific itself stays');
  });

  it('propagates on cached (warm) turns too — cached and uncached results are identical', async () => {
    const seen: string[] = [];
    const svc = svcWith(fullNameOnlyC1(seen));
    const cold = await maskTail(svc, 't-1', [HEADER, A, B]);
    await svc.finalizeTurn('t-1');
    seen.length = 0;
    const warm = await maskTail(svc, 't-2', [HEADER, A, B]);
    assert.deepEqual(seen, [], 'served from cache');
    assert.deepEqual(warm, cold);
  });

  it('never matches inside a longer word', async () => {
    const C = turnChunk('2026-10-02T09:10:00Z', 'Die Weißenborner Straße?', 'Ja.');
    const result = await maskTail(svcWith(fullNameOnlyC1()), 't-1', [HEADER, A, C]);
    assert.ok(result.outcome === 'masked' && result.maskedText.includes('Weißenborner Straße'),
      result.outcome === 'masked' ? result.maskedText : '');
  });

  it('does not propagate honorifics, short or lower-case tokens', async () => {
    const D = turnChunk('2026-10-02T09:00:00Z', 'Termin mit Frau Helga Weißenborn', 'Ok.');
    const E = turnChunk('2026-10-02T09:05:00Z', 'Frau Meier und Herr Dr. Lang kommen auch.', 'Gut.');
    const detector: PromptPiiDetector = {
      id: 'c1-test',
      // A span that (like GLiNER sometimes does) includes the honorific.
      async detect(text) {
        const at = text.indexOf('Frau Helga Weißenborn');
        return at < 0
          ? []
          : [{ start: at, end: at + 'Frau Helga Weißenborn'.length, type: 'person', confidence: 0.8 }];
      },
    };
    const result = await maskTail(svcWith(detector), 't-1', [HEADER, D, E]);
    assert.ok(result.outcome === 'masked');
    const masked = result.outcome === 'masked' ? result.maskedText : '';
    assert.ok(masked.includes('Frau Meier und Herr Dr. Lang'), masked);
  });

  it('the whole-text path is unchanged (no propagation outside the segmented path)', async () => {
    const result = await maskTail(svcWith(fullNameOnlyC1()), 't-1', undefined, [HEADER, A, B].join(''));
    assert.ok(result.outcome === 'masked' && result.maskedText.includes('Frau Weißenborn'));
  });
});

describe('propagatePersonNames — unit', () => {
  const text = 'Helga Weißenborn; später Frau Weißenborn, Weißenborner Str., WEISSENBORN, Helga.';
  const source: PromptPiiSpan = { start: 0, end: 16, type: 'person', confidence: 0.83 };

  it('adds only uncovered whole-word occurrences, with the source confidence', () => {
    const out = propagatePersonNames(text, [source]);
    const added = out.filter((s) => s !== source).map((s) => text.slice(s.start, s.end));
    assert.deepEqual(added.sort(), ['Helga', 'Weißenborn'].sort());
    for (const s of out) assert.equal(s.confidence, 0.83);
    assert.deepEqual([...out].sort((a, b) => a.start - b.start), out, 'sorted by start');
  });

  it('ignores non-person spans and leaves its input untouched', () => {
    const input: readonly PromptPiiSpan[] = Object.freeze([{ ...source, type: 'address' }]);
    assert.deepEqual(propagatePersonNames(text, input), input);
  });
});

describe('c1SegmentCache — bounded LRU, no plaintext keys', () => {
  const span = (start: number): PromptPiiSpan => ({
    start,
    end: start + 1,
    type: 'person',
    confidence: 0.9,
  });

  it('keys are sha256 hex and carry no segment text', () => {
    const key = c1SegmentKey('c1-gliner', 'http://pii:8080', 'Anna Schmidt');
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.notEqual(key, c1SegmentKey('c1-gliner', 'http://pii:8080', 'Anna Schmidt '));
    assert.notEqual(key, c1SegmentKey('c1-gliner', 'http://other:8080', 'Anna Schmidt'));
    assert.notEqual(key, c1SegmentKey('c1-other', 'http://pii:8080', 'Anna Schmidt'));
  });

  it('evicts the least-recently-used entry beyond maxEntries', () => {
    const cache = createC1SegmentCache({ maxEntries: 2, maxSpans: 100 });
    cache.set('a', [span(0)]);
    cache.set('b', [span(1)]);
    assert.ok(cache.get('a'), 'touch a');
    cache.set('c', [span(2)]);
    assert.equal(cache.get('b'), undefined, 'b was least recently used');
    assert.ok(cache.get('a'));
    assert.ok(cache.get('c'));
    assert.equal(cache.size, 2);
  });

  it('evicts by total span count beyond maxSpans', () => {
    const cache = createC1SegmentCache({ maxEntries: 100, maxSpans: 3 });
    cache.set('a', [span(0), span(1)]);
    cache.set('b', [span(2), span(3)]);
    assert.equal(cache.get('a'), undefined);
    assert.equal(cache.get('b')?.length, 2);
    cache.set('huge', [span(0), span(1), span(2), span(3)]);
    assert.equal(cache.get('huge'), undefined, 'an entry larger than the cap is not kept');
    assert.equal(cache.get('b')?.length, 2);
  });

  it('stores copies, so a caller mutating its array cannot poison the cache', () => {
    const cache = createC1SegmentCache({ maxEntries: 10, maxSpans: 10 });
    const spans = [span(0)];
    cache.set('a', spans);
    spans.push(span(5));
    assert.equal(cache.get('a')?.length, 1);
  });
});
