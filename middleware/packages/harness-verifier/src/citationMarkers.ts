/**
 * `[ref:<id>]` citation markers (#131) — the verifier's own metadata in an
 * answer, never part of what the answer says.
 *
 * The citation check reads them (`citedRefs`, `verifierPipeline.ts`); every
 * other stage reads the answer WITHOUT them (`stripCitationMarkers`): the
 * user never sees a marker (every channel strips them), and a marker in the
 * middle of a sentence ("… byte5 GmbH [ref:odoo:res.partner:4711] in
 * Frankfurt") made a claim that quotes the sentence as the user reads it fail
 * the verbatim guard. Measured 2026-10-08 (Haiku 4.5, synthetic text, 4 runs
 * each): 8 claims kept from the checkers with mid-sentence markers, 3 without.
 *
 * Real ids carry `:` and `.` (`turn:<scope>:<ISO time>`,
 * `odoo:res.partner:42`), so a marker's id is anything up to the closing
 * bracket that is not whitespace — the same shape the channel stripper uses
 * (`harness-channel-sdk/src/citationMarkers.ts`).
 */

const CITATION_MARKER_REGEX = /\[ref:([^\]\s]+)\]/gi;
/** A marker with the one space or tab before it, as the channels strip it. */
const CITATION_MARKER_WITH_SPACE = /[ \t]?\[ref:([^\]\s]+)\]/gi;

/** The source ids the answer's `[ref:…]` markers name, in order. */
export function citedRefs(answer: string): string[] {
  return [...answer.matchAll(CITATION_MARKER_REGEX)].map((m) => m[1]!);
}

/** The text as the user reads it: every `[ref:…]` marker removed. Pure and
 *  idempotent; text without markers comes back unchanged. */
export function stripCitationMarkers(text: string): string {
  return text.replace(CITATION_MARKER_WITH_SPACE, '');
}

/** A marker's id and where it sat in the text {@link stripCitationMarkers}
 *  returns: the offset of the character that followed it. A marker before a
 *  sentence's full stop therefore lies inside that sentence, one right after
 *  the full stop at the sentence's end. */
export interface CitationAnchor {
  readonly id: string;
  readonly at: number;
}

/** Every marker of `answer`, in order, anchored in its stripped text. */
export function citationAnchors(answer: string): CitationAnchor[] {
  const anchors: CitationAnchor[] = [];
  let removed = 0;
  for (const m of answer.matchAll(CITATION_MARKER_WITH_SPACE)) {
    anchors.push({ id: m[1]!, at: m.index - removed });
    removed += m[0].length;
  }
  return anchors;
}
