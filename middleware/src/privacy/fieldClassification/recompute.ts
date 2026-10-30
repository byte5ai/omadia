/**
 * Field classification (#1556 follow-up) — the recompute pass and its
 * scheduler.
 *
 * One pass: drain the privacy guard's field observations, upsert them as
 * candidates, resolve what each field points to (Odoo `fields_get` only),
 * take the shape-masked preview and THEN vet the value sample (vetting drops
 * the sample) for new/changed candidates or ones without a verdict, ask the
 * guard's small model about unknown non-person relation targets (cached 30
 * days), classify and persist.
 *
 * It NEVER writes the guard's config — it has no writer to call. It runs on
 * lifecycle events (plugin activation/deactivation), every 6 hours and on
 * `POST /recompute`; never per chat turn. Debounced and single-flight.
 */

import {
  PRIVACY_REDACT_SERVICE_NAME,
  type FieldObservation,
  type ModelClassificationRequest,
  type PrivacyGuardService,
} from '@omadia/plugin-api';

import {
  candidateFingerprint,
  classifyBase,
  configCoverage,
  isValidFieldIdentity,
  resolveStatus,
  type ModelVerdictSummary,
  type SampleVerdictSummary,
} from './engine.js';
import { catalogVerdictOf, isPersonModel } from './modelCatalog.js';
import {
  MODEL_NAME,
  ODOO_CLIENT_SERVICE_NAME,
  createOdooRelationResolver,
  type FieldRelationInfo,
  type OdooExecuteClient,
} from './odooRelationResolver.js';
import type { FieldCandidate, FieldClassificationStore } from './store.js';

/** v1 scope: Odoo tools only. */
export const CANDIDATE_TOOL_PREFIX = 'odoo_';
export const MODEL_VERDICT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RECOMPUTE_DEBOUNCE_MS = 5_000;
export const RECOMPUTE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const PREVIEW_LIMIT = 5;

export interface RecomputeDeps {
  readonly store: FieldClassificationStore;
  readonly serviceRegistry: { get<T>(name: string): T | undefined };
  /** The guard's current `non_personal_fields` value. Read-only. */
  readonly readNonPersonalFields: () => string | undefined;
  readonly now?: () => Date;
  readonly log?: (msg: string) => void;
}

export interface RecomputeResult {
  readonly computedAt: string;
  readonly candidates: number;
  readonly observations: number;
}

/** Is any segment of the path a `__k_` link key? */
function hasLinkKeySegment(path: string): boolean {
  return path.split('.').some((segment) => segment.startsWith('__k_'));
}

/**
 * Only `odoo_*` tools, no link keys, no `mixed` shapes are candidates. Tool
 * names, field paths (Odoo field grammar) and source models (Odoo model
 * grammar) are raw tool-result data: anything outside the grammar is dropped
 * here, so the store, the audit log, log lines and — on confirm — the
 * setting only ever see validated names.
 */
export function isCandidateObservation(obs: FieldObservation): boolean {
  return (
    obs.toolName.startsWith(CANDIDATE_TOOL_PREFIX) &&
    isValidFieldIdentity(obs.toolName, obs.fieldPath) &&
    !hasLinkKeySegment(obs.fieldPath) &&
    obs.sourceModels.every((model) => MODEL_NAME.test(model)) &&
    obs.valueShape !== 'mixed'
  );
}

interface Resolved {
  readonly candidate: FieldCandidate;
  readonly relationModels: readonly string[];
  readonly fieldDocs: FieldRelationInfo['fieldDocs'];
  readonly fingerprint: string;
  readonly sample?: SampleVerdictSummary;
  readonly freshSample?: SampleVerdictSummary;
  readonly maskedPreview?: readonly string[];
}

function needsVetting(candidate: FieldCandidate, fingerprint: string): boolean {
  return (
    candidate.fingerprint !== fingerprint ||
    candidate.sampleVerdict === null ||
    candidate.sampleVerdict.sampleCount === 0
  );
}

