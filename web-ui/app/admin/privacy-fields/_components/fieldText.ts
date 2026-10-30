import type { useFormatter, useTranslations } from 'next-intl';

import type { FieldClassificationReason } from '../../../_lib/api';

/** The tool an uploaded dataset is read through; its scope is the dataset id. */
export const DATASET_TOOL = 'query_dataset';
/** The scope of a source whose results name no model. */
export const NO_SCOPE = '-';

/**
 * Localized text for the field-classification page. The API sends reason
 * CODES plus schema-only detail (model names, counts, detector types); the
 * sentence around them lives in the catalog under `adminPrivacyFields`.
 */

export type FieldsT = ReturnType<typeof useTranslations>;
export type Formatter = ReturnType<typeof useFormatter>;

/** Reason codes with a catalog sentence; anything else renders `unknown`. */
const KNOWN_REASON_CODES = new Set([
  'person_model',
  'known_non_personal',
  'haiku_non_personal',
  'haiku_personal',
  'haiku_uncertain',
  'unknown_model',
  'conflicting_targets',
  'identity_hit',
  'name_hit',
  'name_near_miss',
  'name_detector_unavailable',
  'no_relation_info',
  'changed_since_decision',
  'confirmed_conflict',
  'legacy_entry',
  'sample_clean',
]);

/** A locale-aware "a, b and c"; an empty list reads as "none". */
export function modelList(models: readonly string[] | undefined, t: FieldsT, format: Formatter): string {
  const clean = (models ?? []).filter((m) => typeof m === 'string' && m.length > 0);
  return clean.length > 0 ? format.list(clean, { type: 'conjunction' }) : t('none');
}

/** "Model hr.employee" / "Dataset <id>" / "No model" for a field's scope. */
export function scopeText(
  source: { readonly toolName: string; readonly scope: string },
  t: FieldsT,
): string {
  if (source.scope === NO_SCOPE) return t('scope.none');
  if (source.toolName === DATASET_TOOL) return t('scope.dataset', { id: source.scope });
  return t('scope.model', { model: source.scope });
}

export function formatWhen(iso: string | null | undefined, format: Formatter): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return format.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' });
}

export function reasonText(
  reason: FieldClassificationReason,
  t: FieldsT,
  format: Formatter,
): string {
  const models = modelList(reason.models, t, format);
  switch (reason.code) {
    case 'person_model':
    case 'known_non_personal':
    case 'conflicting_targets':
      return t(`reasons.${reason.code}`, { models });
    case 'haiku_personal':
    case 'haiku_uncertain':
      return t(`reasons.${reason.code}`, { model: reason.model ?? models });
    case 'legacy_entry':
      return t('reasons.legacy_entry', { entry: reason.entry ?? t('none') });
    case 'haiku_non_personal': {
      const confidence =
        typeof reason.confidence === 'number' && Number.isFinite(reason.confidence)
          ? format.number(reason.confidence, { style: 'percent', maximumFractionDigits: 0 })
          : t('none');
      return t('reasons.haiku_non_personal', {
        model: reason.model ?? modelList(reason.models, t, format),
        confidence,
      });
    }
    case 'identity_hit':
      return t('reasons.identity_hit', { types: modelList(reason.hitTypes, t, format) });
    case 'sample_clean':
      return t('reasons.sample_clean', { count: reason.sampleCount ?? 0 });
    default:
      return KNOWN_REASON_CODES.has(reason.code)
        ? t(`reasons.${reason.code}`)
        : t('reasons.unknown', { code: reason.code });
  }
}
