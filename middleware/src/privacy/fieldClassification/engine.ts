/**
 * Field classification (#1556 follow-up) — the pure classifier.
 *
 * Decides, for one masked field of one SOURCE — a tool and the scope its rows
 * belong to (an Odoo model, an uploaded dataset's id, or `-`) — whether the
 * admin page SUGGESTS listing it in the privacy guard's `non_personal_fields`,
 * asks the admin to clarify, or marks it personal. Nothing here writes
 * config: a suggestion is only ever applied by an admin's confirm.
 *
 * Order (first match wins for the base status):
 *   1. a relation target in PERSON_MODELS              → personal
 *      no relation information and a scope model in
 *      PERSON_MODELS (`name` of res.partner)          → personal
 *   2. sample vetting: identity hit / C1 name hit      → personal
 *   3. no relation information (a text field, a source
 *      without relation metadata — datasets, MCP and
 *      plugin tools — or an unreadable Odoo schema):
 *      the schema-only verdict on the SOURCE
 *      (`<tool>:<scope>`): non-personal ≥ 0.8 →
 *      suggested, personal → personal, else (or no
 *      verdict) needs_clarification
 *   4. several targets with mixed catalog verdicts     → needs_clarification
 *   5. targets all unknown → the schema-only verdict:
 *        non-personal ≥ 0.8 → suggested, personal → personal,
 *        else needs_clarification (no verdict at all: unknown_model)
 *   6. targets all known non-personal                  → suggested
 *   A `suggested` field is only suggested on a CLEAN name-detector vet:
 *   without one (detector unavailable, nothing sampled) it needs
 *   clarification (`name_detector_unavailable`); a near-miss downgrades it
 *   too (`name_near_miss`). A field of a source that names no model (scope
 *   `-`) is never suggested either: its entry would apply to every call of
 *   the tool, whatever the call returns (`no_scope`).
 *
 * Overlays on the base status:
 *   - covered by the current `non_personal_fields` value → confirmed
 *     (`legacy_entry` when only a legacy entry — `tool:field`, `*:field`,
 *     `field`, which applies to every model of the source — covers it); the
 *     base reasons stay so the page can still say WHY it would not suggest
 *     it. It is `confirmed_conflict` instead when the base status is
 *     personal or the fingerprint changed since the admin's confirm — until
 *     the admin confirms again (acknowledges) on the current fingerprint;
 *   - an admin's reject / keep_masked holds while the candidate's fingerprint
 *     is unchanged; after a change the field is back to needs_clarification
 *     (`changed_since_decision`) — or personal, when that is what it is now.
 */

import { createHash } from 'node:crypto';

import type {
  FieldSampleC1Verdict,
  FieldValueShape,
  ModelPersonalVerdict,
} from '@omadia/plugin-api';
import {
  DATASET_SOURCE,
  NO_SCOPE,
  entryCovers,
  formatScopedEntry,
  parseNonPersonalFields,
  type FieldSource,
  type NonPersonalFieldEntry,
} from '@omadia/plugin-privacy-guard/dist/nonPersonalFields.js';

import { catalogVerdictOf, isPersonModel } from './modelCatalog.js';

export const FIELD_STATUSES = [
  'suggested',
  'needs_clarification',
  'personal',
  'confirmed',
  'confirmed_conflict',
  'rejected',
  'kept_masked',
] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

export const DECISION_ACTIONS = ['confirm', 'reject', 'keep_masked', 'revert'] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

/** Minimum schema-verdict confidence for a suggestion. */
export const HAIKU_SUGGEST_MIN_CONFIDENCE = 0.8;

/** Reason codes. Details are model / source names, counts, detector types
 *  and config entries only. */
export type FieldReason =
  | { readonly code: 'person_model'; readonly models: readonly string[] }
  | { readonly code: 'known_non_personal'; readonly models: readonly string[] }
  | { readonly code: 'haiku_non_personal'; readonly model: string; readonly confidence: number }
  | { readonly code: 'haiku_personal'; readonly model: string; readonly confidence: number }
  | { readonly code: 'haiku_uncertain'; readonly model: string; readonly confidence: number }
  | { readonly code: 'unknown_model'; readonly models: readonly string[] }
  | { readonly code: 'conflicting_targets'; readonly models: readonly string[] }
  | { readonly code: 'identity_hit'; readonly hitTypes: readonly string[] }
  | { readonly code: 'name_hit' }
  | { readonly code: 'name_near_miss' }
  | { readonly code: 'name_detector_unavailable' }
  | { readonly code: 'no_relation_info' }
  /** The source names no model (scope `-`): an entry applies to every call
   *  of the tool, so it is never suggested. */
  | { readonly code: 'no_scope' }
  | { readonly code: 'changed_since_decision' }
  | { readonly code: 'confirmed_conflict' }
  | { readonly code: 'legacy_entry'; readonly entry: string }
  | { readonly code: 'sample_clean'; readonly sampleCount: number };

