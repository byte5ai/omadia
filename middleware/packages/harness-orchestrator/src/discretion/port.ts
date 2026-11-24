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

/**
 * What a persisted label set belongs to: a written turn, a memorable, a note
 * of the memory tool (by its physical store path, so every tier that reads
 * the same file finds its labels), or a stored process (by its id; #2194).
 * A plan has no subject of its own: it keeps the id of the turn that wrote
 * it, and that turn's labels are the plan's.
 */
export type LabelSubjectKind = 'turn' | 'memorable' | 'memory_file' | 'process';

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
  /**
   * #2198 — add `labels` to what a subject keeps, atomically: two writers at
   * once both end up in the stored set. Optional: absent = read, union and
   * persist (`mergeSubjectLabels`), which a concurrent writer can overtake.
   */
  mergeLabels?(kind: LabelSubjectKind, id: string, agentSlug: string, labels: LabelSet): Promise<void>;
  /** Drop a subject's labels (a deleted or renamed note). Optional: absent = kept. */
  dropLabels?(kind: LabelSubjectKind, id: string): Promise<void>;
  /**
   * What a plugin's tool declared in its manifest (`capabilities[].side_effects`);
   * `unknown` when it declared nothing or the plugin is not known. Optional:
   * absent = every such tool is `unknown`.
   */
  toolEffectOf?(system: string, toolName: string): 'read' | 'write' | 'none' | 'unknown';
  /**
   * The effect of a plugin's sub-agent as a whole (its `query_<plugin>` domain
   * tool, whose name is no manifest tool id): `write` when any of its tools
   * declared `write`, else `unknown` (a tool may have declared nothing).
   */
  pluginEffectOf?(system: string): 'write' | 'unknown';
  /** Record a flow decision. Never throws; never receives content. */
  audit(entry: DiscretionAuditEntry): void;
}
