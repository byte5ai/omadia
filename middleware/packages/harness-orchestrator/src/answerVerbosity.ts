/**
 * Answer verbosity — the operator's target SIZE for the final answer.
 *
 * ## Why this exists
 *
 * Orchestrator answers tend to narrate: the model receives every domain
 * agent's result raw (`localSubAgent` joins the text parts, the tool result
 * passes them through untouched) and re-tells them in full, so a one-number
 * question comes back as three paragraphs. Nothing in the prompt names a
 * target size, and `orchestrator_max_tokens` is floored at the default, so it
 * cannot shorten anything — a token cap would cut mid-sentence anyway.
 *
 * ## What this is
 *
 * A five-step scale, `tldr` … `max`, that the operator picks once per
 * installation (`answer_verbosity` setup field). Each step is a PROMPT
 * contract — what the answer contains and what it leaves out — not a token
 * budget. `standard` is the delivered state and emits NO block at all, so an
 * installation that never touched the field produces a byte-identical system
 * prompt (and therefore an unchanged prompt-cache key).
 *
 * ## The three layers
 *
 * Installation (`answer_verbosity`, phase 1) < Agent (`agent_identities.
 * verbosity`, phase 2, a slot that replaces the installation value) < turn
 * (`ChatTurnInput.answerVerbosity`, phase 3, the uncached per-turn hint built
 * by {@link buildAnswerVerbosityTurnBlock}). The user's own wording in a
 * message ("kurz", "alle Details") wins for that one turn as well — the block
 * says so — because the operator's default must never fight the person asking.
 *
 * The persona axis `conciseness` (agent identity) is a TONE hint relative to
 * the model family's baseline (trim filler / elaborate). It stays separate:
 * this scale fixes the SIZE and shape of the answer.
 */

import {
  ANSWER_VERBOSITY_LEVELS,
  type AnswerVerbosityLevel,
} from '@omadia/channel-sdk';

/**
 * The closed scale — ONE definition, owned by the channel SDK (the wire
 * contract channels and the orchestrator share; this package depends on it).
 * Re-exported here under the name the orchestrator-side code and the plugin
 * manifest test have used since phase 1.
 */
export { ANSWER_VERBOSITY_LEVELS };
export type AnswerVerbosity = AnswerVerbosityLevel;

/** The delivered state: no block, prompt unchanged. */
export const DEFAULT_ANSWER_VERBOSITY: AnswerVerbosity = 'standard';

/**
 * Parse the raw setup-field value. Unset, blank or unknown → `undefined`, so
 * the caller falls back to {@link DEFAULT_ANSWER_VERBOSITY} and a typo in a
 * config never silently picks a level.
 */
export function parseAnswerVerbosity(raw: unknown): AnswerVerbosity | undefined {
  if (typeof raw !== 'string') return undefined;
  const v = raw.trim().toLowerCase();
  return (ANSWER_VERBOSITY_LEVELS as readonly string[]).includes(v)
    ? (v as AnswerVerbosity)
    : undefined;
}

/** Operator-facing label, used in the block's heading so a reader of the
 *  prompt sees which setting produced it. */
const LEVEL_LABEL: Record<Exclude<AnswerVerbosity, 'standard'>, string> = {
  tldr: 'TL;DR',
  brief: 'Kurz',
  detailed: 'Ausführlich',
  max: 'Maximal',
};

/**
 * The contract per level — what the answer text contains. Data tables are
 * rendered server-side from `v4_render_answer` (capped at 50 rows by the
 * privacy guard), so the short levels tell the model to trim the DATASET
 * (`v4_top_n`, fewer columns) rather than the prose around it; the prose
 * rule alone would leave a 50-row table under a one-sentence answer.
 */
