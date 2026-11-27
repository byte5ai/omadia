/**
 * #2357 (ADR-0324) — a routine's manual run gets the budget checks a
 * scheduled firing gets: kill switch, budget pause, room for one firing in
 * the trigger's total and the agent's and instance's month. Read-only.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { TriggerService } from '../src/triggers/triggerService.js';
import type { Trigger } from '../src/triggers/types.js';

const LIMITS = { monthlyAgentUsd: 25, monthlyInstanceUsd: 200 };

function service(opts: {
  trigger?: Partial<Trigger>;
  killed?: boolean;
  agentSpent?: number;
  instanceSpent?: number;
}): { svc: TriggerService; writes: string[] } {
  const writes: string[] = [];
  const trigger = opts.trigger
    ? ({
        id: 't1',
        agentId: 'agent-1',
        state: 'active',
        budgetPerFiringUsd: 1,
        budgetTotalUsd: 10,
        spentUsd: 0,
        reservedUsd: 0,
        ...opts.trigger,
      } as unknown as Trigger)
    : undefined;
  const store = {
    listByContext: async () => (trigger ? [trigger] : []),
    killSwitchSet: async () => opts.killed === true,
    monthSpend: async (scope: string) => ({
      spentUsd: scope === 'instance' ? (opts.instanceSpent ?? 0) : (opts.agentSpent ?? 0),
      reservedUsd: 0,
    }),
    reserve: async () => {
      writes.push('reserve');
      return { ok: true };
    },
  };
  return {
    svc: new TriggerService({ store, limits: LIMITS, eventSources: () => [] } as never),
    writes,
  };
}

describe('#2357 — TriggerService.manualRunRefusal', () => {
  it('lets a run with room in every budget start, reserving nothing', async () => {
    const { svc, writes } = service({ trigger: {} });
    assert.equal(await svc.manualRunRefusal('routine', 'r1'), undefined);
    assert.deepEqual(writes, []);
  });

  it('no trigger (no engine for the routine) → no refusal', async () => {
    assert.equal(await service({}).svc.manualRunRefusal('routine', 'r1'), undefined);
  });

  it('refuses on kill switch, budget pause, trigger total, agent and instance month', async () => {
    const cases: Array<[Parameters<typeof service>[0], RegExp]> = [
      [{ trigger: {}, killed: true }, /kill switch/],
      [{ trigger: { state: 'paused', pauseReason: 'budget' } as Partial<Trigger> }, /budget is used up/],
      [{ trigger: { spentUsd: 9.5 } }, /total budget/],
      [{ trigger: {}, agentSpent: 24.5 }, /agent's monthly budget/],
      [{ trigger: {}, instanceSpent: 199.5 }, /instance's monthly budget/],
    ];
    for (const [opts, pattern] of cases) {
      const refusal = await service(opts).svc.manualRunRefusal('routine', 'r1');
      assert.match(refusal ?? '', pattern);
    }
  });

  it('a trigger paused for another reason does not block a manual run', async () => {
    const { svc } = service({ trigger: { state: 'paused', pauseReason: 'owner' } as Partial<Trigger> });
    assert.equal(await svc.manualRunRefusal('routine', 'r1'), undefined);
  });
});
