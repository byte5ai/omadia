export const LOCALES = ['de', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Default locale used when no cookie is set and `Accept-Language` does
 * not match a supported locale (or auto-detect is disabled). Switched
 * to English in Slice Final to align with OSS release conventions —
 * German is now opt-in via the language switcher or a `de-*`
 * Accept-Language header.
 */
export const DEFAULT_LOCALE: Locale = 'en';

export const LOCALE_LABELS: Record<Locale, string> = {
  de: 'Deutsch',
  en: 'English',
};

export const LOCALE_COOKIE = 'NEXT_LOCALE';