const LEVEL_CONTRACT: Record<Exclude<AnswerVerbosity, 'standard'>, string> = {
  tldr: `- **1 bis 3 Sätze.** Nur das Ergebnis und, wenn nötig, die eine entscheidende Zahl.
- Keine Einleitung, keine Aufzählung, keine Herleitung, kein Vorgehen, kein Schlusssatz, kein Angebot für mehr.
- Datentabellen nur, wenn der User ausdrücklich eine Liste will — dann vorher per \`v4_top_n\` auf höchstens 5 Zeilen und auf die nötigsten Spalten kürzen und den Rest als Anzahl nennen.`,
  brief: `- **Ergebnis zuerst**, dann höchstens 5 Stichpunkte mit den wichtigsten Zahlen und Fakten.
- Keine Einleitung, keine Wiederholung der Frage, keine Erklärung des Vorgehens.
- Datentabellen auf die angefragten Spalten beschränken; Rankings per \`v4_top_n\` auf höchstens 10 Zeilen, den Rest als Anzahl nennen.`,
  detailed: `- Ergebnis **mit Begründung**: woher die Zahlen stammen (welcher Fach-Agent, welcher Zeitraum, welche Filter), welche Annahmen und Einschränkungen gelten.
- Abschnitte, Aufzählungen und vollständige Tabellen sind erwünscht.
- Nenne Unsicherheiten und sinnvolle nächste Schritte.`,
  max: `- **Vollständig**: Ergebnis, Herleitung, jeden Zwischenschritt (welches Werkzeug mit welchen Parametern), alle relevanten Rohwerte, Annahmen, Unsicherheiten und offene Punkte.
- Lass nichts weg, was ein Prüfer bräuchte, um die Antwort nachzuvollziehen.
- Tabellen vollständig bis zur Zeilengrenze; ist das Ergebnis größer, biete den Export an.`,
};

/**
 * The per-TURN variant (phase 3): the user picked a level on a channel
 * affordance ("Kürzer" / "Mehr Details") for a re-run of one question. Goes
 * into the uncached per-turn system hint — like Fresh Check — so the stable
 * prompt and its cache key are untouched, and says explicitly that it
 * replaces the configured "Antwortumfang" section for this turn. Unlike
 * {@link buildAnswerVerbosityBlock} it is never empty: a turn pick of
 * `standard` over an Agent configured to `tldr` must still say "normal size".
 */
export function buildAnswerVerbosityTurnBlock(level: AnswerVerbosity): string {
  const contract =
    level === 'standard'
      ? `- Normaler Umfang: Ergebnis mit kurzer Einordnung, wie ohne jede Vorgabe.
- Keine künstliche Kürzung und keine künstliche Ausführlichkeit.`
      : LEVEL_CONTRACT[level];
  const label = level === 'standard' ? 'Standard' : LEVEL_LABEL[level];
  return `# ANTWORTUMFANG FÜR DIESEN TURN (vom User per Card-Button auf «${label}» gestellt)

Für diesen EINEN Turn ersetzt diese Vorgabe den Abschnitt »Antwortumfang« im stabilen System-Prompt (falls vorhanden). Der User hat gerade dieselbe Frage noch einmal gestellt, weil ihm die vorige Antwort zu lang oder zu kurz war — liefere jetzt genau diesen Umfang:
${contract}
- Ergebnisse von Fach-Agenten sind Rohmaterial: verdichte sie auf diesen Umfang, gib sie nicht wörtlich oder nacherzählt weiter.`;
}

/**
 * The system-prompt block for a level. Empty string for `standard` so the
 * caller can splice it unconditionally and still get the unchanged prompt.
 */
export function buildAnswerVerbosityBlock(level: AnswerVerbosity): string {
  if (level === 'standard') return '';
  const label = LEVEL_LABEL[level];
  return `Antwortumfang (vom Betreiber auf «${label}» gestellt):
${LEVEL_CONTRACT[level]}
- Ergebnisse von Fach-Agenten sind Rohmaterial: verdichte sie auf diesen Umfang, gib sie nicht wörtlich oder nacherzählt weiter.
- Bittet der User in seiner Nachricht ausdrücklich um mehr oder weniger Umfang («kurz», «nur die Zahl», «ausführlich», «alle Details»), gewinnt seine Bitte für diesen Turn.
`;
}
