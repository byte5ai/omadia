/**
 * #2082 — a trigger that sends nothing: an Agent Builder schedule
 * (`scheduleTriggers.ts`, its turn acts through tools) or a batch job on an
 * agent's memory (`batchJobs.ts`). It has no recipient, so no quiet hours or
 * rate limit apply.
 */

import type { Trigger } from './types.js';

export const isHeadless = (trigger: Pick<Trigger, 'contextKind' | 'deliveryChannel'>): boolean =>
  (trigger.contextKind === 'schedule' || trigger.contextKind === 'memory') && trigger.deliveryChannel === null;
