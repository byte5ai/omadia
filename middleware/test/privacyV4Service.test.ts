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
