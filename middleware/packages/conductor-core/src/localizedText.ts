// Manifest-borne localizable text (issue #478). Split out of template.ts to keep
// that file within the repo's 500-line budget. Template metadata is data — v2
// distributes manifests outside the repo — so localization travels WITH the
// manifest and is resolved at render time.

import type { LocalizedText } from './types.js';

/**
 * Resolve manifest-borne localizable text to a display string. Plain strings pass
 * through unchanged; localized records resolve `locale` first (exact key) and fall
 * back to the required `en` base -- also for blank entries.
 */
export function resolveLocalizedText(value: LocalizedText, locale?: string): string {
  if (typeof value === 'string') return value;
  const localized = locale ? value[locale] : undefined;
  return typeof localized === 'string' && localized.trim().length > 0 ? localized : value.en;
}

/** Why `value` is not valid LocalizedText, or null when it is: a non-empty string, or
 *  a locale record whose entries are all non-empty strings with `en` present. */
export function localizedTextProblem(value: unknown): string | null {
  if (typeof value === 'string') return value.trim().length > 0 ? null : 'is empty';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'must be a non-empty string or an { en, ... } locale record';
  }
  const record = value as Record<string, unknown>;
  if (typeof record['en'] !== 'string' || record['en'].trim().length === 0) {
    return "must carry a non-empty 'en' entry (the required fallback locale)";
  }
  for (const [locale, text] of Object.entries(record)) {
    if (typeof text !== 'string' || text.trim().length === 0) {
      return `carries a non-string or empty '${locale}' entry`;
    }
  }
  return null;
}
