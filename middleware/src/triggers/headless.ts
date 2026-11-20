/**
 * #2082 — a trigger whose turn acts through tools and sends nothing: an Agent
 * Builder schedule (`scheduleTriggers.ts`). It has no recipient, so no quiet
 * hours or rate limit apply, and its outcome is the turn completing.
 */

import type { Trigger } from './types.js';

export const isHeadless = (trigger: Pick<Trigger, 'contextKind' | 'deliveryChannel'>): boolean =>
  trigger.contextKind === 'schedule' && trigger.deliveryChannel === null;
