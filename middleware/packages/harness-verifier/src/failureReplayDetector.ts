import type { Claim, ClaimVerdict, VerifierInput } from './claimTypes.js';

/**
 * Catches a class of orchestrator failures that the extractor+checker path
 * misses: the bot reads its own prior-failure phrases out of the FTS /
 * context block and replays them in the current turn, without actually
 * attempting the operation.
 *
 * Pattern:
 *   "Ich sehe keinen [attachments-info]-Block"  ← but the user message
 *   actually contained one, or the context-block's FTS hits are from an
 *   unrelated past turn.
 *
 * The rule: a failure / absence / please-retry assertion in the answer
 * MUST be backed by evidence in THIS turn — either a tool call in the run
 * trace, or a direct inspection of the user message. Otherwise it is a
 * replay and we flag it as contradicted.
 *
 * Three pattern families are recognised today (German + English, case-
 * insensitive):
 *
 *   1. Attachment-absence (`no attachment`, `kein Anhang`, missing
 *      `[attachments-info]` block)  →  hard-disprove against the user
 *      message: if the block literally appears there, it's a replay.
 *
 *   2. Generic operation failure (`konnte nicht …`, `fehler beim`,
 *      `not found`, `timeout`)  →  evidence = ≥ 1 tool call in the trace.
 *      Zero tool calls in this turn means the bot never tried.
 *
 *   3. Retry request (`bitte nochmal hochladen/senden/versuchen`)  →
 *      combined check: if a file actually came in (attachments-info
 *      present) OR a tool was called, the retry ask is a replay.
 *
 * Every synthesised verdict refers to a pseudo-Claim with
 * `expectedSource: 'unknown'` and the matched phrase as `text`, so the
 * aggregator / correction-prompt can still quote it back to the orchestrator.
 */

/**
 * Generic absence / failure / retry phrases. Deliberately narrow — a
 * fuzzy match here would erode user trust. Every regex is designed so
 * that an incidental false positive still has the safety valve of the
 * trace-evidence check (if a tool ran, the verdict is not issued).
 */
const ABSENCE_PATTERNS: readonly RegExp[] = [
  // "kein Anhang", "keinen [attachments-info]-Block", "keine Ergebnisse" —
  // allow optional bracketed token or short filler between the negation
  // and the noun (e.g. `keinen [attachments-info]-Block`).
  /\b(kein|keine|keinen|keinerlei)\s+(?:\[[^\]]+\][-\s]?)?(?:\S+\s+){0,2}?(anhang|attachment|datei|upload|bild|logo|block|eintrag|ergebnis|treffer|buchung|zugriff)\b/i,
  /\[attachments?[-_]info\][^a-z]{0,10}(fehlt|nicht|kein)/i,
  /\bno\s+(attachment|file|upload|image|results?|entries?)\b/i,
  /\bnicht\s+(angekommen|mitgekommen|übermittelt|vorhanden|gefunden|verfügbar)\b/i,
  /\b(not|never)\s+(received|attached|present|found)\b/i,
];

const FAILURE_PATTERNS: readonly RegExp[] = [
  // "Ich konnte die Rechnungen nicht laden" — allow arbitrary object
  // between the modal and the negation, cap the distance so we don't
  // glue unrelated sentences together.
  /\b(konnte|konntest|kann|kannst)\b.{0,60}?\bnicht\b.{0,80}?\b(abrufen|laden|holen|erhalten|öffnen|zugreifen|lesen|finden)/i,
  /\b(fehler|error)\s+(beim|bei|during|while|accessing|reading|loading)\b/i,
  /\b(zugriff\s+verweigert|access\s+denied|permission\s+denied|timeout|timed\s+out)\b/i,
  /\b(konnte|wurde)\s+nicht\s+(geladen|abgerufen|gespeichert|persistiert)\b/i,
];

const RETRY_REQUEST_PATTERNS: readonly RegExp[] = [
  /\b(bitte|könntest\s+du)\b.{0,40}?\b(nochmal|erneut|wieder)\b.{0,40}?\b(senden|schicken|hochladen|teilen|versuchen|probieren)\b/i,
  /\bplease\s+(resend|re-?upload|try\s+again|send\s+again|share\s+again)\b/i,
  /\bschick(e|t)?\s+(es|das|die\s+datei|die\s+bilder?)\s+nochmal\b/i,
];

