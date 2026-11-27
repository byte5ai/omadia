/**
 * #2341 — a replayed answer of this conversation reaches the model masked
 * (`maskPriorTurnsForWire`, `CliChatAgent.maskHistory`): persisted answers
 * hold restored real values, so they cross the wire through the turn's map.
 * The names the model itself wrote then come back as pseudonyms, and a model
 * that compares that copy with what it knows "corrects" a correct earlier
 * answer. The note tells it that a placeholder in its own earlier answer is
 * the shield's doing, not its mistake. Kernel prose, data-free: it names no
 * value and no count, so it is not masked.
 */

export const REPLAYED_ANSWER_MASKED_NOTE = [
  '# Kernel-Hinweis: frühere Antworten in diesem Gespräch',
  'In deinen früheren Antworten in diesem Gespräch sind Namen und andere Werte für dich durch Platzhalter ersetzt (Datenschutz).',
  'Der Nutzer hat diese Antworten so gesehen, wie du sie geschrieben hast, mit den echten Werten.',
  'Ein Platzhalter ist also kein Fehler deiner früheren Antwort: korrigiere frühere Antworten deswegen nicht und erwähne die Platzhalter nicht.',
].join('\n');

/** The per-turn system hint with the note appended when a replayed answer was masked. */
export function withReplayedAnswerNote(hint: string | undefined, answersMasked: boolean): string | undefined {
  if (!answersMasked) return hint;
  const existing = hint?.trim();
  return existing ? `${existing}\n\n${REPLAYED_ANSWER_MASKED_NOTE}` : REPLAYED_ANSWER_MASKED_NOTE;
}
