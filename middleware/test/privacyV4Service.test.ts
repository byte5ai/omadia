/**
 * Privacy Shield v4 — service-wiring integration tests.
 *
 * Verifies the `PrivacyGuardService` v4 seam: the Dataset Store is minted
 * per turn, `internToolResultV4` returns an identity-free digest text,
 * `runV4Tool` runs verbs + the render directive, `finalizeTurn` drops the
 * store and emits the user-facing receipt.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { createPrivacyGuardService } from '@omadia/plugin-privacy-guard/dist/index.js';

const HR_LEAVE = [
  { employee: 'Marvin Vomberg', employee_id: '4471', days: 24 },
  { employee: 'Anna Rüsche', employee_id: '5582', days: 30 },
  { employee: 'Thomas Görres', employee_id: '6693', days: 18 },
];
const REAL_NAMES = ['Vomberg', 'Rüsche', 'Görres', 'Marvin', 'Anna', 'Thomas'];

describe('PrivacyGuardService.internToolResultV4', () => {
  it('returns an identity-free digest text', async () => {
    const svc = createPrivacyGuardService();
    const r = await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't-on',
      toolName: 'hr.leave',
      rawResult: JSON.stringify(HR_LEAVE),
    });
    assert.ok(r.digestText.includes('[privacy-shield-v4]'));
    assert.ok(/ds_[0-9a-f-]+/.test(r.digestText), 'carries a datasetId');
    for (const name of REAL_NAMES) {
      assert.ok(
        !r.digestText.includes(name),
        `digest text leaked identity value "${name}"`,
      );
    }
  });

  it('drops the turn store on finalizeTurn without throwing', async () => {
    const svc = createPrivacyGuardService();
    await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't-fin',
      toolName: 'hr.leave',
      rawResult: JSON.stringify(HR_LEAVE),
    });
    await svc.finalizeTurn('t-fin');
    // A fresh intern on the same turnId after finalize still works (new store).
    const again = await svc.internToolResultV4({
      sessionId: 's',
      turnId: 't-fin',
      toolName: 'hr.leave',
      rawResult: JSON.stringify(HR_LEAVE),
    });
    assert.ok(again.digestText);
  });
});

/** Extract the datasetId embedded in a v4 digest / verb-result text. */
function datasetIdOf(text: string): string {
  const json = text.slice(text.indexOf('{'));
  const parsed = JSON.parse(json) as { datasetId: string };
  return parsed.datasetId;
}

describe('PrivacyGuardService.v4ToolSpecs', () => {
  it('returns the 8 verb tools + the render tool', () => {
    const svc = createPrivacyGuardService();
    const specs = svc.v4ToolSpecs();
    assert.equal(specs.length, 9);
    for (const s of specs) {
      assert.ok(s.name.startsWith('v4_'));
      assert.equal((s.input_schema as { type: string }).type, 'object');
    }
  });
});

describe('PrivacyGuardService.runV4Tool — end-to-end data path', () => {
  it('intern → verb → render → takeRenderedAnswer yields a real answer', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 't-e2e';
    const interned = await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'hr.leave',
      rawResult: JSON.stringify(HR_LEAVE),
    });
    const srcId = datasetIdOf(interned.digestText);

    const sorted = await svc.runV4Tool({
      sessionId: 's',
      turnId,
      toolName: 'v4_sort',
      input: { datasetId: srcId, by: 'days', direction: 'desc' },
    });
    const sortedId = datasetIdOf(sorted.resultText);

    const rendered = await svc.runV4Tool({
      sessionId: 's',
      turnId,
      toolName: 'v4_render_answer',
      input: {
        datasetId: sortedId,
        columns: ['employee', 'days'],
        format: 'table',
      },
    });
    assert.ok(rendered.resultText.includes('[privacy-shield-v4]'));

    const answer = await svc.takeRenderedAnswerV4(turnId);
    assert.ok(answer);
    // Real, complete names in correct rank order: 30 > 24 > 18.
    assert.ok(answer.indexOf('Anna Rüsche') < answer.indexOf('Marvin Vomberg'));
    assert.ok(
      answer.indexOf('Marvin Vomberg') < answer.indexOf('Thomas Görres'),
    );

    // The turn receipt reports what the data-plane boundary did.
    const receipt = await svc.finalizeTurn(turnId);
    assert.ok(receipt, 'a receipt is emitted for a turn that interned data');
    assert.equal(receipt.datasetsInterned, 1);
    assert.ok(receipt.fieldsMasked >= 1, 'the employee name field is masked');
    assert.ok(receipt.verbsExecuted.includes('sort'));
    assert.equal(receipt.pseudonymProjectionUsed, false);
  });

  it('takeRenderedAnswerV4 clears the stash after taking', async () => {
    const svc = createPrivacyGuardService();
    const turnId = 't-clear';
    const interned = await svc.internToolResultV4({
      sessionId: 's',
      turnId,
      toolName: 'hr.leave',
      rawResult: JSON.stringify(HR_LEAVE),
    });
    await svc.runV4Tool({
      sessionId: 's',
      turnId,
      toolName: 'v4_render_answer',
      input: {
        datasetId: datasetIdOf(interned.digestText),
        columns: ['employee'],
        format: 'list',
      },
    });
    const first = await svc.takeRenderedAnswerV4(turnId);
    const second = await svc.takeRenderedAnswerV4(turnId);
    assert.ok(first);
    assert.equal(second, undefined);
  });

  it('finalizeTurn returns undefined for a turn that interned nothing', async () => {
    const svc = createPrivacyGuardService();
    const receipt = await svc.finalizeTurn('t-empty');
    assert.equal(receipt, undefined);
  });
});
