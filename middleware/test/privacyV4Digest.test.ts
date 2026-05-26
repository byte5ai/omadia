/**
 * Privacy Shield v4 — US3 Digest builder tests.
 *
 * Integration of US1 (store) + US2 (classifier) + US3 (digest): the digest
 * the LLM would receive must be identity-free (invariant I1) and bounded by
 * shape (invariant I2).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createDatasetStore } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';
import {
  buildDigest,
  digestToToolResultText,
} from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import type {
  Digest,
  FieldDigest,
} from '@omadia/plugin-privacy-guard/dist/v4/types.js';

function newStore(maxInternChars?: number) {
  return createDatasetStore({
    classify: createShapeClassifier(),
    buildDigest,
    turnId: 'turn-test',
    ...(maxInternChars !== undefined ? { maxInternChars } : {}),
  });
}

function fieldOf(digest: Digest, path: string): FieldDigest {
  const f = digest.fields.find((x) => x.path === path);
  assert.ok(f, `field "${path}" missing from digest`);
  return f;
}

const HR_LEAVE = [
  { employee: 'Marvin Vomberg', employee_id: '4471', days: 24 },
  { employee: 'Anna Rüsche', employee_id: '5582', days: 30 },
  { employee: 'Thomas Görres', employee_id: '6693', days: 18 },
];
const REAL_NAMES = ['Vomberg', 'Rüsche', 'Görres', 'Marvin', 'Anna', 'Thomas'];

describe('Digest builder — identity-free invariant (I1)', () => {
  it('masked fields carry a placeholder + count, never a value', () => {
    const { digest } = newStore().internToolResult('hr.leave', HR_LEAVE);
    const emp = fieldOf(digest, 'employee');
    assert.equal(emp.classification, 'sensitive-masked');
    if (emp.classification !== 'sensitive-masked') return;
    assert.equal(emp.distinctCount, 3);
    assert.ok(emp.placeholder.length > 0);
    assert.ok(!('values' in emp));
    assert.ok(!('summary' in emp));
  });

  it('no real identity value appears anywhere in the digest', () => {
    const { digest } = newStore().internToolResult('hr.leave', HR_LEAVE);
    const json = JSON.stringify(digest);
    for (const name of REAL_NAMES) {
      assert.ok(!json.includes(name), `digest leaked "${name}"`);
    }
  });

  it('no real identity value appears in the tool_result text', () => {
    const { digest } = newStore().internToolResult('hr.leave', HR_LEAVE);
    const text = digestToToolResultText(digest);
    assert.ok(text.includes(digest.datasetId));
    assert.ok(text.includes('[privacy-shield-v4]'));
    for (const name of REAL_NAMES) {
      assert.ok(!text.includes(name), `tool_result text leaked "${name}"`);
    }
  });
});

describe('Digest builder — safe-cleartext fields', () => {
  it('inlines row-aligned values for a small dataset', () => {
    const { digest } = newStore().internToolResult('hr.leave', HR_LEAVE);
    const days = fieldOf(digest, 'days');
    assert.equal(days.classification, 'safe-cleartext');
    if (days.classification !== 'safe-cleartext') return;
    assert.deepEqual(days.values, [24, 30, 18]);
  });

  it('summarizes a numeric field for a large dataset', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ score: i }));
    const { digest } = newStore().internToolResult('metrics', rows);
    const score = fieldOf(digest, 'score');
    assert.equal(score.classification, 'safe-cleartext');
    if (score.classification !== 'safe-cleartext') return;
    assert.ok(!('values' in score));
    assert.equal(score.summary?.min, 0);
    assert.equal(score.summary?.max, 59);
  });

  it('summarizes an enum field for a large dataset', () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({
      status: i % 2 === 0 ? 'approved' : 'pending',
    }));
    const { digest } = newStore().internToolResult('reqs', rows);
    const status = fieldOf(digest, 'status');
    assert.equal(status.classification, 'safe-cleartext');
    if (status.classification !== 'safe-cleartext') return;
    assert.deepEqual(
      [...(status.summary?.distinctValues ?? [])].sort(),
      ['approved', 'pending'],
    );
  });
});

describe('Digest builder — metadata', () => {
  it('reports row count and propagates the truncation flag', () => {
    const full = newStore().internToolResult('hr.leave', HR_LEAVE);
    assert.equal(full.digest.rowCount, 3);
    assert.equal(full.digest.truncated, false);

    const bounded = newStore(60).internToolResult('hr.leave', HR_LEAVE);
    assert.equal(bounded.digest.truncated, true);
  });
});
