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
 *   2a. Missing / denied access (`kein Zugriff`, `nicht erreichbar`,
 *      `access denied`, `timeout`)  →  evidence = a call in this turn that
 *      FAILED (`failedToolsCalled`). A turn whose calls all succeeded, or
 *      that made none, never saw an access fail. Without failure data the
 *      rule falls back to "≥ 1 tool call".
 *
 *   2b. Generic operation failure (`konnte nicht … finden/laden`,
 *      `fehler beim`)  →  evidence = ≥ 1 tool call in the trace: a search
 *      that ran and found nothing backs "konnte nicht finden".
 *
 *   A verdict with no call at all in the turn has basis `tool_not_called`
 *   (the attempt was omitted); one where calls ran has
 *   `unsupported_failure_claim` (no call backs the claim).
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
  /\b(kein|keine|keinen|keinerlei)\s+(?:\[[^\]]+\][-\s]?)?(?:\S+\s+){0,2}?(anhang|attachment|datei|upload|bild|logo|block|eintrag|ergebnis|treffer|buchung)\b/i,
  /\[attachments?[-_]info\][^a-z]{0,10}(fehlt|nicht|kein)/i,
  /\bno\s+(attachment|file|upload|image|results?|entries?)\b/i,
  /\bnicht\s+(angekommen|mitgekommen|übermittelt|vorhanden|gefunden|verfügbar)\b/i,
  /\b(not|never)\s+(received|attached|present|found)\b/i,
];

/**
 * Missing or denied access — "kein Zugriff auf Odoo", "keinen Zugang", "das
 * System ist nicht erreichbar", "access denied", "timeout". Only a failed
 * attempt can show this, so these need a FAILED call in the turn; a turn
 * whose calls all succeeded never saw an access fail.
 */
const ACCESS_PATTERNS: readonly RegExp[] = [
  /\b(kein|keine|keinen|keinerlei)\s+(?:\S+\s+){0,2}?(zugriff|zugang|verbindung)\b/i,
  /\bnicht\s+(erreichbar|zugänglich|verbunden)\b/i,
  /\b(no|without)\s+access\b/i,
  /\b(not|isn't|is\s+not)\s+(reachable|accessible)\b/i,
  /\b(zugriff\s+verweigert|access\s+denied|permission\s+denied|timeout|timed\s+out)\b/i,
];

/** Generic failure — "konnte nicht finden / laden". A search that ran and
 *  found nothing backs these, so any call in the turn is enough. */
const FAILURE_PATTERNS: readonly RegExp[] = [
  // "Ich konnte die Rechnungen nicht laden" — allow arbitrary object
  // between the modal and the negation, cap the distance so we don't
  // glue unrelated sentences together.
  /\b(konnte|konntest|kann|kannst)\b.{0,60}?\bnicht\b.{0,80}?\b(abrufen|laden|holen|erhalten|öffnen|zugreifen|lesen|finden)/i,
  /\b(fehler|error)\s+(beim|bei|during|while|accessing|reading|loading)\b/i,
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
  // A failed access needs a failed call. Older callers that pass no failure
  // data keep the previous, weaker rule (any call counts as an attempt).
  const failedCalls = input.failedToolsCalled;
  const anyToolFailed = failedCalls !== undefined ? failedCalls.length > 0 : anyToolCalled;
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
      // No call at all: the turn never tried (an omitted tool call). Calls
      // ran: the claim is just not backed by any of them.
      basis: anyToolCalled ? 'unsupported_failure_claim' : 'tool_not_called',
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

  // --- 2a. Missing / denied access — needs a failed call
  for (const re of ACCESS_PATTERNS) {
    const m = re.exec(answer);
    if (!m) continue;
    if (toolsCalled === undefined) continue;
    if (anyToolFailed) continue;
    push(
      m[0],
      anyToolCalled
        ? 'Antwort behauptet einen fehlenden oder verweigerten Zugriff, aber kein Tool-Call in diesem Turn ist fehlgeschlagen.'
        : 'Antwort behauptet einen fehlenden oder verweigerten Zugriff, aber der Run-Trace hat keinen einzigen Tool-Call — der Zugriff wurde in diesem Turn gar nicht versucht.',
    );
  }

  // --- 2b. Generic failure phrases — need an attempt
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
