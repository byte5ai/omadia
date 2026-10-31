/**
 * Field classification — the auto-approval step of a recompute pass, and the
 * dry run (`POST /recompute?dryRun=1`) that reports what it WOULD do.
 *
 * Per pass, from the fresh classification of every candidate:
 *   - approve: switch on, `autoApprovalOf` eligible (no decision, not
 *     covered) → append the scoped entry; decision `auto_approve`;
 *   - revoke: an `auto_approve` decision whose field now hits a safeguard
 *     (person target, detector hit / near-miss, conflicting targets …) →
 *     remove exactly its scoped entry; decision `auto_revoke`. Runs with the
 *     switch off too: turning it off stops NEW approvals and keeps the ones
 *     made (no mass revoke), but a drifted field is still taken out;
 *   - refresh: an `auto_approve` decision on an older fingerprint whose field
 *     is still eligible and still listed → the decision moves to the current
 *     fingerprint (switch on only; off, it stays a conflict for the admin).
 * ONE config write for all of it through the shared editor (plugin lock),
 * then one decision and one audit row per field (actor
 * `system:auto-classifier`). A decision that cannot be saved takes its
 * appended entry out again. At most `AUTO_APPROVE_MAX_PER_PASS` approvals a
 * pass; the log line carries counts only.
 */

import { systemAuditActor, type AdminAuditLog } from '../../auth/adminAuditLog.js';
import {
  AUTO_APPROVE_MAX_PER_PASS,
  AUTO_CLASSIFIER_ACTOR,
  autoApprovalOf,
  isSafetyBlock,
  type AutoApprovalBasis,
  type AutoApprovalBlock,
  type AutoApprovalInput,
  type AutoApproveSettings,
} from './autoApprove.js';
import type { NonPersonalFieldsEditor } from './configEditor.js';
import {
  appendConfigEntry,
  configCoverage,
  configEntryOf,
  fieldAuditTarget,
  removeConfigEntry,
  resolveStatus,
  type BaseStatus,
  type FieldReason,
} from './engine.js';
import type { CandidateDecision, FieldCandidate, FieldClassificationStore } from './store.js';

export const FIELD_AUTO_APPROVE_AUDIT_ACTION = 'privacy.field_auto_approve';
export const FIELD_AUTO_REVOKE_AUDIT_ACTION = 'privacy.field_auto_revoke';

/** One classified candidate, as the pass sees it. */
export interface AutoApproveSubject {
  readonly candidate: FieldCandidate;
  /** The classifier input (relations, sample, verdicts) of this pass. */
  readonly input: Omit<AutoApprovalInput, 'coverage' | 'decision'>;
  readonly fingerprint: string;
  readonly base: { readonly status: BaseStatus; readonly reasons: readonly FieldReason[] };
}

export interface PlannedApproval {
  readonly subject: AutoApproveSubject;
  readonly basis: AutoApprovalBasis;
  readonly confidence?: number;
  readonly entry: string;
}

export interface AutoApprovePlan {
  readonly approve: readonly PlannedApproval[];
  readonly refresh: readonly PlannedApproval[];
  readonly revoke: readonly { readonly subject: AutoApproveSubject; readonly reason: AutoApprovalBlock }[];
  /** Eligible fields left for the next pass (over the cap). */
  readonly remaining: number;
  /** Why the other fields are not approved, per reason. */
  readonly blocked: Readonly<Record<string, number>>;
}

/** Fields whose `auto_approve` decision is still in force. */
function isAutoApproved(c: FieldCandidate): boolean {
  return c.decision?.action === 'auto_approve';
}

/** Decide, without writing anything, what the pass does. */
export function planAutoApprove(
  subjects: readonly AutoApproveSubject[],
  rawConfig: string | undefined,
  settings: AutoApproveSettings,
  maxPerPass: number = AUTO_APPROVE_MAX_PER_PASS,
): AutoApprovePlan {
  const approve: PlannedApproval[] = [];
  const refresh: PlannedApproval[] = [];
  const revoke: { subject: AutoApproveSubject; reason: AutoApprovalBlock }[] = [];
  const blocked: Record<string, number> = {};
  let remaining = 0;
  for (const subject of subjects) {
    const { candidate } = subject;
    const coverage = configCoverage(rawConfig, candidate);
    if (isAutoApproved(candidate)) {
      // Safeguards first: what the field is now, regardless of decision/config.
      const now = autoApprovalOf({ ...subject.input, decision: null }, settings);
      if (!now.eligible && isSafetyBlock(now.reason)) {
        revoke.push({ subject, reason: now.reason });
      } else if (
        now.eligible &&
        settings.enabled &&
        coverage.exact &&
        candidate.decision?.fingerprint !== subject.fingerprint
      ) {
        refresh.push({ subject, ...withoutFlag(now) });
      }
      continue;
    }
    const approval = autoApprovalOf(
      { ...subject.input, coverage, decision: candidate.decision },
      settings,
    );
    if (!approval.eligible) {
      blocked[approval.reason] = (blocked[approval.reason] ?? 0) + 1;
      continue;
    }
    if (!settings.enabled) {
      blocked['disabled'] = (blocked['disabled'] ?? 0) + 1;
      continue;
    }
    if (approve.length >= maxPerPass) {
      remaining += 1;
      continue;
    }
    approve.push({ subject, ...withoutFlag(approval) });
  }
  return { approve, refresh, revoke, remaining, blocked };
}

