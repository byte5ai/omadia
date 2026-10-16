// Manifest text-localization audit (#1401).
//
// Convention (decided 2026-10-16): every text a manifest shows an operator is
// authored as a `{ en, de }` map. A bare string still LOADS — it is read as
// English (`normalizeLocalized`) — but it shows in the author's language in
// every UI language, so it is reported. Nothing here rejects a manifest: the
// loader turns the result into one warning per plugin, and
// `scripts/check-manifest-i18n.ts` turns it into a CI failure for the in-tree
// packages only.
//
// `identity.name` is deliberately NOT audited: plugin names are product names
// and stay language-neutral.

/** The locales every visible manifest text must carry. */
export const REQUIRED_MANIFEST_LOCALES = ['en', 'de'] as const;

export interface ManifestI18nGap {
  /** Dotted location, e.g. `setup.fields.base_url.help`. */
  readonly path: string;
  /** `bare_string`: a plain string instead of a map. `missing_locale`: a map
   *  without a non-empty entry for every required locale. */
  readonly problem: 'bare_string' | 'missing_locale';
  /** For `missing_locale`: which required locales are absent or empty. */
  readonly missing?: readonly string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function checkText(path: string, value: unknown, gaps: ManifestI18nGap[]): void {
  if (value === undefined || value === null) return;
  if (typeof value === 'string') {
    if (value.trim().length > 0) gaps.push({ path, problem: 'bare_string' });
    return;
  }
  const map = asRecord(value);
  if (!map) return;
  const missing = REQUIRED_MANIFEST_LOCALES.filter((locale) => {
    const text = map[locale];
    return typeof text !== 'string' || text.trim().length === 0;
  });
  if (missing.length > 0) gaps.push({ path, problem: 'missing_locale', missing });
}

/**
 * Every visible text of a parsed `manifest.yaml` that is not a complete
 * `{ en, de }` map. Absent texts are fine — only text that IS shown counts.
 */
export function auditManifestI18n(doc: unknown): ManifestI18nGap[] {
  const gaps: ManifestI18nGap[] = [];
  const root = asRecord(doc);
  if (!root) return gaps;

  checkText('identity.description', asRecord(root['identity'])?.['description'], gaps);

  const setup = asRecord(root['setup']);
  if (!setup) return gaps;
  checkText('setup.guide', setup['guide'], gaps);

  const fields = Array.isArray(setup['fields']) ? setup['fields'] : [];
  fields.forEach((raw, index) => {
    const field = asRecord(raw);
    if (!field) return;
    const key = typeof field['key'] === 'string' ? field['key'] : String(index);
    for (const prop of ['label', 'help', 'pattern_hint'] as const) {
      checkText(`setup.fields.${key}.${prop}`, field[prop], gaps);
    }
    const options = Array.isArray(field['enum']) ? field['enum'] : [];
    options.forEach((rawOption, optionIndex) => {
      const option = asRecord(rawOption);
      if (!option) return;
      const value =
        typeof option['value'] === 'string' ? option['value'] : String(optionIndex);
      checkText(`setup.fields.${key}.enum.${value}.label`, option['label'], gaps);
    });
  });
  return gaps;
}

/** One line for logs and CI output. */
export function describeManifestI18nGaps(gaps: readonly ManifestI18nGap[]): string {
  return gaps
    .map((g) =>
      g.problem === 'bare_string'
        ? `${g.path} (plain text)`
        : `${g.path} (missing ${(g.missing ?? []).join('+')})`,
    )
    .join(', ');
}
