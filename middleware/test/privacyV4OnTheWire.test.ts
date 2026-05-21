/**
 * Privacy Shield v4 — US4 on-the-wire confidentiality harness tests.
 *
 * Proves the harness detects identity values anywhere in an LLM-bound payload
 * (system prompt, message history, tool_result blocks), and that a v4-produced
 * payload — digest in place of raw rows — is identity-free (SC-003, SC-006).
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createDatasetStore } from '@omadia/plugin-privacy-guard/dist/v4/datasetStore.js';
import { createShapeClassifier } from '@omadia/plugin-privacy-guard/dist/v4/shapeClassifier.js';
import {
  buildDigest,
  digestToToolResultText,
} from '@omadia/plugin-privacy-guard/dist/v4/digest.js';
import {
  assertNoIdentityOnWire,
  findIdentityLeaks,
} from '@omadia/plugin-privacy-guard/dist/v4/onTheWire.js';

const HR_LEAVE = [
  { employee: 'Marvin Vomberg', employee_id: '4471', days: 24 },
  { employee: 'Anna Rüsche', employee_id: '5582', days: 30 },
  { employee: 'Thomas Görres', employee_id: '6693', days: 18 },
];
const REAL_NAMES = ['Marvin Vomberg', 'Anna Rüsche', 'Thomas Görres'];

/** An Anthropic-shaped messages.create payload with one tool_result block. */
function llmParams(toolResultContent: string) {
  return {
    system: 'You are an HR assistant. Answer the user question precisely.',
    messages: [
      { role: 'user', content: 'Wer hat dieses Jahr den meisten Urlaub?' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'hr.leave', input: {} }],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: toolResultContent },
        ],
      },
    ],
  };
}

function v4DigestText(rows: unknown): string {
  const store = createDatasetStore({
    classify: createShapeClassifier(),
    buildDigest,
    turnId: 'turn-test',
  });
  return digestToToolResultText(store.internToolResult('hr.leave', rows).digest);
}

describe('on-the-wire harness — leak detection', () => {
  it('detects an identity value in the system prompt', () => {
    const leaks = findIdentityLeaks(
      { system: 'Note: Marvin Vomberg is the manager.', messages: [] },
      REAL_NAMES,
    );
    assert.equal(leaks.length, 1);
    assert.equal(leaks[0]?.value, 'Marvin Vomberg');
  });

  it('detects identity values nested in a tool_result block', () => {
    const leaks = findIdentityLeaks(
      llmParams(JSON.stringify(HR_LEAVE)),
      REAL_NAMES,
    );
    const leaked = new Set(leaks.map((l) => l.value));
    for (const name of REAL_NAMES) {
      assert.ok(leaked.has(name), `harness missed "${name}"`);
    }
  });

  it('returns no leaks for an identity-free payload', () => {
    const leaks = findIdentityLeaks(
      llmParams('rows: 3, all employee names masked'),
      REAL_NAMES,
    );
    assert.equal(leaks.length, 0);
  });
});

describe('on-the-wire harness — v4 boundary holds', () => {
  it('a v4 digest tool_result carries zero identity values', () => {
    const params = llmParams(v4DigestText(HR_LEAVE));
    assert.deepEqual(findIdentityLeaks(params, REAL_NAMES), []);
    assert.doesNotThrow(() => assertNoIdentityOnWire(params, REAL_NAMES));
  });

  it('assertNoIdentityOnWire throws — naming the leak — on a raw payload', () => {
    const params = llmParams(JSON.stringify(HR_LEAVE));
    assert.throws(
      () => assertNoIdentityOnWire(params, REAL_NAMES),
      /confidentiality breach/,
    );
    assert.throws(
      () => assertNoIdentityOnWire(params, REAL_NAMES),
      /Marvin Vomberg/,
    );
  });
});
