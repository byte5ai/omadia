/**
 * Field classification (#1556 follow-up) — the recompute pass and its
 * scheduler.
 *
 * One pass: drain the privacy guard's field observations (one per tool +
 * scope + field), upsert them as candidates, resolve what each field points
 * to — Odoo `fields_get` on the scope model only, when the scope is an Odoo
 * model and the Odoo client is there — take the shape-masked preview and
 * THEN vet the value sample (vetting drops the sample) for new/changed
 * candidates or ones without a verdict, ask the guard's small model about
 * unknown non-person relation targets and about sources without relation
 * information (ONE schema-only request per source `<tool>:<scope>`; cached
 * 30 days, re-asked when the source's field set changes), classify and
 * persist.
 *
 * It NEVER writes the guard's config — it has no writer to call. It runs on
 * lifecycle events (plugin activation/deactivation), every 6 hours and on
 * `POST /recompute`; never per chat turn. Debounced and single-flight.
 */

import { createHash } from 'node:crypto';

import {
  PRIVACY_REDACT_SERVICE_NAME,
  type FieldKey,
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
  sourceKeyOf,
  type ModelVerdictSummary,
  type SampleVerdictSummary,
} from './engine.js';
import { isValueLikeFieldName } from '@omadia/plugin-privacy-guard/dist/valueLikeFieldName.js';

import { catalogVerdictOf, isPersonModel } from './modelCatalog.js';
import {
  MODEL_NAME,
  ODOO_CLIENT_SERVICE_NAME,
  createOdooRelationResolver,
  type FieldRelationInfo,
  type OdooExecuteClient,
} from './odooRelationResolver.js';
import type { FieldCandidate, FieldClassificationStore, StoredModelVerdict } from './store.js';

/** Never candidates: a sub-agent's prose narration (its keys are whatever
 *  that model wrote). The guard does not observe them either. */
export const EXCLUDED_CANDIDATE_TOOLS: ReadonlySet<string> = new Set(['sub-agent']);
/** v4 verbs work on datasets the guard already observed at their source. */
export const EXCLUDED_CANDIDATE_TOOL_PREFIX = 'v4_';
export const MODEL_VERDICT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const RECOMPUTE_DEBOUNCE_MS = 5_000;
export const RECOMPUTE_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Shape-masked preview strings stored per candidate. */
export const PREVIEW_LIMIT = 5;
/** Longest field label sent to the schema model / shown on the page. */
const MAX_LABEL_LENGTH = 200;

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

/** A label is schema text: one line, bounded, no control characters. */
function isUsableLabel(label: string | undefined): label is string {
  return (
    label !== undefined &&
    label.length > 0 &&
    label.length <= MAX_LABEL_LENGTH &&
    // eslint-disable-next-line no-control-regex
    !/[\u0000-\u001f\u007f]/u.test(label)
  );
}

/**
 * Every interned tool's fields are candidates (decision Marcel, 2026-10-30)
 * except a sub-agent's narration, v4 verbs, link keys, paths that are values
 * (`isValueLikeFieldName`) and `mixed` shapes.
 * Tool names, scopes and field paths are raw tool-result data: anything that
 * cannot form exactly one scoped `non_personal_fields` entry is dropped here,
 * so the store, the audit log, log lines and — on confirm — the setting only
 * ever see validated names.
 */
export function isCandidateObservation(obs: FieldObservation): boolean {
  return (
    !EXCLUDED_CANDIDATE_TOOLS.has(obs.toolName) &&
    !obs.toolName.startsWith(EXCLUDED_CANDIDATE_TOOL_PREFIX) &&
    isValidFieldIdentity(obs) &&
    !hasLinkKeySegment(obs.fieldPath) &&
    // A key that is a value (e-mail-keyed map, a person as a CSV header):
    // the guard does not record it either — defense in depth.
    !isValueLikeFieldName(obs.fieldPath) &&
    obs.valueShape !== 'mixed'
  );
}

/** The observation as stored: an unusable label is dropped, not the field. */
function storableObservation(obs: FieldObservation): FieldObservation {
  if (obs.label === undefined || isUsableLabel(obs.label)) return obs;
  const { label: _dropped, ...rest } = obs;
  return rest;
}

/** Is the scope an Odoo model name (not `-`, not a dataset id)? */
export function isModelScope(scope: string): boolean {
  return MODEL_NAME.test(scope);
}

const NO_RELATION_INFO: FieldRelationInfo = { known: false, relationModels: [], fieldDocs: [] };

