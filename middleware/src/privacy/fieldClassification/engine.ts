/**
 * Field classification (#1556 follow-up) — the pure classifier.
 *
 * Decides, for one masked field a tool returned, whether the admin page
 * SUGGESTS listing it in the privacy guard's `non_personal_fields`, asks the
 * admin to clarify, or marks it personal. Nothing here writes config: a
 * suggestion is only ever applied by an admin's confirm.
 *
 * Order (first match wins for the base status):
 *   1. a relation target in PERSON_MODELS              → personal
 *   2. sample vetting: identity hit / C1 name hit      → personal
 *   3. several targets with mixed catalog verdicts     → needs_clarification
 *   4. targets all unknown → the schema-only verdict:
 *        non-personal ≥ 0.8 → suggested, personal → personal,
 *        else needs_clarification (no verdict at all: unknown_model)
 *   5. no relation information (text field, Odoo
 *      client unavailable)                             → needs_clarification
 *   6. targets all known non-personal                  → suggested
 *   A C1 near-miss downgrades any `suggested` to needs_clarification.
 *
 * Overlays on the base status:
 *   - covered by the current `non_personal_fields` value → confirmed
 *     (`wildcard_entry` when only a `*:`/bare entry covers it); the base
 *     reasons stay so the page can still say WHY it would not suggest it;
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
  nonPersonalFieldRule,
  parseNonPersonalFields,
  type NonPersonalFieldEntry,
} from '@omadia/plugin-privacy-guard/dist/nonPersonalFields.js';

import { catalogVerdictOf, isPersonModel } from './modelCatalog.js';

export const FIELD_STATUSES = [
  'suggested',
  'needs_clarification',
  'personal',
  'confirmed',
  'rejected',
  'kept_masked',
] as const;
export type FieldStatus = (typeof FIELD_STATUSES)[number];

export const DECISION_ACTIONS = ['confirm', 'reject', 'keep_masked', 'revert'] as const;
export type DecisionAction = (typeof DECISION_ACTIONS)[number];

/** Minimum schema-verdict confidence for a suggestion. */
export const HAIKU_SUGGEST_MIN_CONFIDENCE = 0.8;

/** Reason codes. Details are model names, counts and detector types only. */
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
  | { readonly code: 'changed_since_decision' }
  | { readonly code: 'wildcard_entry'; readonly entry: string }
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
  /** The raw `*:`/bare entry when ONLY a wildcard covers the field. */
  readonly wildcardEntry?: string;
  /** True when an exact `tool:field` entry exists. */
  readonly exact: boolean;
}

