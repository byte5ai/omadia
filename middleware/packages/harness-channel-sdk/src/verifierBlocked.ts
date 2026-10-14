/**
 * The user-facing notice for an answer the answer verifier withheld in
 * `enforce` mode (`answerSource: 'verifier-blocked'`).
 *
 * In `enforce` mode the verifier is a delivery gate: an answer it found wrong
 * (a contradiction) or could not run on never reaches the user, on the stream
 * (`VerifierService.chatStream`) or on the non-streaming path
 * (`VerifierService.chat`); one whose claims it merely could not all confirm
 * goes out with {@link composeVerifierDisclaimerText}. A verifier that could
 * not run includes one whose every check failed. What reaches the user
 * in place of a withheld answer is this sentence, composed at the delivery
 * boundary through the same locale mechanism as the AI-Act marking and the
 * turn-incomplete notice (`turnIncomplete.ts`). Teams, Telegram, the canvas
 * and API clients that concatenate `text_delta` chunks render the answer text
 * and nothing else, so a flag alone would be invisible there.
 *
 * It states both halves: that the answer was withheld, and why — in words
 * that are TRUE for the cause, never stronger. "Contradiction" is said only
 * when a check refuted a claim against its source; a missing citation, a tool
 * the turn never called and a technical fault each say exactly that. Then
 * what the user can do. It never repeats a claim of the withheld answer, and
 * carries no technical detail (that is in the log and the verifier store).
 * Plain text, no markup.
 */

import { normalizeDisclosureLocale } from './aiDisclosure.js';
import type { VerifierResultSummary, VerifierWithheldCause } from './chatAgent.js';

/** Why the answer was withheld, as the notice words it. */
export type VerifierBlockedCause = VerifierWithheldCause;

type SummaryView = Pick<
  VerifierResultSummary,
  'badge' | 'contradictionCount' | 'withheldCause'
>;

/**
 * The cause the summary supports. A summary carries its `withheldCause`
 * (derived from the claims); one built without it falls back to its counts:
 * a counted contradiction, a verifier that could not run (badge
 * `unavailable`), or otherwise claims that stayed unconfirmed.
 */
export function verifierBlockedCause(summary: SummaryView): VerifierBlockedCause {
  if (summary.withheldCause) return summary.withheldCause;
  if (contradictions(summary) > 0) return 'contradicted';
  if (summary.badge === 'unavailable') return 'check_failed';
  return 'insufficient_evidence';
}

const EN: Readonly<Record<VerifierBlockedCause, (n: number) => string>> = {
  contradicted: (n) =>
    `the fact-check found ${n > 1 ? `${String(n)} contradictions` : 'a contradiction'} with the source data. Ask again, or check the details directly in the source system.`,
  tool_not_called: () =>
    'it stated data or an access problem without the data having been retrieved in this run. Please ask again.',
  citation_missing: () =>
    'it relied on stored knowledge without naming the sources, so it could not be checked. Please ask again.',
  insufficient_evidence: () =>
    'not all of its statements could be backed by the retrieved data. Ask again, or check the details directly in the source system.',
  check_failed: () =>
    'the fact-check could not be completed because of a technical fault. Please try again; if it keeps happening, contact support.',
  not_checked: () =>
    'it could not be passed to the fact-check. Ask again, or check the details directly in the source system.',
};

const DE: Readonly<Record<VerifierBlockedCause, (n: number) => string>> = {
  contradicted: (n) =>
    `Die Faktenprüfung hat ${n > 1 ? `${String(n)} Widersprüche` : 'einen Widerspruch'} zu den Quelldaten gefunden. Stelle die Frage erneut oder prüfe die Angaben direkt im Quellsystem.`,
  tool_not_called: () =>
    'Sie enthielt Daten oder ein Zugriffsproblem, ohne dass die Daten in diesem Durchlauf abgerufen wurden. Bitte stelle die Frage erneut.',
  citation_missing: () =>
    'Sie stützte sich auf gespeichertes Wissen, nannte dafür aber keine Quellen und ließ sich deshalb nicht prüfen. Bitte stelle die Frage erneut.',
  insufficient_evidence: () =>
    'Nicht alle Angaben ließen sich mit den abgerufenen Daten belegen. Stelle die Frage erneut oder prüfe die Angaben direkt im Quellsystem.',
  check_failed: () =>
    'Die Faktenprüfung konnte wegen einer technischen Störung nicht abgeschlossen werden. Bitte versuche es erneut; tritt das wiederholt auf, wende dich an den Support.',
  not_checked: () =>
    'Sie konnte der Faktenprüfung nicht übergeben werden. Stelle die Frage erneut oder prüfe die Angaben direkt im Quellsystem.',
};

/** Compose the withheld-answer notice in DE (default) or EN, plain text. */
export function composeVerifierBlockedText(
  locale: string | undefined,
  summary: SummaryView,
): string {
  const n = contradictions(summary);
  const cause = verifierBlockedCause(summary);
  if (normalizeDisclosureLocale(locale) === 'en') {
    return `This answer was withheld: ${EN[cause](n)}`;
  }
  return `Diese Antwort wurde zurückgehalten. ${DE[cause](n)}`;
}

/**
 * The disclaimer on a RELEASED answer whose claims the check could not all
 * confirm (`approved_with_disclaimer`, or `skipped` with claims no check
 * accepts or parts the extraction did not cover). "Confirm", never "check":
 * a claim the judge checked and found no support for was checked, and the
 * note must be true for it too. True to the counts: "some statements" only
 * when the counts are valid and show at least one confirmed claim next to an
 * unconfirmed one; otherwise "the statements" — never more confirmation than
 * the counts back. For a summary with an unconfirmed claim or none at all.
 * Plain text, one paragraph, added to the answer by the delivery gate.
 */
export function composeVerifierDisclaimerText(
  locale: string | undefined,
  summary: Pick<VerifierResultSummary, 'claimCount' | 'contradictionCount' | 'unverifiedCount'>,
): string {
  const some = someConfirmed(summary);
  if (normalizeDisclosureLocale(locale) === 'en') {
    return some
      ? 'Note: some statements in this answer could not be confirmed automatically. Check important details in the source system if needed.'
      : 'Note: the statements in this answer could not be confirmed automatically. Check important details in the source system if needed.';
  }
  return some
    ? 'Hinweis: Ein Teil der Angaben in dieser Antwort ließ sich nicht automatisch bestätigen. Prüfe wichtige Angaben bei Bedarf im Quellsystem.'
    : 'Hinweis: Die Angaben in dieser Antwort ließen sich nicht automatisch bestätigen. Prüfe wichtige Angaben bei Bedarf im Quellsystem.';
}

/** True only when every count is a valid non-negative integer and they show
 *  a confirmed claim next to an unconfirmed one; a missing or broken count
 *  never yields "some". */
function someConfirmed(
  summary: Pick<VerifierResultSummary, 'claimCount' | 'contradictionCount' | 'unverifiedCount'>,
): boolean {
  const { claimCount, contradictionCount, unverifiedCount } = summary;
  if (!isCount(claimCount) || !isCount(contradictionCount) || !isCount(unverifiedCount)) {
    return false;
  }
  return unverifiedCount > 0 && claimCount - contradictionCount - unverifiedCount > 0;
}

function isCount(n: number | undefined): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

/** The contradiction count when it is a positive integer, else 0. */
function contradictions(summary: Pick<VerifierResultSummary, 'contradictionCount'>): number {
  const n = summary.contradictionCount;
  return Number.isInteger(n) && n > 0 ? n : 0;
}
