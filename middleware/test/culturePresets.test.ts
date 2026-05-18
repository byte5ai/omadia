import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  CULTURE_PRESETS,
  applyCulturePreset,
  getCulturePreset,
  type CulturePresetId,
} from '../src/plugins/builder/culturePresets.ts';

describe('CULTURE_PRESETS registry (issue #59)', () => {
  it('ships 6 industry presets', () => {
    assert.equal(CULTURE_PRESETS.length, 6);
    const ids = CULTURE_PRESETS.map((p) => p.id).sort();
    assert.deepEqual(ids, [
      'creative-agency',
      'ecommerce',
      'enterprise-corporate',
      'healthcare',
      'legal',
      'saas-startup',
    ]);
  });

  it('every preset has an i18n labelKey of culture.<id>', () => {
    for (const p of CULTURE_PRESETS) {
      assert.equal(p.labelKey, `culture.${p.id}`);
    }
  });

  it('every preset has a non-empty descriptionDe', () => {
    for (const p of CULTURE_PRESETS) {
      assert.ok(p.descriptionDe.length > 0, `${p.id}: empty descriptionDe`);
    }
  });

  it('preset dimensions are a Partial<PersonaAxes> with axis values in [0,100]', () => {
    for (const p of CULTURE_PRESETS) {
      for (const [axis, value] of Object.entries(p.dimensions)) {
        assert.equal(typeof value, 'number', `${p.id}.${axis} not a number`);
        assert.ok(
          value! >= 0 && value! <= 100,
          `${p.id}.${axis}: ${value} out of [0,100]`,
        );
      }
    }
  });

  it('snapshot — saas-startup matches kemia verbatim', () => {
    const saas = getCulturePreset('saas-startup');
    assert.ok(saas);
    assert.deepEqual(saas.dimensions, {
      formality: 30,
      directness: 75,
      warmth: 55,
      humor: 40,
      conciseness: 75,
      proactivity: 80,
      autonomy: 70,
      risk_tolerance: 60,
      creativity: 65,
    });
  });

  it('snapshot — legal preset is the most formal + lowest risk-tolerance', () => {
    const legal = getCulturePreset('legal');
    assert.ok(legal);
    assert.equal(legal.dimensions.formality, 90);
    assert.equal(legal.dimensions.risk_tolerance, 5);
  });
});

describe('getCulturePreset', () => {
  it('returns undefined for unknown id', () => {
    assert.equal(getCulturePreset('does-not-exist'), undefined);
  });

  it('returns the preset for a valid id', () => {
    const p = getCulturePreset('healthcare');
    assert.ok(p);
    assert.equal(p.id, 'healthcare');
  });
});

describe('applyCulturePreset', () => {
  it('overlays preset values on top of existing axes', () => {
    const merged = applyCulturePreset(
      { directness: 80, warmth: 30 },
      'enterprise-corporate',
    );
    // Existing axes overwritten by preset values
    assert.equal(merged.directness, 45);
    assert.equal(merged.warmth, 50);
    // Axes the preset doesn't touch stay unchanged — but enterprise-corporate
    // touches formality/directness/warmth/humor/sarcasm/conciseness/proactivity/
    // autonomy/risk_tolerance/creativity, so the test needs an axis preset
    // doesn't set. drama is not in enterprise-corporate's overlay.
    const startWithDrama = applyCulturePreset(
      { directness: 80, drama: 90 },
      'enterprise-corporate',
    );
    assert.equal(startWithDrama.drama, 90);
  });

  it('returns a copy — does not mutate the input', () => {
    const base = { directness: 80 };
    const merged = applyCulturePreset(base, 'saas-startup');
    assert.equal(base.directness, 80, 'input mutated');
    assert.notStrictEqual(merged, base, 'returned reference equals input');
  });

  it('returns a shallow copy of existing for unknown preset id', () => {
    const merged = applyCulturePreset({ directness: 80 }, 'mystery-id');
    assert.deepEqual(merged, { directness: 80 });
  });

  it('handles undefined existing input', () => {
    const merged = applyCulturePreset(undefined, 'creative-agency');
    assert.equal(merged.creativity, 85);
    assert.equal(merged.drama, 50);
  });
});

describe('preset id type — compile-time invariant smoke (issue #59)', () => {
  it('id literal narrows to CulturePresetId', () => {
    const id: CulturePresetId = 'saas-startup';
    assert.ok(getCulturePreset(id));
  });
});
