// Manifest-borne localizable setup text (OM-17 / #602).
//
// The manifest's setup-field family — `setup.guide`, `pattern_hint`, and now
// `label` / `help` — is authored as a `{ <locale>: text }` map (a bare string is
// tolerated and read as English). The catalog projection (`manifestLoader`) and
// the install-schema projection (`installService`) both normalise with the SAME
// function here so the store view and the install wizard can never disagree on
// what a field says — the shared-fixture test guards that agreement.
//
// This is deliberately the map convention `pickLocalized` (web-ui) already
// resolves, NOT conductor-core's `LocalizedText` (which requires an `en` base and
// resolves differently). Setup text follows the setup-text precedent.

import type { LocalizedMarkdown } from '../api/admin-v1.js';

/**
 * Normalise a manifest value into a `{ <locale>: text }` map. Accepts the
 * canonical object form (`{ en: "…", de: "…" }`) and tolerates a bare string
 * (treated as English). Empty strings and non-string values are dropped;
 * returns undefined when nothing usable remains.
 */
export function normalizeLocalized(
  value: unknown,
): LocalizedMarkdown | undefined {
  if (typeof value === 'string') {
    return value.trim().length > 0 ? { en: value } : undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const out: LocalizedMarkdown = {};
  for (const [locale, text] of Object.entries(value as Record<string, unknown>)) {
    if (typeof text === 'string' && text.trim().length > 0) out[locale] = text;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Resolve a localized map to a single display string for a server path that has
 * NO request locale (validation-error templates, orchestrator prompt headers).
 * Tries `preferred` first, then the same `en → de → any` fallback the web-ui's
 * `pickLocalized` uses, so the two sides pick the same string when they can.
 * Returns undefined when the map is empty or absent.
 *
 * Callers pass the locale their surrounding TEXT is written in — the install
 * validator's error strings are German, so it passes `'de'` and a German label
 * lands in a German sentence.
 */
export function resolveLocalized(
  map: LocalizedMarkdown | undefined,
  preferred?: string,
): string | undefined {
  if (!map) return undefined;
  for (const key of [preferred, 'en', 'de']) {
    if (!key) continue;
    const v = map[key];
    if (v && v.trim().length > 0) return v;
  }
  for (const v of Object.values(map)) {
    if (v && v.trim().length > 0) return v;
  }
  return undefined;
}
