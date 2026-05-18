import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import {
  BOUNDARY_PRESETS,
  BOUNDARY_LABELS_DE,
  compileBoundaries,
  compileBoundariesSection,
  getBoundaryPreset,
} from '../src/plugins/builder/boundaryPresets.ts';

describe('boundary preset registry (issue #54)', () => {
  it('ships 12 presets across 4 categories (kemia @ main)', () => {
    // The issue description mentions "14"; kemia currently ships 12.
    // The byte-identical AC asserts whatever kemia carries — locking
    // the count here to flag drift on either side.
    assert.equal(BOUNDARY_PRESETS.length, 12);

    const byCategory = {
      data: 0,
      scope: 0,
      authority: 0,
      communication: 0,
    } as Record<string, number>;
    for (const p of BOUNDARY_PRESETS) {
      byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
    }
    assert.deepEqual(byCategory, {
      data: 4,
      scope: 3,
      authority: 3,
      communication: 2,
    });
  });

  it('every preset id is unique', () => {
    const ids = BOUNDARY_PRESETS.map((p) => p.id);
    assert.equal(new Set(ids).size, ids.length, 'duplicate preset id');
  });

  it('every preset has a non-empty prompt and matching label key', () => {
    for (const p of BOUNDARY_PRESETS) {
      assert.ok(p.prompt.length > 0, `${p.id}: empty prompt`);
      assert.match(p.labelKey, /^preset[A-Z]/, `${p.id}: bad labelKey`);
      assert.ok(
        BOUNDARY_LABELS_DE[p.labelKey],
        `${p.id}: missing DE label for ${p.labelKey}`,
      );
    }
  });

  it('getBoundaryPreset returns undefined for unknown id', () => {
    assert.equal(getBoundaryPreset('does-not-exist'), undefined);
    assert.ok(getBoundaryPreset('no-pii'));
  });
});

describe('compileBoundaries (issue #54)', () => {
  it('returns empty text and no drops for empty input', () => {
    const { text, droppedIds } = compileBoundaries([], []);
    assert.equal(text, '');
    assert.deepEqual(droppedIds, []);
  });

  it('joins preset prompts in input order, line-separated', () => {
    const { text, droppedIds } = compileBoundaries(['no-pii', 'no-medical-data'], []);
    assert.deepEqual(droppedIds, []);
    assert.match(text, /personally identifiable information/);
    assert.match(text, /medical diagnoses/);
    // Ordering: no-pii prompt comes before no-medical-data prompt
    const piiIdx = text.indexOf('personally identifiable');
    const medIdx = text.indexOf('medical diagnoses');
    assert.ok(piiIdx >= 0 && piiIdx < medIdx, 'preset order not preserved');
  });

  it('renders custom lines with the "You must NOT:" prefix, trimming whitespace', () => {
    const { text } = compileBoundaries([], ['  promise refunds  ', '', 'leak internal data']);
    assert.match(text, /You must NOT: promise refunds/);
    assert.match(text, /You must NOT: leak internal data/);
    // Empty / whitespace-only entries are skipped (do not produce a "You must NOT: " bare line)
    assert.equal(text.split('You must NOT:').length - 1, 2);
  });

  it('reports unknown preset IDs via droppedIds instead of silently dropping', () => {
    const { text, droppedIds } = compileBoundaries(
      ['no-pii', 'unknown-thing', 'also-not-real', 'no-commitments'],
      [],
    );
    assert.deepEqual(droppedIds, ['unknown-thing', 'also-not-real']);
    // The two valid presets still made it through
    assert.match(text, /personally identifiable information/);
    assert.match(text, /binding commitments/);
  });

  it('snapshot — compileBoundaries output is deterministic across calls', () => {
    const a = compileBoundaries(['no-pii', 'no-speculation'], ['be honest']);
    const b = compileBoundaries(['no-pii', 'no-speculation'], ['be honest']);
    assert.deepEqual(a, b);
  });
});

describe('compileBoundariesSection (issue #54)', () => {
  it("returns '' (and no droppedIds churn) when no presets and no custom lines", () => {
    const { text, droppedIds } = compileBoundariesSection([], []);
    assert.equal(text, '');
    assert.deepEqual(droppedIds, []);
  });

  it('prepends a "## Boundaries" header when content is present', () => {
    const { text } = compileBoundariesSection(['no-pii'], []);
    assert.match(text, /^## Boundaries\n/);
    assert.match(text, /personally identifiable information/);
  });

  it('byte-identical output for the same inputs (cache stability AC)', () => {
    const a = compileBoundariesSection(['no-pii', 'no-legal-advice'], ['no off-topic chitchat']);
    const b = compileBoundariesSection(['no-pii', 'no-legal-advice'], ['no off-topic chitchat']);
    assert.equal(a.text, b.text);
  });
});
