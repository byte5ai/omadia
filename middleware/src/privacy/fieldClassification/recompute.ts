/**
 * Field classification (#1556 follow-up) — the recompute pass and its
 * scheduler.
 *
 * One pass: drain the privacy guard's field observations (one per tool +
 * scope + field), upsert them as candidates, seed the many2one fields of
 * every model the Odoo plugin's `odoo.schema` lists (schema only, seen 0
 * times — so suggestions exist right after the integration is activated,
 * before any chat read the model), resolve what each field points
 * to — Odoo `fields_get` on the scope model only, when the scope is an Odoo
 * model and the Odoo client is there — take the shape-masked preview and
 * THEN vet the value sample (vetting drops the sample) for new/changed
 * candidates or ones without a verdict, ask the guard's small model about
 * unknown non-person relation targets and about sources without relation
 * information (ONE schema-only request per source `<tool>:<scope>`; cached
 * 30 days, re-asked when the source's field set changes), classify and
 * persist.
 *
 * Without `deps.autoApprove` it never writes the guard's config — it has no
 * writer to call. With it (wired in `index.ts`), the auto-approval step
 * (`autoApprovePass.ts`) appends the scoped entries of eligible fields
 * while the guard's `auto_approve_non_personal` switch is on, and revokes
 * auto-approvals that are no longer eligible — one config write per pass.
 * An auto-approved field is re-vetted every pass (the guard samples cleared
 * fields too; a `cleared` observation only counts for a listed field). It runs on
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

import type { AdminAuditLog } from '../../auth/adminAuditLog.js';
import { keepsStoredVet } from './autoApprove.js';
import {
  applyAutoApprovePlan,
  planAutoApprove,
  type AutoApprovePassResult,
  type AutoApproveSubject,
} from './autoApprovePass.js';
import type { NonPersonalFieldsEditor } from './configEditor.js';
import { catalogVerdictOf, isPersonModel } from './modelCatalog.js';
import {
  MODEL_NAME,
  ODOO_CLIENT_SERVICE_NAME,
  ODOO_PLUGIN_ID,
  ODOO_SCHEMA_SERVICE_NAME,
  createOdooRelationResolver,
  schemaModelsOf,
  type FieldRelationInfo,
  type OdooExecuteClient,
  type OdooRelationResolver,
  type OdooSchemaSource,
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
  /** `providedBy` (the kernel's ServiceRegistry) proves who registered a
   *  name; an Odoo service registered by any other plugin is ignored. */
  readonly serviceRegistry: {
    get<T>(name: string): T | undefined;
    providedBy(owner: string, name: string): boolean;
  };
  /** The guard's current `non_personal_fields` value. Read-only. */
  readonly readNonPersonalFields: () => string | undefined;
  /** The auto-approval step: the shared config editor (its settings say
   *  whether the switch is on) and the audit log for its rows. Absent → the
   *  pass only classifies (suggest-only). */
  readonly autoApprove?: {
    readonly editor: Pick<NonPersonalFieldsEditor, 'edit' | 'autoApproveSettings'>;
    readonly audit?: Pick<AdminAuditLog, 'record'>;
  };
  readonly now?: () => Date;
  readonly log?: (msg: string) => void;
}

