/**
 * #1543 — the provenance note of a render is model-bound and persisted with
 * the turn, so it must never carry a value: no row cell, no filter literal.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  describePredicate,
  describeVerbStep,
} from '@omadia/plugin-privacy-guard/dist/v4/renderProvenance.js';

describe('render provenance — structure only', () => {
  it('hides every predicate literal, keeps fields and ops', () => {
    const text = describePredicate({
      op: 'and',
      clauses: [
        { op: 'eq', field: 'department', value: 'Research & Development' },
        { op: 'in', field: 'level', values: [4711, 4712] },
        { op: 'not', clause: { op: 'between', field: 'age', lo: 31, hi: 59 } },
      ],
    });
    assert.equal(text, '(`department` eq … and `level` in […] and not `age` between … and …)');
    for (const literal of ['Research', '4711', '4712', '31', '59']) {
      assert.ok(!text.includes(literal), `literal "${literal}" in the note`);
    }
  });

  it('describes the other verbs by fields, directions and n', () => {
    assert.equal(describeVerbStep('sort', { by: 'name', direction: 'asc' }), 'sort by `name` asc');
    assert.equal(describeVerbStep('top_n', { n: 5, by: 'days', direction: 'desc' }), 'top_n 5 by `days` desc');
    assert.equal(
      describeVerbStep('aggregate', { params: { groupBy: ['dept'], ops: [{ alias: 'n', fn: 'count' }] } }),
      'aggregate count() as `n` by `dept`',
    );
    assert.equal(describeVerbStep('distinct', { by: ['__k_Mail'], keep: 'last' }), 'distinct by `__k_Mail` keep last');
    assert.equal(describeVerbStep('union', { multiSource: true }), 'union with another dataset');
  });
});
