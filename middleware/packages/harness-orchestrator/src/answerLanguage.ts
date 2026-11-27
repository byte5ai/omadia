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

/**
 * #2353 / ADR-0320 — the language an answer is written in, for the texts the
 * kernel appends to it (the AI-disclosure line). The disclosure composer knows
 * German and English, so this tells only those two apart; `undefined` when the
 * text shows neither clearly (too short, another language, only data).
 *
 * Deterministic and cheap: it counts frequent function words of each language
 * outside code, links and markup. No model call (ADR-0021).
 */
export function detectAnswerLocale(text: string | undefined): 'de' | 'en' | undefined {
  if (!text) return undefined;
  const prose = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>\n]+>/g, ' ')
    .toLowerCase();
  const words = prose.match(/[a-zäöüß]+/g) ?? [];
  let de = 0;
  let en = 0;
  for (const word of words) {
    if (GERMAN_FUNCTION_WORDS.has(word)) de += 1;
    else if (ENGLISH_FUNCTION_WORDS.has(word)) en += 1;
  }
  if (de + en < MIN_FUNCTION_WORDS) return undefined;
  if (en >= de * DOMINANCE_RATIO) return 'en';
  if (de >= en * DOMINANCE_RATIO) return 'de';
  return undefined;
}

/** Fewer function words than this is a name, a number or a table, not prose. */
const MIN_FUNCTION_WORDS = 3;
/** One language must clearly lead; a mixed text keeps the configured locale. */
const DOMINANCE_RATIO = 2;

// Words that are frequent in one language and do not occur as words in the
// other (no "in", "an", "was", "will", "so", "also", "man", "am").
const GERMAN_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer',
  'und', 'oder', 'aber', 'nicht', 'ist', 'sind', 'wird', 'werden', 'wurde', 'wurden',
  'ich', 'du', 'sie', 'wir', 'ihr', 'ihnen', 'dich', 'mich', 'mir', 'dir', 'uns',
  'mit', 'für', 'auf', 'von', 'zu', 'zum', 'zur', 'im', 'auch', 'noch', 'nur',
  'wie', 'wenn', 'dass', 'kann', 'können', 'gibt', 'hier', 'bitte', 'diese', 'dieser',
  'dieses', 'sich', 'bei', 'nach', 'aus', 'über', 'keine', 'kein', 'habe', 'haben',
]);

const ENGLISH_FUNCTION_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'and', 'or', 'but', 'not', 'is', 'are', 'were', 'be', 'been',
  'i', 'you', 'we', 'they', 'he', 'she', 'it', 'your', 'our', 'their', 'my',
  'with', 'for', 'on', 'of', 'to', 'at', 'from', 'by', 'this', 'that', 'these', 'those',
  'there', 'here', 'what', 'which', 'when', 'if', 'can', 'could', 'would', 'should',
  'have', 'has', 'had', 'do', 'does', 'did', 'please', 'about', 'any', 'no', 'yes',
]);
