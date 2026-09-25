import type { RoutinesIntegration } from '@omadia/plugin-api';

import type { RoutineTurnScope } from '../../channels/coreApi.js';
import { routineTurnContext } from './routineTurnContext.js';

/**
 * #1086 — the kernel's routine-turn producer for `CoreApi.handleTurnStream`,
 * built on the published `RoutinesIntegration`.
 *
 * Lives here rather than inline in `index.ts` so the two decisions this wiring
 * owns are testable:
 *
 *   - the tenant defaults to the deployment tenant — the same value
 *     `routes/chat.ts` gives the web chat — when the channel declares none;
 *   - `canTargetOthers` is always `false`. Cold-start outreach to OTHER people
 *     needs a governance source, the core has none, and only a channel adapter
 *     (via its own `captureRoutineTurn`) may grant it.
 *
 * `hasContextFor` answers "did an adapter already install a context for THIS
 * user?". Trimmed on both sides for the same reason `turnOwnerGuard` trims: a
 * stray space must not turn the adapter's own context into "someone else's".
 * A context naming a different user is stale (`enterWith` never exits, #1016)
 * and the producer installs its own scoped one over it.
 */
export function createCoreRoutineTurnScope(
  routines: Pick<RoutinesIntegration, 'beginRoutineTurn'>,
  deploymentTenant: string,
): RoutineTurnScope {
  return {
    hasContextFor: (userId: string): boolean => {
      const current = routineTurnContext.current()?.userId?.trim();
      return current !== undefined && current !== '' && current === userId.trim();
    },
    begin: (info) =>
      routines.beginRoutineTurn({
        tenant: info.tenant ?? deploymentTenant,
        userId: info.userId,
        ...(info.principalRef !== undefined ? { principalRef: info.principalRef } : {}),
        channel: info.channel,
        conversationRef: info.conversationRef,
        canTargetOthers: false,
      }),
  };
}
