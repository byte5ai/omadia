/**
 * Privacy Shield v4 — US3 service-wiring integration tests.
 *
 * Verifies the `PrivacyGuardService.internToolResultV4` seam: the v4 store is
 * minted per turn, gated by the feature flag, returns an identity-free digest
 * text, and is dropped by `finalizeTurn`.
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

/** Run `fn` with the v4 feature flag forced on or off, then restore env. */
async function withV4<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.PRIVACY_SHIELD_V4;
  if (on) process.env.PRIVACY_SHIELD_V4 = 'on';
  else delete process.env.PRIVACY_SHIELD_V4;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.PRIVACY_SHIELD_V4;
    else process.env.PRIVACY_SHIELD_V4 = prev;
  }
}

describe('PrivacyGuardService.internToolResultV4', () => {
  it('returns undefined when the v4 feature flag is off', async () => {
    const svc = createPrivacyGuardService({});
    assert.ok(svc.internToolResultV4, 'service exposes internToolResultV4');
    const r = await withV4(false, () =>
      svc.internToolResultV4!({
        sessionId: 's',
        turnId: 't-off',
        toolName: 'hr.leave',
        rawResult: JSON.stringify(HR_LEAVE),
      }),
    );
    assert.equal(r, undefined);
  });

  it('returns an identity-free digest text when the flag is on', async () => {
    const svc = createPrivacyGuardService({});
    const r = await withV4(true, () =>
      svc.internToolResultV4!({
        sessionId: 's',
        turnId: 't-on',
        toolName: 'hr.leave',
        rawResult: JSON.stringify(HR_LEAVE),
      }),
    );
    assert.ok(r, 'a digest is returned');
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
    const svc = createPrivacyGuardService({});
    await withV4(true, async () => {
      await svc.internToolResultV4!({
        sessionId: 's',
        turnId: 't-fin',
        toolName: 'hr.leave',
        rawResult: JSON.stringify(HR_LEAVE),
      });
    });
    await svc.finalizeTurn('t-fin');
    // A fresh intern on the same turnId after finalize still works (new store).
    const again = await withV4(true, () =>
      svc.internToolResultV4!({
        sessionId: 's',
        turnId: 't-fin',
        toolName: 'hr.leave',
        rawResult: JSON.stringify(HR_LEAVE),
      }),
    );
    assert.ok(again);
  });
});

/** Extract the datasetId embedded in a v4 digest / verb-result text. */
function datasetIdOf(text: string): string {
  const json = text.slice(text.indexOf('{'));
  const parsed = JSON.parse(json) as { datasetId: string };
  return parsed.datasetId;
}

describe('PrivacyGuardService.v4ToolSpecs', () => {
  it('returns undefined when v4 is off', async () => {
    const svc = createPrivacyGuardService({});
    const specs = await withV4(false, async () => svc.v4ToolSpecs?.());
    assert.equal(specs, undefined);
  });

  it('returns the 8 verb tools + the render tool when v4 is on', async () => {
    const svc = createPrivacyGuardService({});
    const specs = await withV4(true, async () => svc.v4ToolSpecs?.());
    assert.ok(specs);
    assert.equal(specs.length, 9);
    for (const s of specs) {
      assert.ok(s.name.startsWith('v4_'));
      assert.equal((s.input_schema as { type: string }).type, 'object');
    }
  });
});

describe('PrivacyGuardService.runV4Tool — end-to-end data path', () => {
  it('intern → verb → render → takeRenderedAnswer yields a real answer', async () => {
    const svc = createPrivacyGuardService({});
    const turnId = 't-e2e';
    const answer = await withV4(true, async () => {
      const interned = await svc.internToolResultV4!({
        sessionId: 's',
        turnId,
        toolName: 'hr.leave',
        rawResult: JSON.stringify(HR_LEAVE),
      });
      assert.ok(interned);
      const srcId = datasetIdOf(interned.digestText);

      const sorted = await svc.runV4Tool!({
        sessionId: 's',
        turnId,
        toolName: 'v4_sort',
        input: { datasetId: srcId, by: 'days', direction: 'desc' },
      });
      assert.ok(sorted);
      const sortedId = datasetIdOf(sorted.resultText);

      const rendered = await svc.runV4Tool!({
        sessionId: 's',
        turnId,
        toolName: 'v4_render_answer',
        input: {
          datasetId: sortedId,
          columns: ['employee', 'days'],
          format: 'table',
        },
      });
      assert.ok(rendered);
      assert.ok(rendered.resultText.includes('[privacy-shield-v4]'));

      return svc.takeRenderedAnswerV4!(turnId);
    });
    assert.ok(answer);
    // Real, complete names in correct rank order: 30 > 24 > 18.
    assert.ok(answer.indexOf('Anna Rüsche') < answer.indexOf('Marvin Vomberg'));
    assert.ok(
      answer.indexOf('Marvin Vomberg') < answer.indexOf('Thomas Görres'),
    );
  });

  it('returns undefined when v4 is off', async () => {
    const svc = createPrivacyGuardService({});
    const r = await withV4(false, () =>
      svc.runV4Tool!({
        sessionId: 's',
        turnId: 't',
        toolName: 'v4_count',
        input: {},
      }),
    );
    assert.equal(r, undefined);
  });

  it('takeRenderedAnswerV4 clears the stash after taking', async () => {
    const svc = createPrivacyGuardService({});
    const turnId = 't-clear';
    await withV4(true, async () => {
      const interned = await svc.internToolResultV4!({
        sessionId: 's',
        turnId,
        toolName: 'hr.leave',
        rawResult: JSON.stringify(HR_LEAVE),
      });
      await svc.runV4Tool!({
        sessionId: 's',
        turnId,
        toolName: 'v4_render_answer',
        input: {
          datasetId: datasetIdOf(interned!.digestText),
          columns: ['employee'],
          format: 'list',
        },
      });
    });
    const first = await svc.takeRenderedAnswerV4!(turnId);
    const second = await svc.takeRenderedAnswerV4!(turnId);
    assert.ok(first);
    assert.equal(second, undefined);
  });
});