/**
 * Heuristic check: did the user message in THIS turn carry the
 * `[attachments-info]` marker? Presence means the attachment store ran,
 * files landed, and the TeamsBot threaded the block into the user
 * message — any "no attachment" answer is a direct contradiction.
 */
function userMessageHasAttachmentsInfo(userMessage: string): boolean {
  return /\[attachments?[-_]info\]/i.test(userMessage);
}

/**
 * Run the detector. `domainToolsCalled === undefined` means the caller
 * has no trace evidence (e.g. dev CLI turn); we skip the detector in
 * that case rather than risk false positives.
 */
export function detectFailureReplay(
  input: VerifierInput,
): ClaimVerdict[] {
  const answer = input.answer;
  if (!answer) return [];
  const verdicts: ClaimVerdict[] = [];
  const seenIds = new Set<string>();
  let nextId = 1;

  const toolsCalled = input.domainToolsCalled;
  const anyToolCalled = Array.isArray(toolsCalled) && toolsCalled.length > 0;
  const hasAttachmentsInfo = userMessageHasAttachmentsInfo(input.userMessage);

  const push = (match: string, detail: string): void => {
    const id = `c_replay_${String(nextId++).padStart(3, '0')}`;
    if (seenIds.has(match)) return;
    seenIds.add(match);
    const claim: Claim = {
      id,
      text: match.slice(0, 300),
      type: 'qualitative',
      expectedSource: 'unknown',
      relatedEntities: [],
    };
    verdicts.push({
      status: 'contradicted',
      claim,
      truth: null,
      source: 'unknown',
      detail,
    });
  };

  // --- 1. Absence patterns (attachment-specific first, then generic)
  for (const re of ABSENCE_PATTERNS) {
    const m = re.exec(answer);
    if (!m) continue;
    const matched = m[0];
    const looksAttachmentRelated = /attachment|anhang|datei|upload|bild|logo/i.test(matched);

    if (looksAttachmentRelated && hasAttachmentsInfo) {
      push(
        matched,
        'Antwort behauptet "kein Anhang", aber der [attachments-info]-Block steht in der aktuellen User-Message — Replay aus Kontext-Block.',
      );
      continue;
    }
    // Non-attachment absence ("keine Buchungen", "kein Zugriff") → require
    // at least one tool call this turn as evidence of an actual attempt.
    if (!looksAttachmentRelated && toolsCalled !== undefined && !anyToolCalled) {
      push(
        matched,
        'Antwort behauptet Absenz, aber der Run-Trace zeigt 0 Tool-Calls in diesem Turn — kein aktiver Versuch.',
      );
    }
  }

  // --- 2. Generic failure phrases
  for (const re of FAILURE_PATTERNS) {
    const m = re.exec(answer);
    if (!m) continue;
    if (toolsCalled === undefined) continue;
    if (anyToolCalled) continue;
    push(
      m[0],
      'Antwort behauptet einen Operationsfehler, aber der Run-Trace hat keinen einzigen Tool-Call — die Operation wurde in diesem Turn gar nicht versucht.',
    );
  }

  // --- 3. Retry request
  for (const re of RETRY_REQUEST_PATTERNS) {
    const m = re.exec(answer);
    if (!m) continue;
    const looksAttachmentRelated = /hochladen|upload|bild|datei|logo|anhang|attachment|share|teilen/i.test(m[0]);
    if (looksAttachmentRelated && hasAttachmentsInfo) {
      push(
        m[0],
        'Antwort bittet um erneuten Upload, aber der [attachments-info]-Block zeigt: die Datei ist bereits in diesem Turn angekommen.',
      );
      continue;
    }
    if (toolsCalled !== undefined && !anyToolCalled) {
      push(
        m[0],
        'Antwort bittet den User um Wiederholung, ohne in diesem Turn selbst etwas versucht zu haben.',
      );
    }
  }

  return verdicts;
}