function withoutFlag(a: {
  basis: AutoApprovalBasis;
  confidence?: number;
  entry: string;
}): Omit<PlannedApproval, 'subject'> {
  return {
    basis: a.basis,
    entry: a.entry,
    ...(a.confidence !== undefined ? { confidence: a.confidence } : {}),
  };
}

export interface AutoApprovePassDeps {
  readonly store: FieldClassificationStore;
  readonly editor: Pick<NonPersonalFieldsEditor, 'edit'>;
  readonly audit?: Pick<AdminAuditLog, 'record'>;
  readonly now: Date;
  readonly log: (msg: string) => void;
}

export interface AutoApprovePassResult {
  readonly approved: number;
  readonly revoked: number;
  readonly refreshed: number;
  readonly remaining: number;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function systemDecision(
  action: 'auto_approve' | 'auto_revoke',
  fingerprint: string,
  at: string,
): CandidateDecision {
  return { action, fingerprint, byId: null, byEmail: AUTO_CLASSIFIER_ACTOR, at, batchId: null };
}

async function audit(
  deps: AutoApprovePassDeps,
  action: typeof FIELD_AUTO_APPROVE_AUDIT_ACTION | typeof FIELD_AUTO_REVOKE_AUDIT_ACTION,
  candidate: FieldCandidate,
  after: Record<string, unknown>,
): Promise<void> {
  if (deps.audit === undefined) return;
  try {
    await deps.audit.record({
      actor: systemAuditActor(AUTO_CLASSIFIER_ACTOR),
      action,
      target: fieldAuditTarget(candidate),
      after,
    });
  } catch (err) {
    deps.log(`[privacy-fields] auto-approve audit write failed: ${errorText(err)}`);
  }
}

/** Save the decision with the status it yields under `config`. */
async function saveSystemDecision(
  deps: AutoApprovePassDeps,
  subject: AutoApproveSubject,
  decision: CandidateDecision,
  config: string,
): Promise<boolean> {
  const shown = resolveStatus(
    subject.base,
    subject.fingerprint,
    configCoverage(config, subject.candidate),
    decision,
  );
  try {
    await deps.store.saveDecision(subject.candidate.id, decision, shown.status);
    return true;
  } catch (err) {
    deps.log(`[privacy-fields] auto-approve decision write failed: ${errorText(err)}`);
    return false;
  }
}

/** Apply `plan`: one config write, then a decision + audit row per field. */
export async function applyAutoApprovePlan(
  plan: AutoApprovePlan,
  deps: AutoApprovePassDeps,
): Promise<AutoApprovePassResult> {
  const empty = { approved: 0, revoked: 0, refreshed: 0, remaining: plan.remaining };
  if (plan.approve.length === 0 && plan.revoke.length === 0 && plan.refresh.length === 0) return empty;
  const added = new Set<string>();
  const removed = new Set<string>();
  let change: { after: string; guardId: string };
  try {
    change = await deps.editor.edit((before) => {
      let next = before;
      for (const { subject } of plan.revoke) {
        if (!configCoverage(next, subject.candidate).exact) continue;
        next = removeConfigEntry(next, subject.candidate);
        removed.add(subject.candidate.id);
      }
      for (const { subject } of plan.approve) {
        // Covered meanwhile (an admin, a legacy entry): not ours to own.
        if (configCoverage(next, subject.candidate).covered) continue;
        next = appendConfigEntry(next, subject.candidate);
        added.add(subject.candidate.id);
      }
      return next;
    });
  } catch (err) {
    deps.log(`[privacy-fields] auto-approve config write failed: ${errorText(err)}`);
    return empty;
  }

  const at = deps.now.toISOString();
  let revoked = 0;
  for (const { subject, reason } of plan.revoke) {
    const decision = systemDecision('auto_revoke', subject.fingerprint, at);
    if (!(await saveSystemDecision(deps, subject, decision, change.after))) continue;
    revoked += 1;
    await audit(deps, FIELD_AUTO_REVOKE_AUDIT_ACTION, subject.candidate, {
      reason,
      entry: configEntryOf(subject.candidate),
      removed: removed.has(subject.candidate.id),
      plugin: change.guardId,
    });
  }

  let approved = 0;
  const failed: AutoApproveSubject[] = [];
  for (const planned of plan.approve.filter((p) => added.has(p.subject.candidate.id))) {
    const decision = systemDecision('auto_approve', planned.subject.fingerprint, at);
    if (!(await saveSystemDecision(deps, planned.subject, decision, change.after))) {
      failed.push(planned.subject);
      continue;
    }
    approved += 1;
    await audit(deps, FIELD_AUTO_APPROVE_AUDIT_ACTION, planned.subject.candidate, approvalAfter(planned, change.guardId));
  }
  // No entry without its decision row: take the unrecorded ones out again.
  if (failed.length > 0) {
    await deps.editor
      .edit((before) => failed.reduce((next, s) => removeConfigEntry(next, s.candidate), before))
      .catch((err: unknown) => {
        deps.log(`[privacy-fields] auto-approve rollback failed: ${errorText(err)}`);
      });
  }

  let refreshed = 0;
  for (const planned of plan.refresh) {
    const decision = systemDecision('auto_approve', planned.subject.fingerprint, at);
    if (!(await saveSystemDecision(deps, planned.subject, decision, change.after))) continue;
    refreshed += 1;
    await audit(deps, FIELD_AUTO_APPROVE_AUDIT_ACTION, planned.subject.candidate, {
      ...approvalAfter(planned, change.guardId),
      refreshed: true,
    });
  }
  return { approved, revoked, refreshed, remaining: plan.remaining };
}

function approvalAfter(planned: PlannedApproval, guardId: string): Record<string, unknown> {
  return {
    basis: planned.basis,
    ...(planned.confidence !== undefined ? { confidence: planned.confidence } : {}),
    entry: planned.entry,
    plugin: guardId,
  };
}

// ---------------------------------------------------------------------------
// Dry run
// ---------------------------------------------------------------------------

/** Most sample rows a dry-run report lists. */
export const DRY_RUN_SAMPLE_LIMIT = 50;

export interface AutoApproveDryRunReport {
  readonly dryRun: true;
  /** The switch as configured; the report shows what an ON switch would do. */
  readonly enabled: boolean;
  readonly threshold: number;
  readonly candidates: number;
  readonly eligible: number;
  readonly cap: number;
  readonly byBasis: Readonly<Record<AutoApprovalBasis, number>>;
  readonly byTool: Readonly<Record<string, number>>;
  /** Per source, `<tool>:<scope>`. */
  readonly byScope: Readonly<Record<string, number>>;
  readonly blocked: Readonly<Record<string, number>>;
  /** Auto-approved fields a pass would revoke now. */
  readonly wouldRevoke: number;
  readonly sample: readonly {
    readonly id: string;
    readonly toolName: string;
    readonly scope: string;
    readonly fieldPath: string;
    readonly relationModels: readonly string[];
    readonly basis: AutoApprovalBasis;
    readonly confidence?: number;
    readonly entry: string;
  }[];
}

/** What a pass would approve now — names, counts and verdicts, no value. */
export function autoApproveDryRun(
  subjects: readonly AutoApproveSubject[],
  rawConfig: string | undefined,
  settings: AutoApproveSettings,
  sampleLimit: number = DRY_RUN_SAMPLE_LIMIT,
): AutoApproveDryRunReport {
  // Uncapped and with the switch on: the report counts every eligible field.
  const plan = planAutoApprove(subjects, rawConfig, { ...settings, enabled: true }, Number.MAX_SAFE_INTEGER);
  const byBasis: Record<AutoApprovalBasis, number> = { known_non_personal: 0, haiku: 0 };
  const byTool: Record<string, number> = {};
  const byScope: Record<string, number> = {};
  for (const p of plan.approve) {
    const c = p.subject.candidate;
    byBasis[p.basis] += 1;
    byTool[c.toolName] = (byTool[c.toolName] ?? 0) + 1;
    const source = `${c.toolName}:${c.scope}`;
    byScope[source] = (byScope[source] ?? 0) + 1;
  }
  return {
    dryRun: true,
    enabled: settings.enabled,
    threshold: settings.confidence,
    candidates: subjects.length,
    eligible: plan.approve.length,
    cap: AUTO_APPROVE_MAX_PER_PASS,
    byBasis,
    byTool,
    byScope,
    blocked: plan.blocked,
    wouldRevoke: plan.revoke.length,
    sample: plan.approve.slice(0, sampleLimit).map((p) => ({
      id: p.subject.candidate.id,
      toolName: p.subject.candidate.toolName,
      scope: p.subject.candidate.scope,
      fieldPath: p.subject.candidate.fieldPath,
      relationModels: p.subject.input.relationModels,
      basis: p.basis,
      ...(p.confidence !== undefined ? { confidence: p.confidence } : {}),
      entry: p.entry,
    })),
  };
}
