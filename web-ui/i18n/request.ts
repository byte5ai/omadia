import { cookies, headers } from 'next/headers';
import { getRequestConfig } from 'next-intl/server';

import { DEFAULT_LOCALE, LOCALE_COOKIE, LOCALES, type Locale } from './locales';

/**
 * Per-request locale resolution for next-intl. Three sources, in order:
 *
 *   1. NEXT_LOCALE cookie (set by the in-app LocaleSwitcher) — wins
 *      over everything because it represents an explicit user choice.
 *
 *   2. Accept-Language header — auto-detect the visitor's browser
 *      preference. Honours q-values per RFC 7231 §5.3.1, picks the
 *      highest-priority supported locale. Disabled by setting
 *      `WEB_AUTO_DETECT_LOCALE=false` in the environment (useful for
 *      reproducible test runs, demos, or single-language deployments).
 *
 *   3. DEFAULT_LOCALE — final fallback. Currently 'en'.
 */

interface RankedTag {
  readonly tag: string;
  readonly q: number;
}

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}

function autoDetectEnabled(): boolean {
  // Treat any value other than 'false', '0', or 'no' as enabled. Default: on.
  const raw = process.env.WEB_AUTO_DETECT_LOCALE?.toLowerCase().trim();
  if (raw === undefined || raw === '') return true;
  return raw !== 'false' && raw !== '0' && raw !== 'no';
}

/**
 * Parse an Accept-Language header into a quality-sorted list of tags.
 * Malformed entries are skipped. Missing q defaults to 1.0 per spec.
 *
 *   "de-DE,de;q=0.9,en;q=0.8" -> [{de-de,1}, {de,0.9}, {en,0.8}]
 */
export function parseAcceptLanguage(header: string | null): RankedTag[] {
  if (!header) return [];
  const out: RankedTag[] = [];
  for (const part of header.split(',')) {
    const segment = part.trim();
    if (!segment) continue;
    const [tag, ...params] = segment.split(';');
    if (!tag) continue;
    const cleanTag = tag.trim().toLowerCase();
    if (!cleanTag || cleanTag === '*') continue;
    let q = 1.0;
    for (const param of params) {
      const [key, value] = param.split('=').map((s) => s.trim());
      if (key === 'q' && value !== undefined) {
        const parsed = Number(value);
        if (Number.isFinite(parsed) && parsed >= 0) q = parsed;
      }
    }
    if (q > 0) out.push({ tag: cleanTag, q });
  }
  // Stable sort: highest q first, preserving original order on ties.
  return out
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => b.entry.q - a.entry.q || a.i - b.i)
    .map(({ entry }) => entry);
}

export function pickLocaleFromAcceptLanguage(header: string | null): Locale | null {
  for (const { tag } of parseAcceptLanguage(header)) {
    // Try exact match first ('en' on its own), then primary subtag ('en' from 'en-GB').
    if (isLocale(tag)) return tag;
    const primary = tag.split('-')[0];
    if (isLocale(primary)) return primary;
  }
  return null;
}

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get(LOCALE_COOKIE)?.value;
  if (isLocale(cookieLocale)) {
    return loadConfig(cookieLocale);
  }

  if (autoDetectEnabled()) {
    const headerStore = await headers();
    const headerLocale = pickLocaleFromAcceptLanguage(
      headerStore.get('accept-language'),
    );
    if (headerLocale) {
      return loadConfig(headerLocale);
    }
  }

  return loadConfig(DEFAULT_LOCALE);
});

async function loadConfig(locale: Locale) {
  const messages = (await import(`../messages/${locale}.json`)).default;
  return { locale, messages };
}
