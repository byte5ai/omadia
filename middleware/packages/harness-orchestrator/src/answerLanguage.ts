/**
 * #1992 / ADR-0220 — the answer language follows the user.
 *
 * The agent answers in the language of the user's latest message. Only when
 * that message does not show a language (a name, a number, a link, an emoji)
 * does it use the operator's fallback, the `answer_language` setup field
 * (default German, the shipped behaviour). A channel's `ChatTurnInput.locale`
 * stays a hint for kernel notices and never overrides what the user wrote.
 *
 * The rule is fixed text per fallback, so the system prompt stays stable per
 * installation (one prompt-cache key, as before).
 */

export const ANSWER_LANGUAGES = ['de', 'en', 'fr', 'es', 'it', 'nl', 'pl'] as const;
export type AnswerLanguage = (typeof ANSWER_LANGUAGES)[number];

export const DEFAULT_ANSWER_LANGUAGE: AnswerLanguage = 'de';

/** Language names as the (German) system prompt writes them. */
const LANGUAGE_NAME_DE: Readonly<Record<AnswerLanguage, string>> = {
  de: 'Deutsch',
  en: 'Englisch',
  fr: 'Französisch',
  es: 'Spanisch',
  it: 'Italienisch',
  nl: 'Niederländisch',
  pl: 'Polnisch',
};

/** The setup value, case-insensitive; unset or unknown → `undefined` (default). */
export function parseAnswerLanguage(raw: unknown): AnswerLanguage | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  return (ANSWER_LANGUAGES as readonly string[]).includes(value)
    ? (value as AnswerLanguage)
    : undefined;
}

/** The system-prompt line that states the rule. */
export function buildAnswerLanguageRule(
  fallback: AnswerLanguage = DEFAULT_ANSWER_LANGUAGE,
): string {
  return (
    'Sprache: Antworte in der Sprache, in der der Nutzer seine letzte Nachricht geschrieben hat. ' +
    'Lässt sie keine Sprache erkennen (nur ein Name, eine Zahl, ein Link oder ein Emoji), antworte in der Sprache des bisherigen Gesprächs, ' +
    `ohne Gespräch auf ${LANGUAGE_NAME_DE[fallback]}. ` +
    'Die Sprache von Tool-Ergebnissen, Dokumenten und dieser Anweisung bestimmt die Antwortsprache nicht.'
  );
}
