/**
 * The discretion flow rule (spec 2042 §5.11): every egress of a turn is checked
 * against the turn's label set BEFORE it happens. Deterministic, no model.
 *
 * | Egress | Allowed only if |
 * |---|---|
 * | people | every reader of the target conversation may know it |
 * | agent | the receiving agent's grants cover it and every reader of its conversation may know it |
 * | memory | every reader of the target tier may know it |
 * | integration | the integration's declared readership covers it |
 *
 * A refused flow is never redacted afterwards: the caller refuses the output
 * as a whole (mask at entry, not at exit).
 */

import {
  labelId,
  readersWithin,
  type DiscretionLabel,
  type LabelSet,
  type Readers,
} from './labels.js';
import { allowsFieldClass, type FieldClassAllowance } from './fieldRights.js';

/**
 * What an operator declared about one integration (plugin or MCP server):
 * - `readers`: who can read what is written there (`everyone` for a
 *   tenant-wide CRM, a set for a private mailbox);
 * - `acceptsSystems`: source systems whose restricted data may be written
 *   there;
 * - `acceptsClassifications`: classifications that may be written there.
 */
export interface IntegrationReadership {
  readonly readers: Readers;
  readonly acceptsSystems: readonly string[];
  readonly acceptsClassifications: readonly string[];
}

export type DiscretionEgress =
  | {
      readonly kind: 'people';
      /** The conversation the answer goes to; its own context label always passes. */
      readonly contextKey?: string;
      readonly readers: Readers;
      /**
       * The classifications every reader may know (their field rights,
       * `fieldRights.ts`). Absent = none: a classification label fails.
       */
      readonly fieldClasses?: FieldClassAllowance;
    }
  | {
      readonly kind: 'agent';
      readonly agentId: string;
      /** Source systems the receiving agent holds grants for. */
      readonly grantedSystems: ReadonlySet<string>;
      readonly contextKey?: string;
      readonly readers: Readers;
    }
  | { readonly kind: 'memory'; readonly contextKey?: string; readonly readers: Readers }
  | {
      readonly kind: 'integration';
      /** The integration written to (plugin id or `mcp:<serverId>`). */
      readonly system: string;
      /** Undefined = the operator declared nothing. */
      readonly readership?: IntegrationReadership;
      /** The turn's own conversation: what its members said there passes. */
      readonly currentContextKey?: string;
    };

export interface FlowViolation {
  readonly label: DiscretionLabel;
  readonly reason:
    | 'readers_not_covered'
    | 'agent_lacks_grant'
    | 'integration_undeclared'
    | 'integration_readership'
    | 'classification_not_accepted'
    | 'readers_lack_field_right';
}

export type FlowDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly violations: readonly FlowViolation[] };

function checkContext(
  label: Extract<DiscretionLabel, { kind: 'context' }>,
  egress: DiscretionEgress,
): FlowViolation['reason'] | undefined {
  if (egress.kind === 'integration') {
    if (label.key === egress.currentContextKey) return undefined;
    if (label.readers.kind === 'everyone') return undefined;
    if (!egress.readership) return 'integration_undeclared';
    return readersWithin(egress.readership.readers, label.readers) ? undefined : 'integration_readership';
  }
  if (egress.contextKey !== undefined && label.key === egress.contextKey) return undefined;
  return readersWithin(egress.readers, label.readers) ? undefined : 'readers_not_covered';
}

function checkSource(
  label: Extract<DiscretionLabel, { kind: 'source' }>,
  egress: DiscretionEgress,
): FlowViolation['reason'] | undefined {
  switch (egress.kind) {
    case 'people':
    case 'memory':
      // People's rights to a system are the audience floor's, checked when the
      // read happened; reuse elsewhere is covered by the context label.
      return undefined;
    case 'agent':
      return egress.grantedSystems.has(label.system) ? undefined : 'agent_lacks_grant';
    case 'integration':
      if (label.system === egress.system || !label.restricted) return undefined;
      if (!egress.readership) return 'integration_undeclared';
      return egress.readership.acceptsSystems.includes(label.system) ? undefined : 'integration_readership';
  }
}

function checkClassification(
  label: Extract<DiscretionLabel, { kind: 'classification' }>,
  egress: DiscretionEgress,
): FlowViolation['reason'] | undefined {
  switch (egress.kind) {
    case 'people':
      // The model saw a classified field unmasked (an operator bypass, maybe in
      // an earlier turn this one reused): every reader must hold the right to
      // that classification (criterion 18), else the answer is refused whole.
      return allowsFieldClass(egress.fieldClasses, label.class) ? undefined : 'readers_lack_field_right';
    case 'memory':
      // Within the conversation the context label decides who reads the tier.
      return undefined;
    case 'agent':
      return 'classification_not_accepted';
    case 'integration':
      if (!egress.readership) return 'integration_undeclared';
      return egress.readership.acceptsClassifications.includes(label.class)
        ? undefined
        : 'classification_not_accepted';
  }
}

/** Check `labels` against one egress. Deterministic and side-effect free. */
export function checkFlow(labels: LabelSet, egress: DiscretionEgress): FlowDecision {
  const violations: FlowViolation[] = [];
  for (const label of labels.labels) {
    let reason: FlowViolation['reason'] | undefined;
    if (label.kind === 'context') reason = checkContext(label, egress);
    else if (label.kind === 'source') reason = checkSource(label, egress);
    else reason = checkClassification(label, egress);
    if (reason !== undefined) violations.push({ label, reason });
  }
  return violations.length === 0 ? { allowed: true } : { allowed: false, violations };
}

/** Audit-safe summary of a refusal: label ids and reasons, never content. */
export function violationSummary(decision: FlowDecision): string[] {
  if (decision.allowed) return [];
  return decision.violations.map((v) => `${labelId(v.label)}:${v.reason}`);
}