interface Resolved {
  readonly candidate: FieldCandidate;
  readonly relationModels: readonly string[];
  readonly fieldDocs: FieldRelationInfo['fieldDocs'];
  readonly label?: string;
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

export function fieldKeyOf(candidate: FieldCandidate): FieldKey {
  return { toolName: candidate.toolName, scope: candidate.scope, fieldPath: candidate.fieldPath };
}

async function resolveCandidate(
  candidate: FieldCandidate,
  resolver: ReturnType<typeof createOdooRelationResolver>,
  guard: PrivacyGuardService | undefined,
  log: (msg: string) => void,
): Promise<Resolved> {
  // Odoo resolution on the scope model only; any other source has no
  // relation metadata and goes to the source verdict.
  const info = isModelScope(candidate.scope)
    ? await resolver.resolve([candidate.scope], candidate.fieldPath)
    : NO_RELATION_INFO;
  // Odoo unreachable (or the scope model unreadable) this pass: keep what the
  // last pass resolved, so a flaky connection does not flip every decided
  // field to "changed".
  const relationModels = info.known ? info.relationModels : candidate.relationModels;
  const fingerprint = candidateFingerprint({
    scope: candidate.scope,
    relationModels,
    valueShape: candidate.valueShape,
  });
  const field = fieldKeyOf(candidate);
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
  const label = [info.fieldLabel, candidate.label ?? undefined].find(isUsableLabel);
  return {
    candidate,
    relationModels,
    fieldDocs: info.fieldDocs,
    ...(label !== undefined ? { label } : {}),
    fingerprint,
    ...(sample !== undefined ? { sample } : {}),
    ...(freshSample !== undefined && sample === freshSample ? { freshSample } : {}),
    ...(maskedPreview !== undefined ? { maskedPreview } : {}),
  };
}

/** A schema-only request, with the field-set hash of a source request. */
export interface VerdictRequest extends ModelClassificationRequest {
  /** Set for a source (`<tool>:<scope>`) request; empty for a relation target. */
  readonly fieldsHash: string;
}

/** The hash of a source's field paths: a new field re-asks the verdict. */
export function sourceFieldsHash(paths: readonly string[]): string {
  return createHash('sha1')
    .update(JSON.stringify([...new Set(paths)].sort()))
    .digest('hex');
}

function vetoed(r: Resolved): boolean {
  return r.sample?.identityHit === true || r.sample?.c1 === 'hit';
}

type RequestField = ModelClassificationRequest['fields'][number];

/** The label as sent to the schema model: dropped when it is a value. */
function requestLabel(label: string | undefined): { label: string } | Record<string, never> {
  return label !== undefined && !isValueLikeFieldName(label) ? { label } : {};
}

function addField(byKey: Map<string, RequestField[]>, key: string, field: RequestField): void {
  // Defense in depth: a path that is a value (an e-mail, a person's name)
  // never reaches the schema model.
  if (isValueLikeFieldName(field.path)) return;
  const fields = byKey.get(key) ?? [];
  if (!fields.some((f) => f.path === field.path)) fields.push(field);
  byKey.set(key, fields);
}

/**
 * What the schema model must judge, only for candidates that reach that
 * step (no person target or person scope, no detector veto):
 *   - unknown relation targets (every target unknown to the catalog);
 *   - sources without relation information — ONE request per source
 *     `<tool>:<scope>` with all its such fields (path + label).
 * Person models are never in the result, and no value ever is: a path or
 * label that is itself a value (`isValueLikeFieldName`) is left out.
 */
export function modelsNeedingVerdict(resolved: readonly Resolved[]): VerdictRequest[] {
  const byModel = new Map<string, RequestField[]>();
  const bySource = new Map<string, RequestField[]>();
  for (const r of resolved) {
    if (vetoed(r)) continue;
    const targets = r.relationModels;
    const path = r.candidate.fieldPath;
    if (targets.length === 0) {
      if (isPersonModel(r.candidate.scope)) continue;
      addField(bySource, sourceKeyOf(r.candidate), { path, ...requestLabel(r.label) });
      continue;
    }
    if (targets.some(isPersonModel)) continue;
    if (!targets.every((m) => catalogVerdictOf(m) === 'unknown')) continue;
    for (const model of targets) {
      const doc = r.fieldDocs.find((d) => d.relation === model);
      addField(byModel, model, {
        path,
        ...requestLabel(doc?.label),
        ...(doc?.help !== undefined ? { help: doc.help } : {}),
      });
    }
  }
  const models: VerdictRequest[] = [...byModel.entries()]
    .filter(([model]) => !isPersonModel(model))
    .map(([model, fields]) => ({ model, fields, fieldsHash: '' }));
  const sources: VerdictRequest[] = [...bySource.entries()].map(([model, fields]) => ({
    model,
    fields,
    fieldsHash: sourceFieldsHash(fields.map((f) => f.path)),
  }));
  return [...models, ...sources];
}

function isFirm(v: StoredModelVerdict | undefined): boolean {
  return v?.verdict === 'personal' || v?.verdict === 'non-personal';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function askSchemaModel(
  guard: PrivacyGuardService | undefined,
  missing: readonly VerdictRequest[],
  log: (msg: string) => void,
): Promise<Map<string, ModelVerdictSummary & { reason: string }>> {
  const answers = new Map<string, ModelVerdictSummary & { reason: string }>();
  if (missing.length === 0 || guard?.classifyModelsSchemaOnly === undefined) return answers;
  try {
    const results = await guard.classifyModelsSchemaOnly(
      missing.map(({ fieldsHash: _hash, ...request }) => request),
    );
    const asked = new Set(missing.map((r) => r.model));
    for (const r of results) {
      if (asked.has(r.model)) {
        answers.set(r.model, { verdict: r.verdict, confidence: r.confidence, reason: r.reason });
      }
    }
  } catch (err) {
    log(`[privacy-fields] classifyModelsSchemaOnly failed: ${errorText(err)}`);
  }
  return answers;
}

async function loadModelVerdicts(
  requests: readonly VerdictRequest[],
  deps: RecomputeDeps,
  guard: PrivacyGuardService | undefined,
  now: Date,
): Promise<Map<string, ModelVerdictSummary>> {
  const verdicts = new Map<string, ModelVerdictSummary>();
  if (requests.length === 0) return verdicts;
  const cached = new Map(
    (
      await deps.store.modelVerdicts(
        requests.map((r) => r.model),
        new Date(now.getTime() - MODEL_VERDICT_TTL_MS),
      )
    ).map((v) => [v.model, v]),
  );
  // A source verdict asked about another field set is stale: re-asked, and
  // never applied to fields it did not see.
  const stale = new Set(
    requests
      .filter((r) => cached.has(r.model) && cached.get(r.model)!.fieldsHash !== r.fieldsHash)
      .map((r) => r.model),
  );
  for (const [model, v] of cached) {
    if (!stale.has(model)) verdicts.set(model, { verdict: v.verdict, confidence: v.confidence });
  }
  // A cached `uncertain` (also what "no LLM / call failed" looks like) is
  // asked again every pass; firm verdicts hold for the TTL.
  const missing = requests.filter(
    (r) => (stale.has(r.model) || !isFirm(cached.get(r.model))) && !isPersonModel(r.model),
  );
  const answers = await askSchemaModel(guard, missing, deps.log ?? (() => undefined));
  const toSave: Omit<StoredModelVerdict, 'decidedAt'>[] = [];
  for (const r of missing) {
    const answer = answers.get(r.model);
    if (answer !== undefined) {
      verdicts.set(r.model, { verdict: answer.verdict, confidence: answer.confidence });
      toSave.push({
        model: r.model,
        verdict: answer.verdict,
        source: 'haiku',
        confidence: answer.confidence,
        reason: answer.reason.slice(0, 500),
        fieldsHash: r.fieldsHash,
      });
    } else if (stale.has(r.model)) {
      // No fresh answer for a changed source: replace the stale verdict with
      // `uncertain`, so the page (which reads the cache) does not apply it
      // to fields it never saw either.
      verdicts.set(r.model, { verdict: 'uncertain', confidence: 0 });
      toSave.push({
        model: r.model,
        verdict: 'uncertain',
        source: 'haiku',
        confidence: 0,
        reason: '',
        fieldsHash: r.fieldsHash,
      });
    }
  }
  if (toSave.length > 0) {
    // Cached as well (the page reads verdicts from the cache), but see above:
    // an `uncertain` one is re-asked next pass.
    await deps.store.saveModelVerdicts(toSave);
  }
  return verdicts;
}

export async function recomputeFieldClassification(deps: RecomputeDeps): Promise<RecomputeResult> {
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? (() => undefined);
  const guard = deps.serviceRegistry.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME);

  const observations = (guard?.takeFieldObservations?.() ?? []).filter(isCandidateObservation);
  for (const obs of observations) await deps.store.upsertObservation(storableObservation(obs));

  // Rows that cannot form one scoped entry are never classified (or listed).
  const candidates = (await deps.store.list()).filter((c) => isValidFieldIdentity(c));
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
      ...fieldKeyOf(candidate),
      valueShape: candidate.valueShape,
      relationModels: r.relationModels,
      ...(r.sample !== undefined ? { sample: r.sample } : {}),
      modelVerdicts,
    });
    const shown = resolveStatus(
      base,
      r.fingerprint,
      configCoverage(rawConfig, candidate),
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
