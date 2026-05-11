import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { fillSlotTool } from '../../../src/plugins/builder/tools/fillSlot.js';
import {
  createBuilderToolHarness,
  type BuilderToolHarness,
} from '../fixtures/builderToolHarness.js';

/**
 * Validates the cross-slot consecutive-failure budget. The budget is
 * orthogonal to the existing per-slotKey retry counter — it tracks
 * consecutive `slot-typecheck ok=false` outcomes across all slots in a
 * turn and surfaces a hard-stop error once the limit is reached.
 *
 * A successful slot resets the counter, so an agent that's making
 * progress (some slots green, others red) is not affected.
 */
describe('fillSlotTool — BuildFailureBudget cap', () => {
  let harness: BuilderToolHarness;

  beforeEach(async () => {
    harness = await createBuilderToolHarness({
      // Tight cap so the test stays fast and intent is obvious.
      buildFailureBudgetLimit: 3,
      slotTypecheckResult: {
        ok: false,
        errors: [
          {
            path: 'src/toolkit.ts',
            line: 1,
            col: 1,
            code: 'TS2339',
            message:
              "Property 'streamText' does not exist on type 'Client'.",
          },
        ],
        reason: 'tsc',
        summary: '1 type error',
        durationMs: 5,
      },
    });
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('returns regular tsc errors below the cap', async () => {
    const r1 = await fillSlotTool.run(
      { slotKey: 'toolkit-impl', source: '// v1\n' },
      harness.context(),
    );
    assert.equal(r1.ok, false);
    if (r1.ok) return;
    assert.match(r1.error, /1 type error/);
    assert.doesNotMatch(r1.error, /Build-Budget/);

    const r2 = await fillSlotTool.run(
      { slotKey: 'toolkit-impl', source: '// v2\n' },
      harness.context(),
    );
    assert.equal(r2.ok, false);
    if (r2.ok) return;
    assert.doesNotMatch(r2.error, /Build-Budget/);
  });

  it('surfaces a Build-Budget error on the call that crosses the cap', async () => {
    // Limit is 3 → first two consecutive fails are below, the third
    // hits the cap and must surface the budget-exhausted message.
    await fillSlotTool.run(
      { slotKey: 'a', source: '// 1\n' },
      harness.context(),
    );
    await fillSlotTool.run(
      { slotKey: 'b', source: '// 2\n' },
      harness.context(),
    );
    const capHit = await fillSlotTool.run(
      { slotKey: 'c', source: '// 3\n' },
      harness.context(),
    );
    assert.equal(capHit.ok, false);
    if (capHit.ok) return;
    assert.match(capHit.error, /Build-Budget ersch/);
    assert.match(capHit.error, /3/);
    // Original tsc detail is preserved so the agent can still surface
    // the underlying error to the user.
    assert.match(capHit.error, /streamText/);
  });

  it('resets the counter after a successful slot-typecheck', async () => {
    // Two consecutive fails — counter at 2/3.
    await fillSlotTool.run(
      { slotKey: 'a', source: '// 1\n' },
      harness.context(),
    );
    await fillSlotTool.run(
      { slotKey: 'b', source: '// 2\n' },
      harness.context(),
    );

    // Flip to OK — counter resets.
    harness.slotTypecheckResult = {
      ok: true,
      errors: [],
      reason: 'ok',
      summary: 'tsc clean',
      durationMs: 1,
    };
    const ok = await fillSlotTool.run(
      { slotKey: 'b', source: '// fixed\n' },
      harness.context(),
    );
    assert.equal(ok.ok, true);

    // Back to fail — should NOT immediately hit the cap because the
    // success in between reset the counter to 0.
    harness.slotTypecheckResult = {
      ok: false,
      errors: [
        {
          path: 'src/toolkit.ts',
          line: 1,
          col: 1,
          code: 'TS2339',
          message: "Property 'streamText' does not exist on type 'Client'.",
        },
      ],
      reason: 'tsc',
      summary: '1 type error',
      durationMs: 5,
    };
    const afterReset = await fillSlotTool.run(
      { slotKey: 'c', source: '// 4\n' },
      harness.context(),
    );
    assert.equal(afterReset.ok, false);
    if (afterReset.ok) return;
    // First fail post-reset is below cap (limit 3, count 1).
    assert.doesNotMatch(afterReset.error, /Build-Budget/);
  });
});
