/**
 * #2082 — the model-free pre-checks that read the trigger store: "anything
 * new in the context since the last firing?" and "is the context still live?"
 * (spec 2042 §5.12 "Cheap first").
 */

import type { StepExecutors } from './triggerChain.js';
import type { TriggerStore } from './triggerStore.js';
import type { Trigger, TriggerContextKind } from './types.js';

/** A context whose liveness some module knows (a meeting, a facilitation). */
export type ContextLivenessProbe = (kind: TriggerContextKind, contextId: string) => Promise<boolean | undefined>;

export function storeContextChecks(
  store: TriggerStore,
  probe?: ContextLivenessProbe,
): Pick<StepExecutors, 'newActivity' | 'contextLive'> {
  return {
    async newActivity(trigger: Trigger): Promise<boolean> {
      const activity = await store.contextActivity(trigger.contextKind, trigger.contextId);
      if (!activity) return false;
      const since = trigger.lastFiredAt ?? trigger.createdAt;
      return activity.lastActivityAt.getTime() > since.getTime();
    },
    async contextLive(trigger: Trigger): Promise<boolean | undefined> {
      const activity = await store.contextActivity(trigger.contextKind, trigger.contextId);
      if (activity?.endedAt) return false;
      return probe ? probe(trigger.contextKind, trigger.contextId) : undefined;
    },
  };
}
