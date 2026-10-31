/**
 * Field classification — a stored candidate's status NOW: the classifier on
 * the stored inputs (relations, sample verdict, cached schema verdicts) with
 * the current `non_personal_fields` value and the decision laid over it.
 * Shared by the admin routes, bulk accept and the auto-approval dry run.
 */

import type { Request } from 'express';

import { auditActorFromRequest } from '../../auth/adminAuditLog.js';
import type { AutoApproveSubject } from './autoApprovePass.js';
import {
  candidateFingerprint,
  classifyBase,
  configCoverage,
  resolveStatus,
  sourceKeyOf,
  type FieldReason,
  type FieldStatus,
  type ModelVerdictSummary,
} from './engine.js';
import { MODEL_VERDICT_TTL_MS, fieldKeyOf } from './recompute.js';
import type { CandidateDecision, FieldCandidate, FieldClassificationStore } from './store.js';

/** Cached schema verdicts for every relation target and source of
 *  `candidates` — only those younger than the recompute's TTL
 *  (`MODEL_VERDICT_TTL_MS`): an expired verdict never decides a status here
 *  either (the next recompute asks again). */
export async function cachedVerdicts(
  store: FieldClassificationStore,
  candidates: readonly FieldCandidate[],
  now: Date = new Date(),
): Promise<Map<string, ModelVerdictSummary>> {
  const keys = [
    ...new Set(
      candidates.flatMap((c) => (c.relationModels.length > 0 ? c.relationModels : [sourceKeyOf(c)])),
    ),
  ];
  const rows = await store.modelVerdicts(keys, new Date(now.getTime() - MODEL_VERDICT_TTL_MS));
  return new Map(rows.map((r) => [r.model, { verdict: r.verdict, confidence: r.confidence }]));
}

/** The classifier's input for a stored candidate (no config, no decision). */
function inputOf(
  candidate: FieldCandidate,
  verdicts: ReadonlyMap<string, ModelVerdictSummary>,
): AutoApproveSubject['input'] {
  return {
    ...fieldKeyOf(candidate),
    valueShape: candidate.valueShape,
    relationModels: candidate.relationModels,
    ...(candidate.sampleVerdict !== null ? { sample: candidate.sampleVerdict } : {}),
    modelVerdicts: verdicts,
  };
}

/** What the classifier itself says about a stored candidate (no config,
 *  no decision). */
export function baseOf(
  candidate: FieldCandidate,
  verdicts: ReadonlyMap<string, ModelVerdictSummary>,
): ReturnType<typeof classifyBase> {
  // Same input as the recompute: a field only read from the schema says so.
  return classifyBase({ ...inputOf(candidate, verdicts), seenInChat: candidate.seenCount > 0 });
}

/** The status of a stored candidate under the CURRENT config and decision. */
export function liveStatus(
  candidate: FieldCandidate,
  rawConfig: string | undefined,
  verdicts: ReadonlyMap<string, ModelVerdictSummary>,
  decision: CandidateDecision | null = candidate.decision,
): { status: FieldStatus; reasons: readonly FieldReason[] } {
  const base = baseOf(candidate, verdicts);
  return resolveStatus(base, candidate.fingerprint, configCoverage(rawConfig, candidate), decision);
}

/** A stored candidate as the auto-approval planner sees it (dry run). */
export function subjectOf(
  candidate: FieldCandidate,
  verdicts: ReadonlyMap<string, ModelVerdictSummary>,
): AutoApproveSubject {
  const input = inputOf(candidate, verdicts);
  return {
    candidate,
    input,
    // A row never classified yet has no stored fingerprint.
    fingerprint:
      candidate.fingerprint.length > 0
        ? candidate.fingerprint
        : candidateFingerprint({
            scope: candidate.scope,
            relationModels: candidate.relationModels,
            valueShape: candidate.valueShape,
          }),
    base: baseOf(candidate, verdicts),
  };
}

/** Whose "last visit" of the page a request reads and writes. */
export function fieldVisitorKey(req: Request): string {
  const actor = auditActorFromRequest(req);
  return actor.id ?? actor.email ?? req.session?.sub ?? 'admin';
}