/** What the privacy guard's vetting said about the field's sample. */
export interface SampleVerdictSummary {
  readonly sampleCount: number;
  readonly identityHit: boolean;
  readonly c1: FieldSampleC1Verdict;
  readonly hitTypes: readonly string[];
}

export interface ModelVerdictSummary {
  readonly verdict: ModelPersonalVerdict;
  readonly confidence: number;
}

/** An admin decision as stored. `fingerprint` is the one decided on. */
export interface StoredDecision {
  readonly action: DecisionAction;
  readonly fingerprint: string;
}

/** Is the field covered by the current setting, and how. */
export interface ConfigCoverage {
  readonly covered: boolean;
  /** True when a scoped entry for exactly this source + field exists. */
  readonly exact: boolean;
  /** The first legacy entry (as written) that covers the field, if any —
   *  `tool:field`, `*:field` or `field`; it applies to every model. */
  readonly legacyEntry?: string;
}

/** A field within one source — the candidate's identity. */
export interface CandidateKey {
  readonly toolName: string;
  /** An Odoo model, a dataset id, or `-`. */
  readonly scope: string;
  readonly fieldPath: string;
}

export interface ClassifyInput extends CandidateKey {
  readonly valueShape: FieldValueShape;
  /** Resolved relation targets; empty when non-relational or unknown. */
  readonly relationModels: readonly string[];
  readonly sample?: SampleVerdictSummary;
  /** Schema-only verdicts for unknown relation targets and for sources
   *  (`sourceKeyOf`), cached or fresh. */
  readonly modelVerdicts?: ReadonlyMap<string, ModelVerdictSummary>;
  readonly coverage?: ConfigCoverage;
  readonly decision?: StoredDecision | null;
}

export interface Classification {
  readonly status: FieldStatus;
  readonly reasons: readonly FieldReason[];
  readonly fingerprint: string;
}

/** Base statuses — what the classifier itself can say. */
export type BaseStatus = 'suggested' | 'needs_clarification' | 'personal';

/** The source a candidate's rows came from, in the grammar's terms. */
export function fieldSourceOf(key: Pick<CandidateKey, 'toolName' | 'scope'>): FieldSource {
  return { tool: key.toolName, scope: key.scope };
}

/**
 * The name a source's schema-only verdict is asked and cached under:
 * `<tool>:<scope>` (`query_dataset:<uuid>`, `some_mcp_tool:-`). Never
 * collides with an Odoo model name (those have no `:`).
 */
export function sourceKeyOf(key: Pick<CandidateKey, 'toolName' | 'scope'>): string {
  return `${key.toolName}:${key.scope}`;
}

/**
 * The candidate's identity for decisions: the scope, the sorted relation
 * models and the value shape. Never a value.
 */
export function candidateFingerprint(input: {
  readonly scope: string;
  readonly relationModels: readonly string[];
  readonly valueShape: FieldValueShape;
}): string {
  const payload = JSON.stringify({
    scope: input.scope,
    relation: [...new Set(input.relationModels)].sort(),
    shape: input.valueShape,
  });
  return createHash('sha1').update(payload).digest('hex');
}

/** Did the name detector vet a non-empty sample and find nothing? */
function isCleanVet(sample: SampleVerdictSummary | undefined): sample is SampleVerdictSummary {
  return sample !== undefined && sample.sampleCount > 0 && sample.c1 === 'clean';
}

function verdictOutcome(
  model: string,
  v: ModelVerdictSummary,
): { status: BaseStatus; reason: FieldReason } {
  if (v.verdict === 'personal') {
    return { status: 'personal', reason: { code: 'haiku_personal', model, confidence: v.confidence } };
  }
  if (v.verdict === 'non-personal' && v.confidence >= HAIKU_SUGGEST_MIN_CONFIDENCE) {
    return { status: 'suggested', reason: { code: 'haiku_non_personal', model, confidence: v.confidence } };
  }
  return {
    status: 'needs_clarification',
    reason: { code: 'haiku_uncertain', model, confidence: v.confidence },
  };
}

