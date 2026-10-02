/**
 * The user-facing notice for an answer the answer verifier withheld in
 * `enforce` mode (`answerSource: 'verifier-blocked'`).
 *
 * In `enforce` mode the verifier is a delivery gate: an answer it could not
 * confirm never reaches the user, on the stream (`VerifierService.chatStream`)
 * or on the non-streaming path (`VerifierService.chat`). What reaches the user
 * instead is this sentence, composed at the delivery boundary through the same
 * locale mechanism as the AI-Act marking and the turn-incomplete notice
 * (`turnIncomplete.ts`). Teams, Telegram, the canvas and API clients that
 * concatenate `text_delta` chunks render the answer text and nothing else, so
 * a flag alone would be invisible there.
 *
 * It states both halves: that the answer was withheld, and why — the check
 * found contradictions, it could not confirm every claim, or it could not be
 * completed — plus what the user can do. It never repeats a claim of the
 * withheld answer. Plain text, no markup.
 */

import { normalizeDisclosureLocale } from './aiDisclosure.js';
import type { VerifierResultSummary } from './chatAgent.js';

/** Why the answer was withheld, as the notice words it. */
export type VerifierBlockedCause = 'contradicted' | 'unconfirmed' | 'not_completed';

/**
 * The cause the summary supports: `contradicted` when it counts a
 * contradicted claim, `not_completed` when the verifier could not run or
 * every check that ran failed (badge `unavailable`), otherwise `unconfirmed`
 * (claims checked without confirmation, not checked, or not covered).
 */
export function verifierBlockedCause(
  summary: Pick<VerifierResultSummary, 'badge' | 'contradictionCount'>,
): VerifierBlockedCause {
  if (contradictions(summary) > 0) return 'contradicted';
  if (summary.badge === 'unavailable') return 'not_completed';
  return 'unconfirmed';
}

/** Compose the withheld-answer notice in DE (default) or EN, plain text. */
export function composeVerifierBlockedText(
  locale: string | undefined,
  summary: Pick<VerifierResultSummary, 'badge' | 'contradictionCount'>,
): string {
  const n = contradictions(summary);
  const cause = verifierBlockedCause(summary);
  if (normalizeDisclosureLocale(locale) === 'en') {
    const why =
      cause === 'contradicted'
        ? `the fact-check found ${n === 1 ? 'a contradiction' : `${String(n)} contradictions`}.`
        : cause === 'not_completed'
          ? 'the fact-check could not be completed.'
          : 'the fact-check could not confirm all of its statements.';
    return `This answer was withheld: ${why} Ask again, or check the details directly in the source system.`;
  }
  const why =
    cause === 'contradicted'
      ? `Die Faktenprüfung hat ${n === 1 ? 'einen Widerspruch' : `${String(n)} Widersprüche`} gefunden.`
      : cause === 'not_completed'
        ? 'Die Faktenprüfung konnte nicht abgeschlossen werden.'
        : 'Die Faktenprüfung konnte nicht alle Angaben bestätigen.';
  return `Diese Antwort wurde zurückgehalten: ${why} Stelle die Frage erneut oder prüfe die Angaben direkt im Quellsystem.`;
}

/** The contradiction count when it is a positive integer, else 0. */
function contradictions(summary: Pick<VerifierResultSummary, 'contradictionCount'>): number {
  const n = summary.contradictionCount;
  return Number.isInteger(n) && n > 0 ? n : 0;
}
