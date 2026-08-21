// Prefix-scoped role assignment service (#330 C2a). What the Facilitator
// plugin reaches as 'conductorRoleAssignments': it may create roles and move
// holders ONLY inside the 'facilitation-' namespace — the per-conversation
// initiator roles — never touch operator-authored roles ('management',
// 'on-duty', …). Every mutation goes through the SAME audit sink as the
// operator baton routes (#759, `conductor.role_holders_change`), with the
// plugin as the named actor: role assignment decides who receives reports
// (and could decide approvals), so an unaudited plugin write path would be
// exactly the hole docs/security-architecture.md §7a warns about.

import type { ConductorRoleStore } from './roleStore.js';

export const FACILITATION_ROLE_PREFIX = 'facilitation-';

export class RoleKeyOutOfScopeError extends Error {
  constructor(readonly roleKey: string) {
    super(`role '${roleKey}' is outside the '${FACILITATION_ROLE_PREFIX}' namespace this service is scoped to`);
    this.name = 'RoleKeyOutOfScopeError';
  }
}

export interface ScopedRoleAssignments {
  ensureRole(input: { roleKey: string; label: string; description?: string }): Promise<void>;
  addHolder(input: { roleKey: string; holderId: string; actor: string }): Promise<void>;
  removeHolder(input: { roleKey: string; holderId: string; actor: string }): Promise<void>;
  holders(roleKey: string): Promise<string[]>;
}

export function createScopedRoleAssignments(deps: {
  roleStore: ConductorRoleStore;
  auditRoleChange: (entry: {
    actor: string;
    roleKey: string;
    action: 'add' | 'remove';
    holderId: string;
    holdersAfter: string[];
  }) => Promise<void>;
  log?: (msg: string) => void;
}): ScopedRoleAssignments {
  const log = deps.log ?? (() => undefined);

  function assertScoped(roleKey: string): void {
    if (!roleKey.startsWith(FACILITATION_ROLE_PREFIX) || roleKey.length <= FACILITATION_ROLE_PREFIX.length) {
      throw new RoleKeyOutOfScopeError(roleKey);
    }
  }

  return {
    async ensureRole(input) {
      assertScoped(input.roleKey);
      await deps.roleStore.createRole({
        key: input.roleKey,
        label: input.label,
        description: input.description ?? null,
        scope: 'facilitation',
      });
    },

    async addHolder(input) {
      assertScoped(input.roleKey);
      await deps.roleStore.addHolder(input.roleKey, input.holderId);
      const holdersAfter = await deps.roleStore.resolve(input.roleKey);
      await deps.auditRoleChange({
        actor: input.actor,
        roleKey: input.roleKey,
        action: 'add',
        holderId: input.holderId,
        holdersAfter,
      }).catch((err: unknown) => {
        // The assignment stands; a failed audit write is loud, never silent.
        log(`[conductor] scoped role audit (add ${input.roleKey}) failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },

    async removeHolder(input) {
      assertScoped(input.roleKey);
      await deps.roleStore.removeHolder(input.roleKey, input.holderId);
      const holdersAfter = await deps.roleStore.resolve(input.roleKey);
      await deps.auditRoleChange({
        actor: input.actor,
        roleKey: input.roleKey,
        action: 'remove',
        holderId: input.holderId,
        holdersAfter,
      }).catch((err: unknown) => {
        log(`[conductor] scoped role audit (remove ${input.roleKey}) failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    },

    async holders(roleKey) {
      assertScoped(roleKey);
      return deps.roleStore.resolve(roleKey);
    },
  };
}
