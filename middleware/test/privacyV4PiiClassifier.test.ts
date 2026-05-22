/**
 * Privacy Shield v4 — schema-level PII classifier tests (Slice 2).
 *
 * Verifies the Haiku-backed schema classifier: a stable fingerprint, a
 * tolerant verdict parser, caching by schema, TTL re-classification, and
 * the fail-safe behaviour (an LLM error yields an empty verdict and is not
 * cached). The classifier is driven with a fake `complete` — no live LLM.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import {
  createPiiSchemaClassifier,
  parseClassifierVerdict,
  schemaFingerprint,
} from '@omadia/plugin-privacy-guard/dist/v4/piiClassifier.js';

const HR_LEAVE_FIELDS = [
  { path: 'employee', type: 'string' },
  { path: 'employee_id', type: 'id' },
  { path: 'state', type: 'enum' },
  { path: 'days', type: 'number' },
];

describe('schemaFingerprint', () => {
  it('is order-independent and tool-scoped', () => {
    const a = schemaFingerprint('hr.leave', HR_LEAVE_FIELDS);
    const b = schemaFingerprint('hr.leave', [...HR_LEAVE_FIELDS].reverse());
    const c = schemaFingerprint('hr.other', HR_LEAVE_FIELDS);
    assert.equal(a, b, 'field order must not change the fingerprint');
    assert.notEqual(a, c, 'the tool name is part of the fingerprint');
  });
});

describe('parseClassifierVerdict', () => {
  const known = new Set(['employee', 'employee_id', 'state', 'days']);

  it('parses a JSON array and intersects with the known field paths', () => {
    assert.deepEqual(
      [...parseClassifierVerdict('["employee","employee_id"]', known)].sort(),
      ['employee', 'employee_id'],
    );
  });

  it('tolerates surrounding prose', () => {
    assert.deepEqual(
      [...parseClassifierVerdict('Sure — ["employee"] is the one.', known)],
      ['employee'],
    );
  });

  it('drops a hallucinated field path not in the schema', () => {
    assert.deepEqual(
      [...parseClassifierVerdict('["employee","ghost_field"]', known)],
      ['employee'],
    );
  });

  it('returns empty for non-JSON or an empty array', () => {
    assert.equal(parseClassifierVerdict('no json here', known).size, 0);
    assert.equal(parseClassifierVerdict('[]', known).size, 0);
  });
});

describe('createPiiSchemaClassifier', () => {
  it('classifies once and caches by schema fingerprint', async () => {
    let calls = 0;
    const clf = createPiiSchemaClassifier({
      complete: async () => {
        calls += 1;
        return { text: '["employee","employee_id"]' };
      },
    });
    const a = await clf.classify('hr.leave', HR_LEAVE_FIELDS);
    // Reordered fields → same fingerprint → cache hit, no second LLM call.
    const b = await clf.classify('hr.leave', [...HR_LEAVE_FIELDS].reverse());
    assert.equal(calls, 1, 'the reordered second call hit the cache');
    assert.deepEqual([...a].sort(), ['employee', 'employee_id']);
    assert.deepEqual([...b].sort(), ['employee', 'employee_id']);
  });

  it('re-classifies after the TTL expires', async () => {
    let calls = 0;
    let clock = 1000;
    const clf = createPiiSchemaClassifier({
      complete: async () => {
        calls += 1;
        return { text: '[]' };
      },
      now: () => clock,
      ttlMs: 5000,
    });
    const fields = [{ path: 'state', type: 'enum' }];
    await clf.classify('hr.leave', fields);
    clock += 4000; // still within the TTL
    await clf.classify('hr.leave', fields);
    assert.equal(calls, 1, 'within TTL → served from cache');
    clock += 2000; // 6000 elapsed > 5000 TTL
    await clf.classify('hr.leave', fields);
    assert.equal(calls, 2, 're-classified after the TTL expired');
  });

  it('returns an empty verdict on an LLM error and does not cache it', async () => {
    let calls = 0;
    const clf = createPiiSchemaClassifier({
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new Error('haiku unavailable');
        return { text: '["employee"]' };
      },
    });
    const fields = [{ path: 'employee', type: 'string' }];
    const first = await clf.classify('hr.leave', fields);
    assert.equal(first.size, 0, 'an LLM error yields an empty verdict');
    const second = await clf.classify('hr.leave', fields);
    assert.equal(calls, 2, 'the failure was not cached — the next call retried');
    assert.deepEqual([...second], ['employee']);
  });

  it('skips the LLM entirely for an empty field list', async () => {
    let calls = 0;
    const clf = createPiiSchemaClassifier({
      complete: async () => {
        calls += 1;
        return { text: '[]' };
      },
    });
    const verdict = await clf.classify('hr.leave', []);
    assert.equal(calls, 0);
    assert.equal(verdict.size, 0);
  });
});