export interface ClassifyInput {
  readonly toolName: string;
  readonly fieldPath: string;
  readonly valueShape: FieldValueShape;
  readonly sourceModels: readonly string[];
  /** Resolved relation targets; empty when non-relational or unknown. */
  readonly relationModels: readonly string[];
  readonly sample?: SampleVerdictSummary;
  /** Schema-only verdicts for unknown models (cached or fresh). */
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

/**
 * The candidate's identity for decisions: sorted source + relation models
 * and the value shape. Never a value.
 */
export function candidateFingerprint(input: {
  readonly sourceModels: readonly string[];
  readonly relationModels: readonly string[];
  readonly valueShape: FieldValueShape;
}): string {
  const payload = JSON.stringify({
    source: [...new Set(input.sourceModels)].sort(),
    relation: [...new Set(input.relationModels)].sort(),
    shape: input.valueShape,
  });
  return createHash('sha1').update(payload).digest('hex');
}

function sampleReasons(sample: SampleVerdictSummary | undefined): FieldReason[] {
  if (sample === undefined || sample.sampleCount === 0 || sample.c1 === 'unavailable') {
    return [{ code: 'name_detector_unavailable' }];
  }
  return sample.c1 === 'clean' ? [{ code: 'sample_clean', sampleCount: sample.sampleCount }] : [];
}

function haikuOutcome(
  models: readonly string[],
  verdicts: ReadonlyMap<string, ModelVerdictSummary> | undefined,
): { status: BaseStatus; reasons: FieldReason[] } {
  const missing = models.filter((m) => verdicts?.get(m) === undefined);
  if (missing.length > 0) {
    return { status: 'needs_clarification', reasons: [{ code: 'unknown_model', models: missing }] };
  }
  const reasons: FieldReason[] = [];
  let anyPersonal = false;
  let allConfident = true;
  for (const model of models) {
    const v = verdicts!.get(model)!;
    if (v.verdict === 'personal') {
      anyPersonal = true;
      reasons.push({ code: 'haiku_personal', model, confidence: v.confidence });
    } else if (v.verdict === 'non-personal' && v.confidence >= HAIKU_SUGGEST_MIN_CONFIDENCE) {
      reasons.push({ code: 'haiku_non_personal', model, confidence: v.confidence });
    } else {
      allConfident = false;
      reasons.push({ code: 'haiku_uncertain', model, confidence: v.confidence });
    }
  }
  if (anyPersonal) {
    return { status: 'personal', reasons: reasons.filter((r) => r.code === 'haiku_personal') };
  }
  return { status: allConfident ? 'suggested' : 'needs_clarification', reasons };
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

  const sample = input.sample;
  if (sample?.identityHit === true) {
    return { status: 'personal', reasons: [{ code: 'identity_hit', hitTypes: sample.hitTypes }] };
  }
  if (sample?.c1 === 'hit') {
    return { status: 'personal', reasons: [{ code: 'name_hit' }] };
  }

  let outcome: { status: BaseStatus; reasons: FieldReason[] };
  if (targets.length === 0) {
    outcome = { status: 'needs_clarification', reasons: [{ code: 'no_relation_info' }] };
  } else {
    const verdicts = new Set(targets.map(catalogVerdictOf));
    if (verdicts.size > 1) {
      outcome = {
        status: 'needs_clarification',
        reasons: [{ code: 'conflicting_targets', models: targets }],
      };
    } else if (verdicts.has('unknown')) {
      outcome = haikuOutcome(targets, input.modelVerdicts);
      if (outcome.status === 'suggested') outcome.reasons.push(...sampleReasons(sample));
    } else {
      outcome = {
        status: 'suggested',
        reasons: [{ code: 'known_non_personal', models: targets }, ...sampleReasons(sample)],
      };
    }
  }

  if (outcome.status === 'suggested' && sample?.c1 === 'near-miss') {
    return {
      status: 'needs_clarification',
      reasons: [
        ...outcome.reasons.filter((r) => r.code !== 'name_detector_unavailable'),
        { code: 'name_near_miss' },
      ],
    };
  }
  return outcome;
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
    return {
      status: 'confirmed',
      reasons:
        coverage.wildcardEntry !== undefined && !coverage.exact
          ? [...base.reasons, { code: 'wildcard_entry', entry: coverage.wildcardEntry }]
          : base.reasons,
    };
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
// The `non_personal_fields` setting: coverage, append, remove.
// ---------------------------------------------------------------------------

const ITEM_SEPARATOR = /[\n;,]/u;

/** The `tool:field` entry a confirm writes. */
export function configEntryOf(toolName: string, fieldPath: string): string {
  return `${toolName}:${fieldPath}`;
}

function parseItem(text: string): NonPersonalFieldEntry | undefined {
  return parseNonPersonalFields(text).entries[0];
}

/** Is `toolName`/`fieldPath` covered by the setting `raw`, and how. */
export function configCoverage(
  raw: string | undefined,
  toolName: string,
  fieldPath: string,
): ConfigCoverage {
  const rule = nonPersonalFieldRule(parseNonPersonalFields(raw).entries);
  if (rule === undefined || !rule([toolName], fieldPath)) return { covered: false, exact: false };
  let exact = false;
  let wildcardEntry: string | undefined;
  for (const item of (raw ?? '').split(ITEM_SEPARATOR)) {
    const text = item.trim();
    const entry = parseItem(text);
    if (entry === undefined || entry.path !== fieldPath) continue;
    if (entry.tool === toolName) exact = true;
    else if (entry.tool === '*' && wildcardEntry === undefined) wildcardEntry = text;
  }
  return {
    covered: true,
    exact,
    ...(wildcardEntry !== undefined ? { wildcardEntry } : {}),
  };
}

/** The setting with `tool:field` appended on its own line (no duplicate). */
export function appendConfigEntry(raw: string | undefined, toolName: string, fieldPath: string): string {
  const current = (raw ?? '').replace(/\s+$/u, '');
  if (configCoverage(current, toolName, fieldPath).exact) return current;
  const entry = configEntryOf(toolName, fieldPath);
  return current.length === 0 ? entry : `${current}\n${entry}`;
}

/**
 * The setting without the exact `tool:field` entry. Other entries — also
 * unparseable ones — stay as written; a line that held several entries keeps
 * the rest, joined with `, `.
 */
export function removeConfigEntry(raw: string | undefined, toolName: string, fieldPath: string): string {
  const lines: string[] = [];
  for (const line of (raw ?? '').split('\n')) {
    const items = line.split(/[;,]/u);
    const kept = items.filter((item) => {
      const entry = parseItem(item.trim());
      return !(entry !== undefined && entry.tool === toolName && entry.path === fieldPath);
    });
    if (kept.length === items.length) {
      lines.push(line);
      continue;
    }
    const rest = kept.map((k) => k.trim()).filter((k) => k.length > 0);
    if (rest.length > 0) lines.push(rest.join(', '));
  }
  return lines.join('\n').replace(/\s+$/u, '');
}
