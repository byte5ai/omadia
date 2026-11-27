/**
 * #2294 — the discretion check of live auto-promotion (`guardMemoryEgress`,
 * spec 2042 §5.11 "Memory write"), for the bulk promotion of stored turns.
 *
 * Live promotion asks the active turn's labels; a stored turn has no active
 * turn, so this reads the label set its turn record persisted
 * (`persistLabels('turn', …)`, which includes the turn's own conversation
 * label) and applies the same flow rule: the entry may land in a tier only
 * when every reader of that tier may know what the turn read. The target is
 * the owners of a member-scoped turn, otherwise the agent's own memory, whose
 * readers are not known.
 *
 * The turn's own conversation always passes into its own tier, as live. A
 * stored set does not say which context label is the turn's own, so exactly
 * one context label is read as the own one; with two or more the turn read
 * another conversation, and only readers that cover every context pass.
 *
 * Fail closed: a failed label lookup refuses the turn. A turn without stored
 * labels was written outside a labelled turn, which live promotion also lets
 * through.
 */
import type { BulkPromoteCandidate, BulkPromoteRunOptions, BulkPromotionService } from '@omadia/plugin-api';

import { checkFlow, violationSummary } from './flowRule.js';
import { labelSummary, readersOf, UNKNOWN_READERS } from './labels.js';
import type { DiscretionPort } from './port.js';

export function createBulkPromotionGate(
  port: DiscretionPort,
): (candidate: BulkPromoteCandidate) => Promise<boolean> {
  return async (candidate) => {
    const labels = (await port.labelsOf('turn', [candidate.turnId])).get(candidate.turnId);
    if (!labels || labels.labels.length === 0) return true;
    const contextKeys = new Set(
      labels.labels.flatMap((l) => (l.kind === 'context' ? [l.key] : [])),
    );
    const [ownKey] = contextKeys.size === 1 ? [...contextKeys] : [];
    const decision = checkFlow(labels, {
      kind: 'memory',
      ...(ownKey !== undefined ? { contextKey: ownKey } : {}),
      readers: candidate.owners !== undefined ? readersOf(candidate.owners) : UNKNOWN_READERS,
    });
    if (!decision.allowed) {
      port.audit({
        turnId: candidate.turnId,
        ...(candidate.agentSlug !== undefined ? { agentSlug: candidate.agentSlug } : {}),
        egress: 'memory',
        target: 'bulk-promotion',
        allowed: false,
        labels: labelSummary(labels),
        violations: violationSummary(decision),
      });
    }
    return decision.allowed;
  };
}

/**
 * The published bulk-promotion service with the gate on every run. The
 * kernel installs it with `decorateOnProvide`, so whoever provides
 * `bulkPromotion@1` runs with the check, and a run option cannot drop it
 * (the gate is spread last). Not covered: a plugin granted the service that
 * `replace()`s it with an undecorated wrapper (`replace` applies no
 * decorators; the same holds for `processMemory`).
 */
export function withBulkPromotionGate(
  inner: BulkPromotionService,
  port: DiscretionPort,
): BulkPromotionService {
  const gate = createBulkPromotionGate(port);
  return {
    preview: (threshold) => inner.preview(threshold),
    run: (options: BulkPromoteRunOptions = {}) => inner.run({ ...options, mayPromote: gate }),
    ...(inner.listRetired ? { listRetired: inner.listRetired.bind(inner) } : {}),
    ...(inner.unretire ? { unretire: inner.unretire.bind(inner) } : {}),
  };
}
