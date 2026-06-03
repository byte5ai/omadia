import type { LocalizedMarkdown } from './storeTypes';

/**
 * Pick the best string from a `{ <locale>: text }` map for the given active
 * locale. Falls back to English, then German, then any remaining locale, so a
 * guide that ships only one language still renders. Returns undefined when the
 * map is empty or absent.
 */
export function pickLocalized(
  map: LocalizedMarkdown | undefined,
  locale: string,
): string | undefined {
  if (!map) return undefined;
  const direct = map[locale];
  if (direct && direct.trim().length > 0) return direct;
  for (const fallback of ['en', 'de']) {
    const v = map[fallback];
    if (v && v.trim().length > 0) return v;
  }
  for (const v of Object.values(map)) {
    if (v && v.trim().length > 0) return v;
  }
  return undefined;
}
