/**
 * Field classification — auto-approval (pure).
 *
 * With the privacy guard's `auto_approve_non_personal` switch on (default),
 * the recompute writes the scoped `non_personal_fields` entry itself for a
 * field that is eligible here, instead of only suggesting it. Eligible is
 * EITHER
 *   (a) every relation target is a known non-personal model (built-in
 *       catalog) — deterministic, so no name-detector vet is needed and a
 *       field seeded from the Odoo schema (never seen in chat) qualifies; OR
 *   (b) the schema-only verdict (every unknown relation target's, or the
 *       source's when the field has no relation information) is
 *       `non-personal` with a confidence ABOVE `auto_approve_confidence`, AND
 *       the name detector vetted a non-empty sample clean.
 * The safeguards override both and are checked first:
 *   1. a relation target or the scope model is a person model, or the
 *      targets have conflicting catalog verdicts;
 *   2. an identity hit, a C1 name hit or a near-miss on the sample;
 *   3. scope `-` (the entry would clear the field in every call of the tool);
 *   4. a value shape other than text / m2o, or a field that is not exactly
 *      one scoped entry;
 *   5. ANY earlier decision on the field (an admin's confirm / reject /
 *      keep_masked / revert, an auto-revoke) — the admin's word wins, and a
 *      reverted or revoked field is never auto-approved again;
 *   6. already covered by the setting.
 * The entry written is always `configEntryOf` — model-scoped, never a
 * wildcard.
 */

import type { FieldValueShape } from '@omadia/plugin-api';
import { NO_SCOPE } from '@omadia/plugin-privacy-guard/dist/nonPersonalFields.js';

import {
  configEntryOf,
  sourceKeyOf,
  type CandidateKey,
  type ConfigCoverage,
  type ModelVerdictSummary,
  type SampleVerdictSummary,
  type StoredDecision,
} from './engine.js';
import { catalogVerdictOf, isPersonModel } from './modelCatalog.js';

/** Default of `auto_approve_confidence`. */
export const AUTO_APPROVE_DEFAULT_CONFIDENCE = 0.85;
/** The valid range of `auto_approve_confidence`; outside it the default applies. */
export const AUTO_APPROVE_MIN_CONFIDENCE = 0.5;
export const AUTO_APPROVE_MAX_CONFIDENCE = 0.99;
/** The privacy guard's setup keys. */
export const AUTO_APPROVE_ENABLED_KEY = 'auto_approve_non_personal';
export const AUTO_APPROVE_CONFIDENCE_KEY = 'auto_approve_confidence';
/** Most fields one recompute pass auto-approves. */
export const AUTO_APPROVE_MAX_PER_PASS = 1000;
/** The audit / decision actor of the recompute. */
export const AUTO_CLASSIFIER_ACTOR = 'system:auto-classifier' as const;

export interface AutoApproveSettings {
  readonly enabled: boolean;
  /** A verdict must be strictly above this. */
  readonly confidence: number;
}

export type AutoApprovalBasis = 'known_non_personal' | 'haiku';

/** Why a field is not auto-approved. The first group are the safeguards: a
 *  field auto-approved earlier that now hits one of them is revoked. */
export const AUTO_APPROVAL_SAFETY_BLOCKS = [
  'invalid_field',
  'invalid_shape',
  'no_scope',
  'person_model',
  'person_scope',
  'conflict',
  'detector_hit',
  'near_miss',
] as const;
export type AutoApprovalSafetyBlock = (typeof AUTO_APPROVAL_SAFETY_BLOCKS)[number];
export type AutoApprovalBlock =
  | AutoApprovalSafetyBlock
  | 'decided'
  | 'covered'
  | 'no_verdict'
  | 'not_non_personal'
  | 'below_threshold'
  | 'no_name_vet';

export type AutoApproval =
  | {
      readonly eligible: true;
      readonly basis: AutoApprovalBasis;
      /** The lowest verdict confidence, for basis `haiku`. */
      readonly confidence?: number;
      readonly entry: string;
    }
  | { readonly eligible: false; readonly reason: AutoApprovalBlock };

export interface AutoApprovalInput extends CandidateKey {
  readonly valueShape: FieldValueShape;
  readonly relationModels: readonly string[];
  readonly sample?: SampleVerdictSummary;
  readonly modelVerdicts?: ReadonlyMap<string, ModelVerdictSummary>;
  readonly coverage?: ConfigCoverage;
  readonly decision?: StoredDecision | null;
}

const SAFETY = new Set<string>(AUTO_APPROVAL_SAFETY_BLOCKS);

export function isSafetyBlock(reason: AutoApprovalBlock): reason is AutoApprovalSafetyBlock {
  return SAFETY.has(reason);
}

/** `auto_approve_non_personal`: a boolean, or the strings true/false (a
 *  PATCH before #1644 stored strings); anything else is the default, on. */
