import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  FAMILY_DEFAULTS,
  computePersonaDeltas,
  significantDeltas,
  NEUTRAL_THRESHOLD,
  STRONG_THRESHOLD,
} from '../src/plugins/personaDelta.js';

/**
 * Phase 3 / OB-67 Slice 8 — family-defaults + delta-compute tests.
 */
describe('FAMILY_DEFAULTS', () => {
  it('covers all 12 axes for every family', () => {
    const expected = [
      'formality',
      'directness',
      'warmth',
      'humor',
      'sarcasm',
      'conciseness',
      'proactivity',
      'autonomy',
      'risk_tolerance',
      'creativity',
      'drama',
      'philosophy',
    ];
    for (const family of ['sonnet', 'opus', 'haiku'] as const) {
      const keys = Object.keys(FAMILY_DEFAULTS[family]).sort();
      assert.deepEqual(keys, [...expected].sort());
      // All values in 0–100
      for (const v of Object.values(FAMILY_DEFAULTS[family])) {
        assert.ok(v >= 0 && v <= 100, `${family} axis out of range: ${v}`);
      }
    }
  });

  it('Haiku is more concise than Opus by design', () => {
    assert.ok(
      FAMILY_DEFAULTS.haiku.conciseness > FAMILY_DEFAULTS.opus.conciseness,
      'Haiku should default to higher conciseness than Opus',
    );
  });

  it('Opus is more philosophical than Haiku by design', () => {
    assert.ok(
      FAMILY_DEFAULTS.opus.philosophy > FAMILY_DEFAULTS.haiku.philosophy,
    );
  });
});

describe('computePersonaDeltas', () => {
  it('returns empty array for undefined axes', () => {
    assert.deepEqual(computePersonaDeltas(undefined, 'sonnet'), []);
  });

  it('skips axes that are not set (inherit family default)', () => {
    const out = computePersonaDeltas({ directness: 80 }, 'sonnet');
    assert.equal(out.length, 1);
    assert.equal(out[0]!.axis, 'directness');
  });

  it('classifies delta within NEUTRAL_THRESHOLD as neutral', () => {
    const base = FAMILY_DEFAULTS.sonnet.directness;
    const out = computePersonaDeltas({ directness: base + NEUTRAL_THRESHOLD }, 'sonnet');
    assert.equal(out[0]!.magnitude, 'neutral');
  });

  it('classifies delta at STRONG_THRESHOLD as strong', () => {
    const base = FAMILY_DEFAULTS.sonnet.directness;
    const out = computePersonaDeltas({ directness: base + STRONG_THRESHOLD }, 'sonnet');
    assert.equal(out[0]!.magnitude, 'strong');
  });

  it('classifies between thresholds as slightly', () => {
    const base = FAMILY_DEFAULTS.sonnet.directness;
    const out = computePersonaDeltas(
      { directness: base + NEUTRAL_THRESHOLD + 5 },
      'sonnet',
    );
    assert.equal(out[0]!.magnitude, 'slightly');
  });

  it('captures direction (lower / higher)', () => {
    const base = FAMILY_DEFAULTS.sonnet.directness;
    const lower = computePersonaDeltas({ directness: base - 40 }, 'sonnet');
    const higher = computePersonaDeltas({ directness: base + 40 }, 'sonnet');
    assert.equal(lower[0]!.direction, 'lower');
    assert.equal(higher[0]!.direction, 'higher');
  });

  it('signed delta carries through', () => {
    const base = FAMILY_DEFAULTS.sonnet.warmth; // 60
    const out = computePersonaDeltas({ warmth: 30 }, 'sonnet');
    assert.equal(out[0]!.delta, 30 - base);
  });

  it('different families produce different deltas for the same axis value', () => {
    const sonnetOut = computePersonaDeltas({ conciseness: 50 }, 'sonnet');
    const haikuOut = computePersonaDeltas({ conciseness: 50 }, 'haiku');
    // Sonnet conciseness=45, Haiku conciseness=65 — same input 50 produces opposite directions.
    assert.equal(sonnetOut[0]!.direction, 'higher');
    assert.equal(haikuOut[0]!.direction, 'lower');
  });

  it('handles all 12 axes when set', () => {
    const allAxes = {
      formality: 80,
      directness: 80,
      warmth: 20,
      humor: 90,
      sarcasm: 90,
      conciseness: 90,
      proactivity: 90,
      autonomy: 90,
      risk_tolerance: 90,
      creativity: 90,
      drama: 90,
      philosophy: 90,
    };
    const out = computePersonaDeltas(allAxes, 'sonnet');
    assert.equal(out.length, 12);
  });

  it('ignores non-finite axis values', () => {
    const out = computePersonaDeltas(
      { directness: NaN } as unknown as { directness: number },
      'sonnet',
    );
    assert.equal(out.length, 0);
  });
});

describe('significantDeltas', () => {
  it('drops neutral deltas', () => {
    const base = FAMILY_DEFAULTS.sonnet;
    const all = computePersonaDeltas(
      {
        directness: base.directness + 5, // neutral
        warmth: base.warmth - 40, // strong
        humor: base.humor + 20, // slightly
      },
      'sonnet',
    );
    const sig = significantDeltas(all);
    assert.equal(sig.length, 2);
    assert.ok(sig.every((d) => d.magnitude !== 'neutral'));
  });

  it('returns empty when all deltas are neutral', () => {
    const out = significantDeltas(
      computePersonaDeltas({ directness: FAMILY_DEFAULTS.sonnet.directness }, 'sonnet'),
    );
    assert.deepEqual(out, []);
  });
});
