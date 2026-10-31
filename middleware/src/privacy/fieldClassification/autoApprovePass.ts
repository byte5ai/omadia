/**
 * Field classification — the auto-approval step of a recompute pass, and the
 * dry run (`POST /recompute?dryRun=1`) that reports what it WOULD do.
 *
 * Per pass, from the fresh classification of every candidate:
 *   - approve: switch on, `autoApprovalOf` eligible (no decision, not
 *     covered) → append the scoped entry; decision `auto_approve`;
 *   - revoke: an `auto_approve` decision whose field is no longer eligible
 *     for ANY reason — judged with its own decision and its own entry
 *     ignored (person target / scope, detector hit / near-miss, conflict, a
 *     verdict that flipped or fell below the threshold, a new target without
 *     a verdict, a legacy entry covering it …) → remove exactly its scoped
 *     entry; decision `auto_revoke`. Runs with the switch off too: turning it
 *     off stops NEW approvals and keeps the ones made (no mass revoke), but a
 *     field that is no longer eligible is still taken out. An auto-approved
 *     field the guard still sees (it buffers the values of cleared fields
 *     too) is re-vetted every pass, so a detector hit revokes it here;
 *   - refresh: an `auto_approve` decision on an older fingerprint whose field
 *     is still eligible and still listed → the decision moves to the current
 *     fingerprint (switch on only; off, it stays a conflict for the admin).
 *     Basis `haiku` needs a FRESH clean vet of this pass for that; without
 *     one the approval is revoked (`no_fresh_vet`).
 * ONE config write for all of it through the shared editor (plugin lock).
 * Inside the lock each candidate's decision is re-read: one an admin (or
 * anything else) changed since the pass read it is skipped, never
 * overwritten. Then one compare-and-set decision and one audit row per field
 * (actor `system:auto-classifier`, decided at the time of the write). A
 * decision that cannot be saved takes its appended entry out again; a
 * failure on one field never stops the others. At most
 * `AUTO_APPROVE_MAX_PER_PASS` approvals a pass; the log line carries counts
 * only.
 */

import { systemAuditActor, type AdminAuditLog } from '../../auth/adminAuditLog.js';
import {
  AUTO_APPROVE_MAX_PER_PASS,
  AUTO_APPROVE_MIN_SAMPLE,
  AUTO_CLASSIFIER_ACTOR,
  autoApprovalOf,
  entryOf,
  type AutoApprovalBasis,
  type AutoApprovalBlock,
  type AutoApprovalInput,
  type AutoApproveSettings,
} from './autoApprove.js';
import type { NonPersonalFieldsEditor } from './configEditor.js';
import {
  appendConfigEntry,
  configCoverage,
  fieldAuditTarget,
  removeConfigEntry,
  resolveStatus,
  type BaseStatus,
  type FieldReason,
  type SampleVerdictSummary,
} from './engine.js';
import {
  sameDecision,
  type CandidateDecision,
  type DecisionExpectation,
  type FieldCandidate,
  type FieldClassificationStore,
} from './store.js';

export const FIELD_AUTO_APPROVE_AUDIT_ACTION = 'privacy.field_auto_approve';
export const FIELD_AUTO_REVOKE_AUDIT_ACTION = 'privacy.field_auto_revoke';

/** One classified candidate, as the pass sees it. */
export interface AutoApproveSubject {
  readonly candidate: FieldCandidate;
  /** The classifier input (relations, sample, verdicts) of this pass. */
  readonly input: Omit<AutoApprovalInput, 'coverage' | 'decision'>;
  readonly fingerprint: string;
  readonly base: { readonly status: BaseStatus; readonly reasons: readonly FieldReason[] };
  /** The vet THIS pass made (non-empty), if any — a refresh on a changed
   *  fingerprint with basis `haiku` requires a clean one. */
  readonly freshSample?: SampleVerdictSummary;
}

export interface PlannedApproval {
  readonly subject: AutoApproveSubject;
  readonly basis: AutoApprovalBasis;
  readonly confidence?: number;
  readonly entry: string;
}

/** Why an auto-approval is revoked. */
export type AutoRevokeReason = AutoApprovalBlock | 'no_fresh_vet';

export interface AutoApprovePlan {
  readonly approve: readonly PlannedApproval[];
  readonly refresh: readonly PlannedApproval[];
  readonly revoke: readonly { readonly subject: AutoApproveSubject; readonly reason: AutoRevokeReason }[];
  /** Eligible fields left for the next pass (over the cap). */
  readonly remaining: number;
  /** Why the other fields are not approved, per reason. */
  readonly blocked: Readonly<Record<string, number>>;
}

/** Fields whose `auto_approve` decision is still in force. */
function isAutoApproved(c: FieldCandidate): boolean {
  return c.decision?.action === 'auto_approve';
}

