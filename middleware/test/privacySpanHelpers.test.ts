import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  extendHitSpanForward,
  extendHitsToWordBoundary,
} from '@omadia/plugin-privacy-guard/dist/spanHelpers.js';

// ---------------------------------------------------------------------------
// Word-boundary span extension. The fix for the v0.2.0 deploy observation
// that Presidio's German NER systematically clips the final character of
// compound names ("Schmidt" → "Schmid", "Wege" → "Weg"), leaking the
// suffix next to the masked token.
// ---------------------------------------------------------------------------

describe('extendHitSpanForward (Privacy-Shield v2)', () => {
  it('extends a clipped name span to the next word boundary', () => {
    const text = 'Marcel Weg, Stefan';
    const hit = { span: [0, 10] as const, value: 'Marcel Weg' };
    const extended = extendHitSpanForward(text, hit);
    // No extension — "g" is followed by "," which is a non-word char.
    assert.equal(extended.span[1], 10);
    assert.equal(extended.value, 'Marcel Weg');
  });

  it('absorbs a single-letter trailing remnant (Schmidt-pattern)', () => {
    const text = 'Christoph Schmidt';
    const hit = { span: [0, 16] as const, value: 'Christoph Schmid' };
    const extended = extendHitSpanForward(text, hit);
    assert.equal(extended.span[1], 17);
    assert.equal(extended.value, 'Christoph Schmidt');
  });

  it('absorbs Wege-pattern (final e)', () => {
    const text = 'Marcel Wege ist heute abwesend.';
    const hit = { span: [0, 10] as const, value: 'Marcel Weg' };
    const extended = extendHitSpanForward(text, hit);
    assert.equal(extended.span[1], 11);
    assert.equal(extended.value, 'Marcel Wege');
  });

  it('handles German umlauts (Müller, Söhne)', () => {
    const text = 'Stefan Müller';
    const hit = { span: [0, 11] as const, value: 'Stefan Müll' };
    const extended = extendHitSpanForward(text, hit);
    assert.equal(extended.span[1], 13);
    assert.equal(extended.value, 'Stefan Müller');
  });

  it('no-op when the next char is already a boundary', () => {
    const text = 'Marcel Wege.';
    const hit = { span: [0, 11] as const, value: 'Marcel Wege' };
    const extended = extendHitSpanForward(text, hit);
    assert.equal(extended, hit);
  });

  it('no-op at end of input', () => {
    const text = 'Marcel Wege';
    const hit = { span: [0, 11] as const, value: 'Marcel Wege' };
    const extended = extendHitSpanForward(text, hit);
    assert.equal(extended, hit);
  });
});

describe('extendHitsToWordBoundary (Privacy-Shield v2)', () => {
  it('returns the original array reference when nothing changes', () => {
    const text = 'a, b, c';
    const hits = [
      { span: [0, 1] as const, value: 'a' },
      { span: [3, 4] as const, value: 'b' },
    ];
    const out = extendHitsToWordBoundary(text, hits);
    assert.equal(out, hits);
  });

  it('extends every clipped hit while preserving order', () => {
    const text = 'Marcel Wege und Christoph Schmidt';
    const hits = [
      { span: [0, 10] as const, value: 'Marcel Weg' },
      { span: [16, 32] as const, value: 'Christoph Schmid' },
    ];
    const out = extendHitsToWordBoundary(text, hits);
    assert.equal(out[0]?.value, 'Marcel Wege');
    assert.equal(out[1]?.value, 'Christoph Schmidt');
  });

  it('returns empty input untouched', () => {
    const out = extendHitsToWordBoundary('any text', []);
    assert.deepEqual(out, []);
  });
});
