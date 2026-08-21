import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';

import { createScopedRoleAssignments, RoleKeyOutOfScopeError } from '../src/conductor/scopedRoleAssignments.js';
import type { ConductorRoleStore } from '../src/conductor/roleStore.js';

// #330 C2a — the security property: a plugin-facing role-assignment surface
// that can NEVER touch a role outside the 'facilitation-' namespace, and
// whose every holder mutation lands in the same audit sink as the operator
// baton routes (#759).

function harness(): {
  service: ReturnType<typeof createScopedRoleAssignments>;
  calls: string[];
  audits: Array<{ action: string; roleKey: string; holderId: string; actor: string }>;
} {
  const calls: string[] = [];
  const audits: Array<{ action: string; roleKey: string; holderId: string; actor: string }> = [];
  const holders = new Set<string>();
  const roleStore = {
    createRole: async (input: { key: string }) => {
      calls.push(`createRole:${input.key}`);
    },
    addHolder: async (_key: string, holderId: string) => {
      holders.add(holderId);
      calls.push(`addHolder:${holderId}`);
    },
    removeHolder: async (_key: string, holderId: string) => {
      holders.delete(holderId);
      calls.push(`removeHolder:${holderId}`);
    },
    resolve: async () => [...holders],
  } as unknown as ConductorRoleStore;

  const service = createScopedRoleAssignments({
    roleStore,
    auditRoleChange: async (entry) => {
      audits.push({ action: entry.action, roleKey: entry.roleKey, holderId: entry.holderId, actor: entry.actor });
    },
  });
  return { service, calls, audits };
}

describe('createScopedRoleAssignments', () => {
  it("rejects any role outside 'facilitation-' — including the bare prefix", async () => {
    const { service, calls } = harness();
    for (const roleKey of ['management', 'on-duty', 'facilitation-', 'Facilitation-x']) {
      await assert.rejects(service.ensureRole({ roleKey, label: 'x' }), RoleKeyOutOfScopeError);
      await assert.rejects(service.addHolder({ roleKey, holderId: 'a@co.com', actor: 'p' }), RoleKeyOutOfScopeError);
      await assert.rejects(service.removeHolder({ roleKey, holderId: 'a@co.com', actor: 'p' }), RoleKeyOutOfScopeError);
      await assert.rejects(service.holders(roleKey), RoleKeyOutOfScopeError);
    }
    assert.deepEqual(calls, [], 'no store call may happen for out-of-scope keys');
  });

  it('add/remove inside the namespace mutate AND audit with the named actor', async () => {
    const { service, calls, audits } = harness();
    await service.ensureRole({ roleKey: 'facilitation-abc', label: 'Initiator conv abc' });
    await service.addHolder({ roleKey: 'facilitation-abc', holderId: 'owner@co.com', actor: 'plugin:@omadia/agent-facilitator' });
    await service.removeHolder({ roleKey: 'facilitation-abc', holderId: 'owner@co.com', actor: 'conductor-ephemeral-reaper' });

    assert.deepEqual(calls, ['createRole:facilitation-abc', 'addHolder:owner@co.com', 'removeHolder:owner@co.com']);
    assert.deepEqual(audits, [
      { action: 'add', roleKey: 'facilitation-abc', holderId: 'owner@co.com', actor: 'plugin:@omadia/agent-facilitator' },
      { action: 'remove', roleKey: 'facilitation-abc', holderId: 'owner@co.com', actor: 'conductor-ephemeral-reaper' },
    ]);
  });

  it('a failing audit write is logged, never blocks the assignment', async () => {
    const logs: string[] = [];
    const holders: string[] = [];
    const service = createScopedRoleAssignments({
      roleStore: {
        createRole: async () => undefined,
        addHolder: async (_k: string, h: string) => {
          holders.push(h);
        },
        removeHolder: async () => undefined,
        resolve: async () => holders,
      } as unknown as ConductorRoleStore,
      auditRoleChange: async () => {
        throw new Error('audit sink down');
      },
      log: (m) => logs.push(m),
    });
    await service.addHolder({ roleKey: 'facilitation-x', holderId: 'a@co.com', actor: 'p' });
    assert.deepEqual(holders, ['a@co.com']);
    assert.ok(logs.some((l) => l.includes('audit')));
  });
});