async function resolveCandidate(
  candidate: FieldCandidate,
  resolver: ReturnType<typeof createOdooRelationResolver>,
  guard: PrivacyGuardService | undefined,
  log: (msg: string) => void,
): Promise<Resolved> {
  const info = await resolver.resolve(candidate.sourceModels, candidate.fieldPath);
  // Odoo unreachable (or one source model unreadable) this pass: keep what the
  // last pass resolved, so a flaky connection does not flip every decided
  // field to "changed".
  const relationModels = info.known ? info.relationModels : candidate.relationModels;
  const fingerprint = candidateFingerprint({
    sourceModels: candidate.sourceModels,
    relationModels,
    valueShape: candidate.valueShape,
  });
  const field = { toolName: candidate.toolName, fieldPath: candidate.fieldPath };
  // Preview BEFORE vetting: vetting drops the guard's sample.
  const maskedPreview = guard?.maskedFieldPreview?.({ ...field, limit: PREVIEW_LIMIT });
  let freshSample: SampleVerdictSummary | undefined;
  if (guard?.vetFieldSample !== undefined && needsVetting(candidate, fingerprint)) {
    try {
      const v = await guard.vetFieldSample(field);
      freshSample = {
        sampleCount: v.sampleCount,
        identityHit: v.identityHit,
        c1: v.c1,
        hitTypes: [...v.hitTypes],
      };
    } catch (err) {
      log(`[privacy-fields] vetFieldSample failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // An empty fresh vet does not erase what an earlier vet saw.
  const sample =
    freshSample !== undefined && (freshSample.sampleCount > 0 || candidate.sampleVerdict === null)
      ? freshSample
      : (candidate.sampleVerdict ?? undefined);
  return {
    candidate,
    relationModels,
    fieldDocs: info.fieldDocs,
    fingerprint,
    ...(sample !== undefined ? { sample } : {}),
    ...(freshSample !== undefined && sample === freshSample ? { freshSample } : {}),
    ...(maskedPreview !== undefined ? { maskedPreview } : {}),
  };
}

/**
 * Unknown relation targets the schema model must judge: only of candidates
 * that reach that step (no person target, no detector veto, every target
 * unknown). Person models are never in the result.
 */
export function modelsNeedingVerdict(resolved: readonly Resolved[]): ModelClassificationRequest[] {
  const byModel = new Map<string, { path: string; label?: string; help?: string }[]>();
  for (const r of resolved) {
    const targets = r.relationModels;
    if (targets.length === 0 || targets.some(isPersonModel)) continue;
    if (r.sample?.identityHit === true || r.sample?.c1 === 'hit') continue;
    if (!targets.every((m) => catalogVerdictOf(m) === 'unknown')) continue;
    for (const model of targets) {
      const fields = byModel.get(model) ?? [];
      const doc = r.fieldDocs.find((d) => d.relation === model);
      if (!fields.some((f) => f.path === r.candidate.fieldPath)) {
        fields.push({
          path: r.candidate.fieldPath,
          ...(doc?.label !== undefined ? { label: doc.label } : {}),
          ...(doc?.help !== undefined ? { help: doc.help } : {}),
        });
      }
      byModel.set(model, fields);
    }
  }
  return [...byModel.entries()]
    .filter(([model]) => !isPersonModel(model))
    .map(([model, fields]) => ({ model, fields }));
}

async function loadModelVerdicts(
  requests: readonly ModelClassificationRequest[],
  deps: RecomputeDeps,
  guard: PrivacyGuardService | undefined,
  now: Date,
): Promise<Map<string, ModelVerdictSummary>> {
  const verdicts = new Map<string, ModelVerdictSummary>();
  if (requests.length === 0) return verdicts;
  const cached = await deps.store.modelVerdicts(
    requests.map((r) => r.model),
    new Date(now.getTime() - MODEL_VERDICT_TTL_MS),
  );
  for (const v of cached) verdicts.set(v.model, { verdict: v.verdict, confidence: v.confidence });
  // A cached `uncertain` (also what "no LLM / call failed" looks like) is
  // asked again every pass; firm verdicts hold for the TTL.
  const missing = requests.filter(
    (r) => verdicts.get(r.model)?.verdict !== 'personal' &&
      verdicts.get(r.model)?.verdict !== 'non-personal' &&
      !isPersonModel(r.model),
  );
  if (missing.length === 0 || guard?.classifyModelsSchemaOnly === undefined) return verdicts;
  try {
    const results = await guard.classifyModelsSchemaOnly(missing);
    const asked = new Set(missing.map((r) => r.model));
    const fresh = results.filter((r) => asked.has(r.model));
    for (const r of fresh) verdicts.set(r.model, { verdict: r.verdict, confidence: r.confidence });
    // Cached as well (the page reads verdicts from the cache), but see above:
    // an `uncertain` one is re-asked next pass.
    await deps.store.saveModelVerdicts(
      fresh.map((r) => ({
          model: r.model,
          verdict: r.verdict,
          source: 'haiku' as const,
          confidence: r.confidence,
          reason: r.reason.slice(0, 500),
        })),
    );
  } catch (err) {
    deps.log?.(
      `[privacy-fields] classifyModelsSchemaOnly failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return verdicts;
}

export async function recomputeFieldClassification(deps: RecomputeDeps): Promise<RecomputeResult> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? (() => undefined);
  const guard = deps.serviceRegistry.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME);

  const observations = (guard?.takeFieldObservations?.() ?? []).filter(isCandidateObservation);
  for (const obs of observations) await deps.store.upsertObservation(obs);

  // Rows stored before the grammar check are never classified (or listed).
  const candidates = (await deps.store.list()).filter((c) =>
    isValidFieldIdentity(c.toolName, c.fieldPath),
  );
  const resolver = createOdooRelationResolver(
    deps.serviceRegistry.get<OdooExecuteClient>(ODOO_CLIENT_SERVICE_NAME),
    { log },
  );
  const resolved: Resolved[] = [];
  for (const candidate of candidates) {
    resolved.push(await resolveCandidate(candidate, resolver, guard, log));
  }

  const modelVerdicts = await loadModelVerdicts(modelsNeedingVerdict(resolved), deps, guard, now);
  const rawConfig = deps.readNonPersonalFields();
  const computedAt = now.toISOString();

  for (const r of resolved) {
    const { candidate } = r;
    const base = classifyBase({
      toolName: candidate.toolName,
      fieldPath: candidate.fieldPath,
      valueShape: candidate.valueShape,
      sourceModels: candidate.sourceModels,
      relationModels: r.relationModels,
      ...(r.sample !== undefined ? { sample: r.sample } : {}),
      modelVerdicts,
    });
    const shown = resolveStatus(
      base,
      r.fingerprint,
      configCoverage(rawConfig, candidate.toolName, candidate.fieldPath),
      candidate.decision,
    );
    await deps.store.saveClassification(candidate.id, {
      relationModels: r.relationModels,
      status: shown.status,
      reasons: shown.reasons,
      fingerprint: r.fingerprint,
      ...(r.freshSample !== undefined ? { sampleVerdict: r.freshSample } : {}),
      ...(r.maskedPreview !== undefined ? { maskedPreview: r.maskedPreview } : {}),
      computedAt,
    });
  }
  log(
    `[privacy-fields] recompute: ${String(observations.length)} observation(s), ${String(candidates.length)} candidate(s)`,
  );
  return { computedAt, candidates: candidates.length, observations: observations.length };
}

// ---------------------------------------------------------------------------
// Scheduler: debounced, single-flight, periodic.
// ---------------------------------------------------------------------------

export interface FieldClassificationScheduler {
  /** Debounced: lifecycle events call this. */
  trigger(reason: string): void;
  /** Immediate (joins a running pass, then runs once more if one was queued). */
  runNow(): Promise<RecomputeResult | undefined>;
  start(): void;
  stop(): void;
}

export function createFieldClassificationScheduler(opts: {
  readonly run: () => Promise<RecomputeResult>;
  readonly debounceMs?: number;
  readonly intervalMs?: number;
  readonly log?: (msg: string) => void;
}): FieldClassificationScheduler {
  const debounceMs = opts.debounceMs ?? RECOMPUTE_DEBOUNCE_MS;
  const intervalMs = opts.intervalMs ?? RECOMPUTE_INTERVAL_MS;
  let debounceTimer: NodeJS.Timeout | undefined;
  let interval: NodeJS.Timeout | undefined;
  let running: Promise<RecomputeResult | undefined> | undefined;
  let rerun = false;

  async function runOnce(): Promise<RecomputeResult | undefined> {
    try {
      return await opts.run();
    } catch (err) {
      opts.log?.(`[privacy-fields] recompute failed: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  }

  function runNow(): Promise<RecomputeResult | undefined> {
    if (running !== undefined) {
      rerun = true;
      return running;
    }
    running = (async () => {
      let result = await runOnce();
      while (rerun) {
        rerun = false;
        result = await runOnce();
      }
      return result;
    })().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    trigger(reason) {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        opts.log?.(`[privacy-fields] recompute (${reason})`);
        void runNow();
      }, debounceMs);
      debounceTimer.unref();
    },
    runNow,
    start() {
      if (interval !== undefined) return;
      interval = setInterval(() => void runNow(), intervalMs);
      interval.unref();
    },
    stop() {
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
      if (interval !== undefined) clearInterval(interval);
      debounceTimer = undefined;
      interval = undefined;
    },
  };
}
