import { describe, it, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';

import { fillSlotTool } from '../../../src/plugins/builder/tools/fillSlot.js';
import {
  createBuilderToolHarness,
  type BuilderToolHarness,
} from '../fixtures/builderToolHarness.js';

describe('fillSlotTool', () => {
  let harness: BuilderToolHarness;

  beforeEach(async () => {
    harness = await createBuilderToolHarness();
  });

  afterEach(async () => {
    await harness.dispose();
  });

  it('persists the slot, emits slot_patch, runs tsc-gate, schedules rebuild on green', async () => {
    const result = await fillSlotTool.run(
      { slotKey: 'activate-body', source: 'console.log("hi");' },
      harness.context(),
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.bytes, 'console.log("hi");'.length);
    assert.equal(typeof result.typecheckMs, 'number');

    const reloaded = await harness.draftStore.load(harness.userEmail, harness.draftId);
    assert.equal(reloaded?.slots['activate-body'], 'console.log("hi");');

    assert.equal(harness.events.length, 1);
    if (harness.events[0]?.type === 'slot_patch') {
      assert.equal(harness.events[0].slotKey, 'activate-body');
      assert.equal(harness.events[0].cause, 'agent');
    }
    assert.equal(harness.slotTypecheckCalls.length, 1);
    assert.equal(harness.slotTypecheckCalls[0]?.draftId, harness.draftId);
    assert.equal(harness.rebuilds.length, 1);
  });

  it('overwrites an existing slot (idempotent re-call)', async () => {
    await fillSlotTool.run(
      { slotKey: 'activate-body', source: 'old();' },
      harness.context(),
    );
    await fillSlotTool.run(
      { slotKey: 'activate-body', source: 'new();' },
      harness.context(),
    );
    const reloaded = await harness.draftStore.load(harness.userEmail, harness.draftId);
    assert.equal(reloaded?.slots['activate-body'], 'new();');
  });

  it('rejects an invalid slotKey via Zod', () => {
    assert.throws(() => fillSlotTool.input.parse({ slotKey: 'BadKey', source: 'x' }));
    assert.throws(() => fillSlotTool.input.parse({ slotKey: '0lead', source: 'x' }));
    assert.throws(() => fillSlotTool.input.parse({ slotKey: '', source: 'x' }));
  });

  it('rejects an empty source via Zod', () => {
    assert.throws(() => fillSlotTool.input.parse({ slotKey: 'activate-body', source: '' }));
  });

  it('returns ok=false when the draft does not exist', async () => {
    const ctx = { ...harness.context(), draftId: 'no-such-draft' };
    const result = await fillSlotTool.run(
      { slotKey: 'activate-body', source: 'x();' },
      ctx,
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.match(result.error, /not found/);
    // tsc-gate must not run when the draft doesn't exist.
    assert.equal(harness.slotTypecheckCalls.length, 0);
  });

  it('returns ok=false with tscErrors[] when tsc-gate fails — slot stays persisted, rebuild NOT scheduled', async () => {
    harness.slotTypecheckResult = {
      ok: false,
      reason: 'tsc',
      summary: 'tsc found 2 error(s)',
      durationMs: 1234,
      errors: [
        { path: 'src/toolkit.ts', line: 10, col: 3, code: 'TS2304', message: `Cannot find name 'foo'.` },
        { path: 'src/toolkit.ts', line: 20, col: 5, code: 'TS2314', message: `Generic type requires 2 args.` },
      ],
    };

    const result = await fillSlotTool.run(
      { slotKey: 'tool-handlers', source: 'broken();' },
      harness.context(),
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.slotKey, 'tool-handlers');
    assert.equal(result.bytes, 'broken();'.length);
    assert.equal(result.reason, 'tsc');
    assert.equal(result.typecheckMs, 1234);
    assert.equal(result.tscErrors?.length, 2);
    assert.equal(result.tscErrors?.[0]?.code, 'TS2304');
    assert.match(result.error, /tsc found 2 error\(s\)/);
    assert.match(result.error, /TS2304/);
    assert.match(result.error, /TS2314/);

    // Slot is persisted even though tsc failed — user sees buggy code in editor.
    const reloaded = await harness.draftStore.load(harness.userEmail, harness.draftId);
    assert.equal(reloaded?.slots['tool-handlers'], 'broken();');

    // Tsc gate ran, but rebuild was NOT scheduled.
    assert.equal(harness.slotTypecheckCalls.length, 1);
    assert.equal(harness.rebuilds.length, 0);
  });

  it('truncates inline error list to 5 with overflow notice but keeps full tscErrors[] up to 50', async () => {
    const errors = Array.from({ length: 12 }, (_, i) => ({
      path: 'src/foo.ts',
      line: i + 1,
      col: 1,
      code: `TS900${String(i)}`,
      message: `error ${String(i)}`,
    }));
    harness.slotTypecheckResult = {
      ok: false,
      reason: 'tsc',
      summary: 'tsc found 12 error(s)',
      durationMs: 100,
      errors,
    };

    const result = await fillSlotTool.run(
      { slotKey: 'tool-handlers', source: 'x();' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.tscErrors?.length, 12);
    assert.match(result.error, /and 7 more error\(s\)/);
  });

  it('surfaces non-tsc gate failures (codegen, spec_invalid, spawn) via reason field', async () => {
    harness.slotTypecheckResult = {
      ok: false,
      reason: 'codegen_failed',
      summary: 'codegen failed: missing required slot foo',
      durationMs: 50,
      errors: [],
    };

    const result = await fillSlotTool.run(
      { slotKey: 'tool-handlers', source: 'x();' },
      harness.context(),
    );
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.reason, 'codegen_failed');
    assert.match(result.error, /codegen failed/);
    assert.equal(result.tscErrors?.length, 0);
    assert.equal(harness.rebuilds.length, 0);
  });

  describe('B.7-4 retry-counter + agent_stuck event', () => {
    function failingResult() {
      return {
        ok: false as const,
        reason: 'tsc' as const,
        summary: 'tsc found 1 error',
        durationMs: 10,
        errors: [
          { path: 'src/x.ts', line: 1, col: 1, code: 'TS2304', message: 'bad' },
        ],
      };
    }

    it('does NOT emit agent_stuck on the first or second failure', async () => {
      harness.slotTypecheckResult = failingResult();
      await fillSlotTool.run(
        { slotKey: 'tool-handlers', source: 'a();' },
        harness.context(),
      );
      await fillSlotTool.run(
        { slotKey: 'tool-handlers', source: 'b();' },
        harness.context(),
      );
      const stuck = harness.events.filter((e) => e.type === 'agent_stuck');
      assert.equal(stuck.length, 0);
    });

    it('emits agent_stuck exactly once on the 3rd consecutive failure for the same slot', async () => {
      harness.slotTypecheckResult = failingResult();
      for (let i = 0; i < 5; i += 1) {
        await fillSlotTool.run(
          { slotKey: 'tool-handlers', source: `attempt-${String(i)}();` },
          harness.context(),
        );
      }
      const stuck = harness.events.filter((e) => e.type === 'agent_stuck');
      assert.equal(stuck.length, 1, 'agent_stuck must fire exactly once');
      if (stuck[0]?.type !== 'agent_stuck') return;
      assert.equal(stuck[0].slotKey, 'tool-handlers');
      assert.equal(stuck[0].attempts, 3);
      assert.equal(stuck[0].lastReason, 'tsc');
      assert.equal(stuck[0].lastErrorCount, 1);
    });

    it('resets the counter on a successful fill_slot call (next failure starts at 1)', async () => {
      harness.slotTypecheckResult = failingResult();
      await fillSlotTool.run(
        { slotKey: 'tool-handlers', source: 'fail1();' },
        harness.context(),
      );
      await fillSlotTool.run(
        { slotKey: 'tool-handlers', source: 'fail2();' },
        harness.context(),
      );

      // Now succeed once → counter resets.
      harness.slotTypecheckResult = {
        ok: true, errors: [], reason: 'ok', summary: 'tsc clean', durationMs: 5,
      };
      await fillSlotTool.run(
        { slotKey: 'tool-handlers', source: 'fixed();' },
        harness.context(),
      );

      // Now fail again 3 times — agent_stuck must fire because the counter was reset.
      harness.slotTypecheckResult = failingResult();
      for (let i = 0; i < 3; i += 1) {
        await fillSlotTool.run(
          { slotKey: 'tool-handlers', source: `regress-${String(i)}();` },
          harness.context(),
        );
      }
      const stuck = harness.events.filter((e) => e.type === 'agent_stuck');
      assert.equal(stuck.length, 1);
      if (stuck[0]?.type !== 'agent_stuck') return;
      assert.equal(stuck[0].attempts, 3);
    });

    it('counts retries per-slot — failures on slotA do not stuck slotB', async () => {
      harness.slotTypecheckResult = failingResult();
      // 3 fails on slot-a → stuck for slot-a only.
      for (let i = 0; i < 3; i += 1) {
        await fillSlotTool.run(
          { slotKey: 'slot-a', source: `a-${String(i)}();` },
          harness.context(),
        );
      }
      // 2 fails on slot-b → not stuck.
      for (let i = 0; i < 2; i += 1) {
        await fillSlotTool.run(
          { slotKey: 'slot-b', source: `b-${String(i)}();` },
          harness.context(),
        );
      }
      const stuck = harness.events.filter((e) => e.type === 'agent_stuck');
      assert.equal(stuck.length, 1);
      if (stuck[0]?.type !== 'agent_stuck') return;
      assert.equal(stuck[0].slotKey, 'slot-a');
    });
  });
});