function haikuOutcome(
  models: readonly string[],
  verdicts: ReadonlyMap<string, ModelVerdictSummary> | undefined,
): { status: BaseStatus; reasons: FieldReason[] } {
  const missing = models.filter((m) => verdicts?.get(m) === undefined);
  if (missing.length > 0) {
    return { status: 'needs_clarification', reasons: [{ code: 'unknown_model', models: missing }] };
  }
  const outcomes = models.map((model) => verdictOutcome(model, verdicts!.get(model)!));
  const personal = outcomes.filter((o) => o.status === 'personal');
  if (personal.length > 0) return { status: 'personal', reasons: personal.map((o) => o.reason) };
  return {
    status: outcomes.every((o) => o.status === 'suggested') ? 'suggested' : 'needs_clarification',
    reasons: outcomes.map((o) => o.reason),
  };
}

/** Step 3: a field without relation information — the source's verdict. */
function sourceOutcome(
  input: ClassifyInput,
): { status: BaseStatus; reasons: FieldReason[] } {
  const key = sourceKeyOf(input);
  const verdict = input.modelVerdicts?.get(key);
  if (verdict === undefined) {
    return { status: 'needs_clarification', reasons: [{ code: 'no_relation_info' }] };
  }
  const outcome = verdictOutcome(key, verdict);
  return { status: outcome.status, reasons: [outcome.reason] };
}

/** Steps 1–6 of the order above: the status before config and decisions. */
export function classifyBase(input: ClassifyInput): {
  status: BaseStatus;
  reasons: readonly FieldReason[];
} {
  const targets = [...new Set(input.relationModels)].sort();

  const personTargets = targets.filter(isPersonModel);
  if (personTargets.length > 0) {
    return { status: 'personal', reasons: [{ code: 'person_model', models: personTargets }] };
  }
  // No relation information (a text field, or the schema could not be read):
  // a field read from a person model is about that person — `name` of
  // res.partner is the person's name.
  if (targets.length === 0 && isPersonModel(input.scope)) {
    return { status: 'personal', reasons: [{ code: 'person_model', models: [input.scope] }] };
  }

  const sample = input.sample;
  if (sample?.identityHit === true) {
    return { status: 'personal', reasons: [{ code: 'identity_hit', hitTypes: sample.hitTypes }] };
  }
  if (sample?.c1 === 'hit') {
    return { status: 'personal', reasons: [{ code: 'name_hit' }] };
  }

  let outcome: { status: BaseStatus; reasons: FieldReason[] };
  if (targets.length === 0) {
    outcome = sourceOutcome(input);
  } else {
    const verdicts = new Set(targets.map(catalogVerdictOf));
    if (verdicts.size > 1) {
      outcome = {
        status: 'needs_clarification',
        reasons: [{ code: 'conflicting_targets', models: targets }],
      };
    } else if (verdicts.has('unknown')) {
      outcome = haikuOutcome(targets, input.modelVerdicts);
    } else {
      outcome = { status: 'suggested', reasons: [{ code: 'known_non_personal', models: targets }] };
    }
  }

  return capNoScope(input.scope, capUnvetted(outcome, sample));
}

/** Never suggested without a clean name-detector vet (decision Marcel,
 *  2026-10-30): the schema can say "department", the values can still be
 *  people's names. */
function capUnvetted(
  outcome: { status: BaseStatus; reasons: FieldReason[] },
  sample: SampleVerdictSummary | undefined,
): { status: BaseStatus; reasons: FieldReason[] } {
  if (outcome.status !== 'suggested') return outcome;
  if (sample?.c1 === 'near-miss') {
    return { status: 'needs_clarification', reasons: [...outcome.reasons, { code: 'name_near_miss' }] };
  }
  if (!isCleanVet(sample)) {
    return {
      status: 'needs_clarification',
      reasons: [...outcome.reasons, { code: 'name_detector_unavailable' }],
    };
  }
  return {
    status: 'suggested',
    reasons: [...outcome.reasons, { code: 'sample_clean', sampleCount: sample.sampleCount }],
  };
}

/** A source that names no model (`-`): its entry would clear the field in
 *  EVERY call of the tool, so at most needs_clarification (`no_scope`). */
function capNoScope(
  scope: string,
  outcome: { status: BaseStatus; reasons: FieldReason[] },
): { status: BaseStatus; reasons: FieldReason[] } {
  if (scope !== NO_SCOPE || outcome.status === 'personal') return outcome;
  return { status: 'needs_clarification', reasons: [...outcome.reasons, { code: 'no_scope' }] };
}

