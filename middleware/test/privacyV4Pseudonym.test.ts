/**
 * Privacy Shield v4 — US7 Pseudonym Projection tests.
 *
 * Stable, realistic pseudonyms for masked fields; no pseudonym collides with
 * a real value (C5); project → resolve round-trips back to real values.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createDatasetStore } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';
import { buildDigest } from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import {
  createPseudonymMap,
  projectDataset,
  resolvePseudonyms,
} from '@omadia/plugin-privacy-guard/dist/v4/pseudonym.js';
import type { Dataset } from '@omadia/plugin-privacy-guard/dist/v4/types.js';

const HR_LEAVE = [
  { employee: 'Marvin Vomberg', days: 24 },
  { employee: 'Anna Rüsche', days: 30 },
  { employee: 'Thomas Görres', days: 18 },
];

function dataset(rows: unknown): Dataset {
  const store = createDatasetStore({
    classify: createShapeClassifier(),
    buildDigest,
    turnId: 'turn-test',
  });
  const { datasetId } = store.internToolResult('hr.leave', rows);
  const ds = store.get(datasetId);
  assert.ok(ds);
  return ds;
}

describe('createPseudonymMap', () => {
  it('assigns one distinct pseudonym per real value, bijectively', () => {
    const map = createPseudonymMap(['Marvin Vomberg', 'Anna Rüsche']);
    assert.equal(map.forward.size, 2);
    assert.equal(map.reverse.size, 2);
    for (const [real, fake] of map.forward) {
      assert.equal(map.reverse.get(fake), real);
    }
  });

  it('is deterministic — same input yields the same mapping', () => {
    const a = createPseudonymMap(['Anna Rüsche', 'Marvin Vomberg']);
    const b = createPseudonymMap(['Marvin Vomberg', 'Anna Rüsche']);
    assert.deepEqual([...a.forward.entries()], [...b.forward.entries()]);
  });

  it('never emits a pseudonym that equals a real value (C5)', () => {
    // "Lukas Becker" is the first pool candidate — must be skipped here.
    const map = createPseudonymMap(['Lukas Becker', 'Marvin Vomberg']);
    for (const fake of map.reverse.keys()) {
      assert.notEqual(fake, 'Lukas Becker');
      assert.notEqual(fake, 'Marvin Vomberg');
    }
    assert.notEqual(map.forward.get('Lukas Becker'), 'Lukas Becker');
  });
});

describe('projectDataset', () => {
  it('replaces masked fields with pseudonyms, leaves safe fields intact', () => {
    const { rows } = projectDataset(dataset(HR_LEAVE));
    assert.equal(rows.length, 3);
    for (let i = 0; i < rows.length; i++) {
      assert.notEqual(rows[i]?.employee, HR_LEAVE[i]?.employee);
      assert.equal(rows[i]?.days, HR_LEAVE[i]?.days); // safe field untouched
    }
  });

  it('leaves no real identity value in the projected rows', () => {
    const { rows } = projectDataset(dataset(HR_LEAVE));
    const json = JSON.stringify(rows);
    for (const r of HR_LEAVE) {
      assert.ok(!json.includes(r.employee), `leaked "${r.employee}"`);
    }
  });

  it('maps a repeated real value to the same pseudonym', () => {
    const repeated = [
      { employee: 'Marvin Vomberg', month: 'Jan' },
      { employee: 'Marvin Vomberg', month: 'Feb' },
    ];
    const { rows } = projectDataset(dataset(repeated));
    assert.equal(rows[0]?.employee, rows[1]?.employee);
  });
});

describe('resolvePseudonyms', () => {
  it('round-trips a projected value back to the real one', () => {
    const ds = dataset(HR_LEAVE);
    const { rows, map } = projectDataset(ds);
    const fakeName = String(rows[0]?.employee);
    const prose = `The top performer is ${fakeName}.`;
    assert.equal(
      resolvePseudonyms(prose, map),
      'The top performer is Marvin Vomberg.',
    );
  });
});
