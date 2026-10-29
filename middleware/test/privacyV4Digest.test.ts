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

describe('Digest — nested fields and the subject-sentence rule (#1542, #1556)', () => {
  const PAGE = {
    id: 98765,
    title: 'Kontaktliste Testteam',
    body: { view: { value: '<p>Jonas Weber, jonas.weber@example.com</p>', representation: 'view' } },
    version: { number: 3, by: { displayName: 'Jonas Weber' } },
  };

  it('marks a nested-object field "shape":"nested", masked, without any value', () => {
    const { digest } = newStore().internToolResult('confluence_get_page', [PAGE]);
    const body = fieldOf(digest, 'body');
    assert.equal(body.classification, 'sensitive-masked');
    assert.equal((body as { shape?: string }).shape, 'nested');
    const text = digestToToolResultText(digest);
    for (const value of ['Jonas', 'Weber', 'jonas.weber@example.com']) {
      assert.ok(!text.includes(value), `digest text leaked "${value}"`);
    }
    assert.ok(text.includes('"shape":"nested"'));
    assert.ok(text.includes('Never promise its verbatim'), 'the model is told not to promise content');
  });

  it('a scalar masked field carries no shape hint', () => {
    const { digest } = newStore().internToolResult('hr.leave', HR_LEAVE);
    assert.equal((fieldOf(digest, 'employee') as { shape?: string }).shape, undefined);
  });

  it('tells the model to point to the table when a masked field is the subject', () => {
    const { digest } = newStore().internToolResult('hr.leave', HR_LEAVE);
    const text = digestToToolResultText(digest);
    assert.ok(text.includes('When a masked field is the SUBJECT of the answer'), text);
    assert.ok(text.includes('steht in der Tabelle'));
  });
});

describe('Digest — public API audience (#1561)', () => {
  it('names no tool the caller lacks, drops the datasetId, keeps every value masked', () => {
    const { digest } = newStore().internToolResult('query_odoo_hr', HR_LEAVE);
    const text = digestToToolResultText(digest, { audience: 'public-api' });
    for (const banned of ['v4_', 'verb tools', 'datasetId', digest.datasetId, 'Vomberg', 'Rüsche']) {
      assert.ok(!text.includes(banned), `public text carries "${banned}"`);
    }
    assert.ok(text.includes('Returned: 3 rows'), text);
    assert.ok(text.includes('Withheld: the values of ["employee"'), text);
  });

  it('says a prose answer is one masked text field, not a record count', () => {
    const { digest } = newStore().internToolResult('query_odoo_hr', 'Paul Williams and 6 others work in R&D.');
    const text = digestToToolResultText(digest, { audience: 'public-api' });
    assert.ok(text.includes('answered in prose'), text);
    assert.ok(!text.includes('Paul Williams'));
  });

  it('the chat audience keeps the verb-tool header', () => {
    const { digest } = newStore().internToolResult('hr.leave', HR_LEAVE);
    assert.ok(digestToToolResultText(digest, { audience: 'chat' }).includes('v4_render_answer'));
  });
});