/**
 * The status the page shows: the base status with the config coverage and
 * the admin's decision laid over it.
 */
export function resolveStatus(
  base: { readonly status: BaseStatus; readonly reasons: readonly FieldReason[] },
  fingerprint: string,
  coverage: ConfigCoverage | undefined,
  decision: StoredDecision | null | undefined,
): { status: FieldStatus; reasons: readonly FieldReason[] } {
  if (coverage?.covered === true) {
    const reasons: readonly FieldReason[] =
      coverage.legacyEntry !== undefined && !coverage.exact
        ? [...base.reasons, { code: 'legacy_entry', entry: coverage.legacyEntry }]
        : base.reasons;
    const confirm = decision?.action === 'confirm' ? decision : undefined;
    const acknowledged = confirm !== undefined && confirm.fingerprint === fingerprint;
    const drifted = confirm !== undefined && confirm.fingerprint !== fingerprint;
    if (!acknowledged && (base.status === 'personal' || drifted)) {
      return { status: 'confirmed_conflict', reasons: [{ code: 'confirmed_conflict' }, ...reasons] };
    }
    return { status: 'confirmed', reasons };
  }
  if (decision?.action === 'reject' || decision?.action === 'keep_masked') {
    if (decision.fingerprint === fingerprint) {
      return {
        status: decision.action === 'reject' ? 'rejected' : 'kept_masked',
        reasons: base.reasons,
      };
    }
    return {
      status: base.status === 'personal' ? 'personal' : 'needs_clarification',
      reasons: [{ code: 'changed_since_decision' }, ...base.reasons],
    };
  }
  return base;
}

export function classifyCandidate(input: ClassifyInput): Classification {
  const fingerprint = candidateFingerprint(input);
  const base = classifyBase(input);
  const resolved = resolveStatus(base, fingerprint, input.coverage, input.decision);
  return { ...resolved, fingerprint };
}

// ---------------------------------------------------------------------------
// The `non_personal_fields` setting: coverage, append, remove, legacy.
// ---------------------------------------------------------------------------

/** Tool names a candidate may carry. */
export const TOOL_NAME_GRAMMAR = /^[a-z0-9_.-]+$/iu;
/** Longest tool name / field path a candidate may carry. */
const MAX_NAME_LENGTH = 200;

/** A candidate whose source or field cannot be written as exactly one entry. */
export class InvalidFieldEntryError extends Error {
  constructor() {
    super('field is not a single valid non_personal_fields entry');
    this.name = 'InvalidFieldEntryError';
  }
}

/**
 * The scoped entry a confirm writes — `<tool>:<scope>/<field>`, or
 * `dataset:<id>/<column>` for an uploaded dataset (`formatScopedEntry`).
 * Throws `InvalidFieldEntryError` unless the tool follows the candidate
 * grammar AND the entry parses back to exactly that one source + field — a
 * field holding a separator, a `:` or a `/` must never add a second entry to
 * the setting.
 */
export function configEntryOf(key: CandidateKey): string {
  if (
    key.toolName === '*' ||
    // `dataset:` is the uploaded-dataset source token (`query_dataset`): a
    // tool literally named `dataset` would write an entry for uploads.
    key.toolName === DATASET_SOURCE ||
    key.toolName.length > MAX_NAME_LENGTH ||
    !TOOL_NAME_GRAMMAR.test(key.toolName)
  ) {
    throw new InvalidFieldEntryError();
  }
  const entry = formatScopedEntry(fieldSourceOf(key), key.fieldPath);
  if (entry === undefined) throw new InvalidFieldEntryError();
  return entry;
}

/** Tool, scope and field form exactly one scoped entry (`configEntryOf`). */
export function isValidFieldIdentity(key: CandidateKey): boolean {
  try {
    configEntryOf(key);
    return true;
  } catch {
    return false;
  }
}

function parseItem(text: string): NonPersonalFieldEntry | undefined {
  const parsed = parseNonPersonalFields(text);
  return parsed.entries.length === 1 && parsed.rejected.length === 0 ? parsed.entries[0] : undefined;
}

/** Every item of the setting as written, with its parse. */
function itemsOf(raw: string | undefined): { text: string; entry: NonPersonalFieldEntry | undefined }[] {
  return (raw ?? '')
    .split(/[\n;,]/u)
    .map((item) => item.trim())
    .filter((text) => text.length > 0)
    .map((text) => ({ text, entry: parseItem(text) }));
}

