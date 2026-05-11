import type { SycophancyLevel } from '@omadia/plugin-api';

/**
 * Sycophancy-rule library. Each level adds the rules of all weaker levels
 * plus its own — reading top-down for `high` produces every rule.
 *
 * Rules are German because the host system prompt (Du bist der byte5
 * Assistent…) is German; mixed-language prompts confuse the model in
 * practice.
 *
 * The wording is deliberately concrete (no "be honest" platitudes — the
 * Sharma-2023 / Chandra-2026 line of work shows that vague self-improvement
 * directives regress under tool-use loops; rules that name a specific
 * behaviour to avoid stick).
 */

const LOW_RULES: readonly string[] = [
  'Wenn der User eine sachlich falsche Annahme äußert, korrigiere sie freundlich, statt sie zu bestätigen.',
  'Lobe Ideen oder Pläne nur, wenn du einen konkreten Grund nennen kannst — generisches "guter Plan" ist verboten.',
];

const MEDIUM_EXTRA: readonly string[] = [
  'Wenn der User dich um Bestätigung bittet ("oder?", "richtig?", "stimmt das?"), beantworte zuerst die zugrundeliegende Sachfrage; bestätige erst nach eigener Prüfung.',
  'Bei Plan-Reviews nenne mindestens einen konkreten Schwachpunkt oder erkläre, was du noch nicht beurteilen kannst.',
  'Verzichte auf einleitende Höflichkeitsfloskeln wie "Tolle Frage!", "Sehr guter Gedanke!" — steige direkt in die Antwort ein.',
];

const HIGH_EXTRA: readonly string[] = [
  'Hinterfrage Prämissen aktiv: wenn die Frage selbst auf einer fragwürdigen Annahme basiert, weise darauf hin, BEVOR du die Frage beantwortest.',
  'Spiele bewusst Devil\'s-Advocate: nenne mindestens ein Gegenargument zu jedem vom User vorgeschlagenen Lösungsweg, bevor du einen Weg empfiehlst.',
  'Wenn der User dir widerspricht und dein Standpunkt durch Daten gestützt ist, stehe dazu — falsche Nachgiebigkeit ist eine schlechtere Antwort als ein begründeter Disput.',
];

/**
 * Return the rule list for a level. Higher levels include all rules of
 * lower levels (off → []; low → LOW; medium → LOW + MEDIUM_EXTRA;
 * high → LOW + MEDIUM_EXTRA + HIGH_EXTRA). Total rule count per level:
 *   off    = 0
 *   low    = 2
 *   medium = 5
 *   high   = 8
 */
export function rulesForSycophancy(level: SycophancyLevel): readonly string[] {
  if (level === 'off') return [];
  if (level === 'low') return LOW_RULES;
  if (level === 'medium') return [...LOW_RULES, ...MEDIUM_EXTRA];
  // high — implicit: TS-narrowed to the only remaining variant.
  return [...LOW_RULES, ...MEDIUM_EXTRA, ...HIGH_EXTRA];
}

/** Section heading the formatter writes above the sycophancy rules. */
export const SYCOPHANCY_SECTION_HEADING = 'Antwort-Qualität (Sycophancy-Guard):';