/** A clean vet of this pass over enough values. */
function hasFreshCleanVet(subject: AutoApproveSubject): boolean {
  const fresh = subject.freshSample;
  return (
    fresh !== undefined &&
    !fresh.identityHit &&
    fresh.c1 === 'clean' &&
    fresh.sampleCount >= AUTO_APPROVE_MIN_SAMPLE
  );
}

type PlanStep =
  | { readonly kind: 'revoke'; readonly reason: AutoRevokeReason }
  | { readonly kind: 'refresh'; readonly approval: Omit<PlannedApproval, 'subject'> }
  | { readonly kind: 'keep' };

/** What happens to a field the recompute auto-approved earlier. */
function planAutoApproved(
  subject: AutoApproveSubject,
  rawConfig: string | undefined,
  settings: AutoApproveSettings,
): PlanStep {
  const { candidate } = subject;
  // Eligible as if it were undecided and its own entry were not there: any
  // other cover (a legacy entry) counts against it like for a new field.
  const others = configCoverage(removeConfigEntry(rawConfig, candidate), candidate);
  const now = autoApprovalOf({ ...subject.input, decision: null, coverage: others }, settings);
  if (!now.eligible) return { kind: 'revoke', reason: now.reason };
  if (candidate.decision?.fingerprint === subject.fingerprint) return { kind: 'keep' };
  // The field changed since the approval: a schema verdict alone does not
  // carry over — it needs this pass's values to be vetted clean.
  if (now.basis === 'haiku' && !hasFreshCleanVet(subject)) return { kind: 'revoke', reason: 'no_fresh_vet' };
  if (settings.enabled && configCoverage(rawConfig, candidate).exact) {
    return { kind: 'refresh', approval: withoutFlag(now) };
  }
  return { kind: 'keep' };
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
  const revoke: { subject: AutoApproveSubject; reason: AutoRevokeReason }[] = [];
  const blocked: Record<string, number> = {};
  let remaining = 0;
  for (const subject of subjects) {
    const { candidate } = subject;
    if (isAutoApproved(candidate)) {
      const step = planAutoApproved(subject, rawConfig, settings);
      if (step.kind === 'revoke') revoke.push({ subject, reason: step.reason });
      else if (step.kind === 'refresh') refresh.push({ subject, ...step.approval });
      continue;
    }
    const approval = autoApprovalOf(
      { ...subject.input, coverage: configCoverage(rawConfig, candidate), decision: candidate.decision },
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
  /** The clock; read when each decision is written. */
  readonly now: () => Date;
  readonly log: (msg: string) => void;
}

export interface AutoApprovePassResult {
  readonly approved: number;
  readonly revoked: number;
  readonly refreshed: number;
  readonly remaining: number;
  /** Fields skipped because their decision changed while the pass ran. */
  readonly stale: number;
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

/** The decision + fingerprint the plan was made on: the CAS expectation. */
function expectationOf(subject: AutoApproveSubject): DecisionExpectation {
  return { decision: subject.candidate.decision, fingerprint: subject.fingerprint };
}

/** Still as planned (inside the lock): nobody decided meanwhile. */
async function isUnchanged(deps: AutoApprovePassDeps, subject: AutoApproveSubject): Promise<boolean> {
  try {
    const fresh = await deps.store.get(subject.candidate.id);
    return (
      fresh !== undefined &&
      fresh.fingerprint === subject.fingerprint &&
      sameDecision(fresh.decision, subject.candidate.decision)
    );
  } catch (err) {
    deps.log(`[privacy-fields] auto-approve re-read failed: ${errorText(err)}`);
    return false;
  }
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

/** Compare-and-set the decision with the status it yields under `config`.
 *  False when it was not written (changed meanwhile, or the write failed). */
async function saveSystemDecision(
  deps: AutoApprovePassDeps,
  subject: AutoApproveSubject,
  action: 'auto_approve' | 'auto_revoke',
  config: string,
): Promise<boolean> {
  const decision = systemDecision(action, subject.fingerprint, deps.now().toISOString());
  const shown = resolveStatus(
    subject.base,
    subject.fingerprint,
    configCoverage(config, subject.candidate),
    decision,
  );
  try {
    const saved = await deps.store.saveDecision(subject.candidate.id, decision, shown.status, expectationOf(subject));
    if (!saved) deps.log('[privacy-fields] auto-approve decision skipped: changed meanwhile');
    return saved;
  } catch (err) {
    deps.log(`[privacy-fields] auto-approve decision write failed: ${errorText(err)}`);
    return false;
  }
}

/** What the single config write did. */
interface Applied {
  readonly revoke: { readonly subject: AutoApproveSubject; readonly reason: AutoRevokeReason; readonly removed: boolean }[];
  readonly approve: PlannedApproval[];
  readonly refresh: PlannedApproval[];
  stale: number;
}

/** The config edit of the pass, run inside the plugin lock. */
async function editConfig(plan: AutoApprovePlan, deps: AutoApprovePassDeps, before: string, applied: Applied): Promise<string> {
  let next = before;
  for (const { subject, reason } of plan.revoke) {
    if (!(await isUnchanged(deps, subject))) {
      applied.stale += 1;
      continue;
    }
    const exact = configCoverage(next, subject.candidate).exact;
    if (exact) next = removeConfigEntry(next, subject.candidate);
    applied.revoke.push({ subject, reason, removed: exact });
  }
  for (const planned of plan.approve) {
    // Covered meanwhile (an admin, a legacy entry): not ours to own.
    if (configCoverage(next, planned.subject.candidate).covered) continue;
    if (!(await isUnchanged(deps, planned.subject))) {
      applied.stale += 1;
      continue;
    }
    try {
      next = appendConfigEntry(next, planned.subject.candidate);
      applied.approve.push(planned);
    } catch (err) {
      deps.log(`[privacy-fields] auto-approve entry skipped: ${errorText(err)}`);
    }
  }
  for (const planned of plan.refresh) {
    if (await isUnchanged(deps, planned.subject)) applied.refresh.push(planned);
    else applied.stale += 1;
  }
  return next;
}

/** Apply `plan`: one config write, then a decision + audit row per field. */
export async function applyAutoApprovePlan(
  plan: AutoApprovePlan,
  deps: AutoApprovePassDeps,
): Promise<AutoApprovePassResult> {
  const empty = { approved: 0, revoked: 0, refreshed: 0, remaining: plan.remaining, stale: 0 };
  if (plan.approve.length === 0 && plan.revoke.length === 0 && plan.refresh.length === 0) return empty;
  const applied: Applied = { revoke: [], approve: [], refresh: [], stale: 0 };
  let change: { after: string; guardId: string };
  try {
    change = await deps.editor.edit((before) => editConfig(plan, deps, before, applied));
  } catch (err) {
    deps.log(`[privacy-fields] auto-approve config write failed: ${errorText(err)}`);
    return empty;
  }

  let revoked = 0;
  for (const item of applied.revoke) {
    try {
      if (await revokeOne(deps, item, change)) revoked += 1;
    } catch (err) {
      // The entry is out already (fail safe: masked); only the row is missing.
      deps.log(`[privacy-fields] auto-revoke failed: ${errorText(err)}`);
    }
  }

  let approved = 0;
  const failed: AutoApproveSubject[] = [];
  for (const planned of applied.approve) {
    try {
      if (!(await saveSystemDecision(deps, planned.subject, 'auto_approve', change.after))) {
        failed.push(planned.subject);
        continue;
      }
      approved += 1;
      await audit(deps, FIELD_AUTO_APPROVE_AUDIT_ACTION, planned.subject.candidate, approvalAfter(planned, change.guardId));
    } catch (err) {
      deps.log(`[privacy-fields] auto-approve failed: ${errorText(err)}`);
      failed.push(planned.subject);
    }
  }
  // No entry without its decision row: take the unrecorded ones out again.
  if (failed.length > 0) await rollBack(deps, failed);

  let refreshed = 0;
  for (const planned of applied.refresh) {
    try {
      if (!(await saveSystemDecision(deps, planned.subject, 'auto_approve', change.after))) continue;
      refreshed += 1;
      await audit(deps, FIELD_AUTO_APPROVE_AUDIT_ACTION, planned.subject.candidate, {
        ...approvalAfter(planned, change.guardId),
        refreshed: true,
      });
    } catch (err) {
      deps.log(`[privacy-fields] auto-approve refresh failed: ${errorText(err)}`);
    }
  }
  return { approved, revoked, refreshed, remaining: plan.remaining, stale: applied.stale };
}

async function revokeOne(
  deps: AutoApprovePassDeps,
  item: Applied['revoke'][number],
  change: { after: string; guardId: string },
): Promise<boolean> {
  const { subject, reason, removed } = item;
  if (!(await saveSystemDecision(deps, subject, 'auto_revoke', change.after))) return false;
  // A legacy / wildcard entry still clears the field: the row says so.
  const legacy = configCoverage(change.after, subject.candidate).legacyEntry;
  const entry = entryOf(subject.candidate);
  await audit(deps, FIELD_AUTO_REVOKE_AUDIT_ACTION, subject.candidate, {
    reason,
    ...(entry !== undefined ? { entry } : {}),
    removed,
    ...(legacy !== undefined ? { legacyStillCovers: legacy } : {}),
    plugin: change.guardId,
  });
  return true;
}

async function rollBack(deps: AutoApprovePassDeps, failed: readonly AutoApproveSubject[]): Promise<void> {
  try {
    await deps.editor.edit((before) => failed.reduce((next, s) => removeConfigEntry(next, s.candidate), before));
  } catch (err) {
    deps.log(`[privacy-fields] auto-approve rollback failed: ${errorText(err)}`);
  }
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