export function parseAutoApproveEnabled(raw: unknown): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    const text = raw.trim().toLowerCase();
    if (text === 'false' || text === 'off' || text === '0' || text === 'no') return false;
  }
  return true;
}

/** `auto_approve_confidence`: a number or a string, `0,9` reads as 0.9;
 *  outside 0.5–0.99 (or unparseable) the default 0.85. */
export function parseAutoApproveConfidence(raw: unknown): number {
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim().length > 0
        ? Number(raw.trim().replace(',', '.'))
        : Number.NaN;
  if (!Number.isFinite(n) || n < AUTO_APPROVE_MIN_CONFIDENCE || n > AUTO_APPROVE_MAX_CONFIDENCE) {
    return AUTO_APPROVE_DEFAULT_CONFIDENCE;
  }
  return n;
}

/** The settings from the privacy guard's config record. */
export function autoApproveSettingsOf(config: Readonly<Record<string, unknown>> | undefined): AutoApproveSettings {
  return {
    enabled: parseAutoApproveEnabled(config?.[AUTO_APPROVE_ENABLED_KEY]),
    confidence: parseAutoApproveConfidence(config?.[AUTO_APPROVE_CONFIDENCE_KEY]),
  };
}

function entryOf(key: CandidateKey): string | undefined {
  try {
    return configEntryOf(key);
  } catch {
    return undefined;
  }
}

/** Safeguards 1–4: the field itself, before any decision or config. */
function safetyBlockOf(input: AutoApprovalInput, targets: readonly string[]): AutoApprovalSafetyBlock | undefined {
  if (entryOf(input) === undefined) return 'invalid_field';
  if (input.valueShape !== 'text' && input.valueShape !== 'm2o') return 'invalid_shape';
  if (input.scope === NO_SCOPE) return 'no_scope';
  if (targets.some(isPersonModel)) return 'person_model';
  // A field OF a person model (hr.employee) is blocked unless it is a
  // relation whose every target is a known non-personal model: the value of
  // `hr.employee/department_id` is a department name, not a person — that is
  // the case auto-approval exists for (decision Marcel, 2026-10-31: "never a
  // person model" means never a field that points to or IS person data).
  // Text fields of a person model are personal already (engine), and any
  // detector hit still blocks below.
  if (
    isPersonModel(input.scope) &&
    !(targets.length > 0 && targets.every((t) => catalogVerdictOf(t) === 'non-personal'))
  ) {
    return 'person_scope';
  }
  if (new Set(targets.map(catalogVerdictOf)).size > 1) return 'conflict';
  const sample = input.sample;
  if (sample?.identityHit === true || sample?.c1 === 'hit') return 'detector_hit';
  if (sample?.c1 === 'near-miss') return 'near_miss';
  return undefined;
}

/** Basis (b): every verdict non-personal above the threshold, and a clean vet. */
function haikuApproval(
  input: AutoApprovalInput,
  keys: readonly string[],
  threshold: number,
): { basis: 'haiku'; confidence: number } | { reason: AutoApprovalBlock } {
  const verdicts = keys.map((k) => input.modelVerdicts?.get(k));
  if (verdicts.some((v) => v === undefined)) return { reason: 'no_verdict' };
  const known = verdicts as ModelVerdictSummary[];
  if (known.some((v) => v.verdict !== 'non-personal')) return { reason: 'not_non_personal' };
  const confidence = Math.min(...known.map((v) => v.confidence));
  if (!(confidence > threshold)) return { reason: 'below_threshold' };
  const sample = input.sample;
  if (sample === undefined || sample.sampleCount <= 0 || sample.c1 !== 'clean') {
    return { reason: 'no_name_vet' };
  }
  return { basis: 'haiku', confidence };
}

/**
 * Would the recompute auto-approve this field? Pure; ignores the on/off
 * switch (the caller checks it), so a dry run can say what it WOULD do.
 */
export function autoApprovalOf(
  input: AutoApprovalInput,
  settings: Pick<AutoApproveSettings, 'confidence'>,
): AutoApproval {
  const targets = [...new Set(input.relationModels)].sort();
  const blocked = safetyBlockOf(input, targets);
  if (blocked !== undefined) return { eligible: false, reason: blocked };
  if (input.decision !== undefined && input.decision !== null) return { eligible: false, reason: 'decided' };
  if (input.coverage?.covered === true) return { eligible: false, reason: 'covered' };
  const entry = configEntryOf(input);
  if (targets.length > 0 && targets.every((m) => catalogVerdictOf(m) === 'non-personal')) {
    return { eligible: true, basis: 'known_non_personal', entry };
  }
  const keys = targets.length > 0 ? targets : [sourceKeyOf(input)];
  const haiku = haikuApproval(input, keys, settings.confidence);
  if ('reason' in haiku) return { eligible: false, reason: haiku.reason };
  return { eligible: true, basis: 'haiku', confidence: haiku.confidence, entry };
}
