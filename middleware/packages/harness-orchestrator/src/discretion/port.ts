/**
 * Spec 2042 §5.11 — what the agent runtime needs from the kernel to keep
 * discretion: the operator's integration declarations, persisted labels, and
 * the audit. Implemented by the kernel over Postgres (`src/discretion/`);
 * absent when no database is wired, and then nothing is labelled persistently
 * and outbound calls are checked against "undeclared".
 */

import type { IntegrationReadership } from './flowRule.js';
import type { LabelSet } from './labels.js';

export type IntegrationSensitivity = 'internal' | 'restricted';

export interface IntegrationDeclaration {
  readonly sensitivity: IntegrationSensitivity;
  readonly readership: IntegrationReadership;
}

export type LabelSubjectKind = 'turn' | 'memorable';

export interface DiscretionAuditEntry {
  readonly turnId?: string;
  readonly agentSlug?: string;
  readonly egress: 'people' | 'agent' | 'memory' | 'integration';
  /** Agent slug, integration id or conversation key; never content. */
  readonly target?: string;
  readonly allowed: boolean;
  readonly labels: readonly string[];
  readonly violations: readonly string[];
}

export interface DiscretionPort {
  /** The operator's declaration for an integration; undefined = undeclared. */
  declarationOf(integration: string): Promise<IntegrationDeclaration | undefined>;
  /** Persisted label sets of written subjects (missing ids are absent). */
  labelsOf(kind: LabelSubjectKind, ids: readonly string[]): Promise<ReadonlyMap<string, LabelSet>>;
  /** Persist the label set a written subject keeps. */
  persistLabels(kind: LabelSubjectKind, id: string, agentSlug: string, labels: LabelSet): Promise<void>;
  /** Record a flow decision. Never throws; never receives content. */
  audit(entry: DiscretionAuditEntry): void;
}