export interface RecomputeResult {
  readonly computedAt: string;
  readonly candidates: number;
  readonly observations: number;
  /** The auto-approval step's counts; absent when it is not wired. */
  readonly autoApprove?: AutoApprovePassResult;
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

/** The Odoo field type whose values the guard sees as `[id, "label"]`
 *  pairs (`m2o`) — the only one seeded from the schema. one2many/many2many
 *  values are id lists, never a masked label. */
const SEEDED_FIELD_TYPE = 'many2one';

/**
 * Seed every many2one field of every model the Odoo plugin's `odoo.schema`
 * lists, once per tool that reads the model, as a candidate seen 0 times.
 * Schema only (field name, label, relation via the shared resolver); an
 * existing row is never touched. The same validation as an observation
 * applies, so a name that cannot form one scoped entry or reads as a value
 * is not seeded. Returns how many fields the schema offered.
 */
export async function seedFromOdooSchema(
  schema: OdooSchemaSource | undefined,
  resolver: OdooRelationResolver,
  store: FieldClassificationStore,
  now: Date,
  log: (msg: string) => void,
): Promise<number> {
  const at = now.toISOString();
  let offered = 0;
  for (const { model, tools } of schemaModelsOf(schema, log)) {
    if (!isModelScope(model) || !Array.isArray(tools)) continue;
    const fields = await resolver.fieldsOf(model);
    if (fields === undefined) continue;
    for (const [fieldPath, meta] of fields) {
      if (meta.type !== SEEDED_FIELD_TYPE || meta.relation === undefined) continue;
      for (const toolName of tools) {
        if (typeof toolName !== 'string') continue;
        const obs: FieldObservation = {
          toolName,
          scope: model,
          fieldPath,
          valueShape: 'm2o',
          seenCount: 0,
          firstSeenAt: at,
          lastSeenAt: at,
          ...(meta.label !== undefined ? { label: meta.label } : {}),
        };
        if (!isCandidateObservation(obs)) continue;
        offered += 1;
        await store.seedField(storableObservation(obs));
      }
    }
  }
  return offered;
}

const NO_RELATION_INFO: FieldRelationInfo = { known: false, relationModels: [], fieldDocs: [] };

interface Resolved {
  readonly candidate: FieldCandidate;
  readonly relationModels: readonly string[];
  /** The scope model's schema was read, this pass or an earlier one. */
  readonly relationInfoKnown: boolean;
  /** An auto-approval's re-vet was inconclusive; its stored vet stands. */
  readonly keptStoredVet: boolean;
  readonly fieldDocs: FieldRelationInfo['fieldDocs'];
  readonly label?: string;
  readonly fingerprint: string;
  readonly sample?: SampleVerdictSummary;
  readonly freshSample?: SampleVerdictSummary;
  readonly maskedPreview?: readonly string[];
}

function needsVetting(candidate: FieldCandidate, fingerprint: string): boolean {
  // Seeded from the schema and never seen in a tool result: the guard holds
  // no value of it, so a vet would only log an empty verdict every pass.
  if (candidate.seenCount === 0) return false;
  return (
    // Auto-approved: in clear now, so re-vetted every pass on what the guard
    // still buffers of it (it samples cleared fields too) — a name or an
    // identity among the values revokes it in this same pass.
    candidate.decision?.action === 'auto_approve' ||
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
  // Same fallback: once read, the scope's schema stays "known" while Odoo is
  // unreachable (the stored relation models are that resolution).
  const relationInfoKnown = isModelScope(candidate.scope) && (info.known || candidate.relationInfoKnown);
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
  // An inconclusive re-vet of an auto-approval (too few values, C1 down)
  // does not erase the full clean vet it was approved on; a hit always does.
  const keptStoredVet =
    freshSample !== undefined &&
    freshSample.sampleCount > 0 &&
    candidate.decision?.action === 'auto_approve' &&
    keepsStoredVet(freshSample, candidate.sampleVerdict);
  // An empty fresh vet does not erase what an earlier vet saw.
  const sample =
    freshSample !== undefined &&
    !keptStoredVet &&
    (freshSample.sampleCount > 0 || candidate.sampleVerdict === null)
      ? freshSample
      : (candidate.sampleVerdict ?? undefined);
  const label = [info.fieldLabel, candidate.label ?? undefined].find(isUsableLabel);
  return {
    candidate,
    relationModels,
    relationInfoKnown,
    keptStoredVet,
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

/** What the verdict step reads of a resolved candidate. */
type VerdictInput = Pick<Resolved, 'candidate' | 'relationModels' | 'fieldDocs' | 'label' | 'sample'>;

function vetoed(r: VerdictInput): boolean {
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
export function modelsNeedingVerdict(resolved: readonly VerdictInput[]): VerdictRequest[] {
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

/** An Odoo service, only when the Odoo integration plugin registered it:
 *  service names are first-come, so a squatter could otherwise feed the
 *  classification false relations. */
function odooService<T>(deps: RecomputeDeps, name: string, log: (msg: string) => void): T | undefined {
  const service = deps.serviceRegistry.get<T>(name);
  if (service === undefined) return undefined;
  if (!deps.serviceRegistry.providedBy(ODOO_PLUGIN_ID, name)) {
    log(`[privacy-fields] ignoring '${name}': not registered by ${ODOO_PLUGIN_ID}`);
    return undefined;
  }
  return service;
}

function observationKey(field: FieldKey): string {
  return `${field.toolName}\u0000${field.scope}\u0000${field.fieldPath}`;
}

/**
 * The drained observations to persist. A `cleared` one (an operator rule
 * let the field through in clear) only counts a sighting of a field the page
 * already lists — the guard reports it so an auto-approved field keeps being
 * re-vetted; it never creates a candidate of its own.
 */
async function observationsToStore(
  drained: readonly FieldObservation[],
  store: FieldClassificationStore,
): Promise<FieldObservation[]> {
  const candidates = drained.filter(isCandidateObservation);
  if (!candidates.some((o) => o.cleared === true)) return candidates;
  const known = new Set((await store.list()).map(observationKey));
  return candidates.filter((o) => o.cleared !== true || known.has(observationKey(o)));
}

export async function recomputeFieldClassification(deps: RecomputeDeps): Promise<RecomputeResult> {
  const clock = deps.now ?? ((): Date => new Date());
  const now = clock();
  const log = deps.log ?? (() => undefined);
  const guard = deps.serviceRegistry.get<PrivacyGuardService>(PRIVACY_REDACT_SERVICE_NAME);

  const observations = await observationsToStore(guard?.takeFieldObservations?.() ?? [], deps.store);
  for (const obs of observations) await deps.store.upsertObservation(storableObservation(obs));

  const schema = odooService<OdooSchemaSource>(deps, ODOO_SCHEMA_SERVICE_NAME, log);
  const resolver = createOdooRelationResolver(
    odooService<OdooExecuteClient>(deps, ODOO_CLIENT_SERVICE_NAME, log),
    { log, ...(schema !== undefined ? { schema } : {}) },
  );
  const schemaFields = await seedFromOdooSchema(schema, resolver, deps.store, now, log);

  // Rows that cannot form one scoped entry are never classified (or listed).
  const candidates = (await deps.store.list()).filter((c) => isValidFieldIdentity(c));
  const resolved: Resolved[] = [];
  for (const candidate of candidates) {
    resolved.push(await resolveCandidate(candidate, resolver, guard, log));
  }

  const modelVerdicts = await loadModelVerdicts(modelsNeedingVerdict(resolved), deps, guard, now);
  const rawConfig = deps.readNonPersonalFields();
  const computedAt = now.toISOString();

  const subjects: AutoApproveSubject[] = [];
  for (const r of resolved) {
    const { candidate } = r;
    const input = {
      ...fieldKeyOf(candidate),
      valueShape: candidate.valueShape,
      relationModels: r.relationModels,
      relationInfoKnown: r.relationInfoKnown,
      ...(r.sample !== undefined ? { sample: r.sample } : {}),
      modelVerdicts,
    };
    const base = classifyBase({ ...input, seenInChat: candidate.seenCount > 0 });
    subjects.push({
      candidate,
      input,
      fingerprint: r.fingerprint,
      base,
      ...(r.freshSample !== undefined ? { freshSample: r.freshSample } : {}),
    });
    const shown = resolveStatus(
      base,
      r.fingerprint,
      configCoverage(rawConfig, candidate),
      candidate.decision,
    );
    await deps.store.saveClassification(candidate.id, {
      relationModels: r.relationModels,
      relationInfoKnown: r.relationInfoKnown,
      status: shown.status,
      reasons: shown.reasons,
      fingerprint: r.fingerprint,
      ...(r.freshSample !== undefined ? { sampleVerdict: r.freshSample } : {}),
      ...(r.maskedPreview !== undefined ? { maskedPreview: r.maskedPreview } : {}),
      computedAt,
    });
  }
  log(
    `[privacy-fields] recompute: ${String(observations.length)} observation(s), ${String(schemaFields)} Odoo schema field(s), ${String(candidates.length)} candidate(s)`,
  );
  const keptVets = resolved.filter((r) => r.keptStoredVet).length;
  if (keptVets > 0) {
    // Counts only — never a field name or a value.
    log(`[privacy-fields] auto-approve: ${String(keptVets)} inconclusive re-vet(s) (too few values or C1 unavailable), stored clean vet kept`);
  }
  const autoApprove = await runAutoApprove(deps, subjects, rawConfig, clock, log);
  return {
    computedAt,
    candidates: candidates.length,
    observations: observations.length,
    ...(autoApprove !== undefined ? { autoApprove } : {}),
  };
}

/** The auto-approval step, after every candidate's classification is saved. */
async function runAutoApprove(
  deps: RecomputeDeps,
  subjects: readonly AutoApproveSubject[],
  rawConfig: string | undefined,
  now: () => Date,
  log: (msg: string) => void,
): Promise<AutoApprovePassResult | undefined> {
  if (deps.autoApprove === undefined) return undefined;
  const settings = deps.autoApprove.editor.autoApproveSettings();
  const plan = planAutoApprove(subjects, rawConfig, settings);
  const result = await applyAutoApprovePlan(plan, {
    store: deps.store,
    editor: deps.autoApprove.editor,
    ...(deps.autoApprove.audit !== undefined ? { audit: deps.autoApprove.audit } : {}),
    now,
    log,
  });
  // Counts only — never a field name list or a value.
  log(
    `[privacy-fields] auto-approve (${settings.enabled ? 'on' : 'off'}, > ${String(settings.confidence)}): ${String(result.approved)} approved, ${String(result.revoked)} revoked, ${String(result.refreshed)} refreshed, ${String(result.stale)} changed meanwhile, ${String(result.remaining)} over the cap`,
  );
  return result;
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