/** Is the candidate covered by the setting `raw`, and how. */
export function configCoverage(raw: string | undefined, key: CandidateKey): ConfigCoverage {
  const source = fieldSourceOf(key);
  let exact = false;
  let legacyEntry: string | undefined;
  for (const { text, entry } of itemsOf(raw)) {
    if (entry === undefined || !entryCovers(entry, source, key.fieldPath)) continue;
    if (entry.kind === 'scoped') exact = true;
    else legacyEntry ??= text;
  }
  return {
    covered: exact || legacyEntry !== undefined,
    exact,
    ...(legacyEntry !== undefined ? { legacyEntry } : {}),
  };
}

/** The setting with the scoped entry appended on its own line (no duplicate). */
export function appendConfigEntry(raw: string | undefined, key: CandidateKey): string {
  const entry = configEntryOf(key);
  const current = (raw ?? '').replace(/\s+$/u, '');
  if (configCoverage(current, key).exact) return current;
  return current.length === 0 ? entry : `${current}\n${entry}`;
}

/**
 * Rewrites the setting item by item: `replace` returns what stands in for an
 * item (`undefined` keeps it). Unparseable items stay as written; a line that
 * held several items keeps the rest, joined with `, `; replacements land on
 * their own lines where the line was.
 */
function rewriteItems(
  raw: string | undefined,
  replace: (text: string, entry: NonPersonalFieldEntry | undefined) => readonly string[] | undefined,
): { text: string; changed: boolean } {
  const lines: string[] = [];
  let changed = false;
  for (const line of (raw ?? '').split('\n')) {
    const items = line.split(/[;,]/u);
    const kept: string[] = [];
    const inserted: string[] = [];
    let lineChanged = false;
    for (const item of items) {
      const text = item.trim();
      const replacement = text.length > 0 ? replace(text, parseItem(text)) : undefined;
      if (replacement === undefined) {
        kept.push(item);
        continue;
      }
      lineChanged = true;
      inserted.push(...replacement);
    }
    if (!lineChanged) {
      lines.push(line);
      continue;
    }
    changed = true;
    const rest = kept.map((k) => k.trim()).filter((k) => k.length > 0);
    if (rest.length > 0) lines.push(rest.join(', '));
    lines.push(...inserted);
  }
  return { text: lines.join('\n').replace(/\s+$/u, ''), changed };
}

/**
 * The setting without the scoped entry for exactly this source + field.
 * Legacy entries and everything else stay as written.
 */
export function removeConfigEntry(raw: string | undefined, key: CandidateKey): string {
  const source = fieldSourceOf(key);
  return rewriteItems(raw, (_text, entry) =>
    entry?.kind === 'scoped' && entryCovers(entry, source, key.fieldPath) ? [] : undefined,
  ).text;
}

/** A legacy entry of the setting, as written. */
export interface LegacyConfigEntry {
  readonly entry: string;
  readonly parsed: Extract<NonPersonalFieldEntry, { kind: 'legacy' }>;
}

/** The distinct legacy entries (`tool:field`, `*:field`, `field`) of `raw`. */
export function legacyEntries(raw: string | undefined): LegacyConfigEntry[] {
  const seen = new Set<string>();
  const out: LegacyConfigEntry[] = [];
  for (const { text, entry } of itemsOf(raw)) {
    if (entry?.kind !== 'legacy' || seen.has(text)) continue;
    seen.add(text);
    out.push({ entry: text, parsed: entry });
  }
  return out;
}

/** Does the legacy entry cover the candidate? */
export function legacyEntryCovers(legacy: LegacyConfigEntry, key: CandidateKey): boolean {
  return entryCovers(legacy.parsed, fieldSourceOf(key), key.fieldPath);
}

/**
 * The setting with every occurrence of the legacy entry `entry` (as written)
 * replaced by `scopedEntries` — once, where it first stood, without entries
 * the setting already holds. `undefined` when `entry` is not a legacy entry
 * of the setting.
 */
export function replaceLegacyEntry(
  raw: string | undefined,
  entry: string,
  scopedEntries: readonly string[],
): string | undefined {
  const target = entry.trim();
  const present = new Set(itemsOf(raw).map((i) => i.text));
  const additions = [...new Set(scopedEntries)].filter((e) => !present.has(e));
  let placed = false;
  const result = rewriteItems(raw, (text, parsed) => {
    if (text !== target || parsed?.kind !== 'legacy') return undefined;
    if (placed) return [];
    placed = true;
    return additions;
  });
  return result.changed ? result.text : undefined;
}
